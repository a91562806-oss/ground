import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendWebPush } from "@/lib/webPushServer";
import { isAlphaServerEnv } from "@/lib/appEnv";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  isTopicEnabled,
  matchesCurrentPushEnv,
  type AlertKind,
  type TopicKey,
} from "@/lib/notifications/topics";

/**
 * 공통 알림 서비스.
 * 모든 cron / 라우트는 직접 `sendWebPush` 를 호출하지 말고 이 서비스를 거쳐야 한다.
 *
 * 책임:
 *   1) cron 인증 (`authorizeCron`)
 *   2) `NotificationDispatchState` 락을 통한 exactly-once 발송 보장 (`markDispatchOnce`)
 *   3) 구독자 조회 + 토픽/환경 필터링 + 푸시 발송 + 비활성화 + 인박스 기록
 *      을 한 번에 처리 (`sendTeamTopicNotification`)
 *   4) alpha 환경 안전장치 — 명시적으로 허용하기 전까지 실 발송 차단.
 */

export type CronAuthResult = { ok: true } | { ok: false; status: number; error: string };

export type { AlertKind, TopicKey };

type ActiveSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
  userId: string;
  topics: unknown;
  updatedAt: Date;
  user: { favoriteTeam: string | null };
};

export function authorizeCron(req: Request, url: URL): CronAuthResult {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: true };
  const auth = req.headers.get("authorization");
  const querySecret = url.searchParams.get("secret");
  if (auth === `Bearer ${secret}` || querySecret === secret) return { ok: true };
  return { ok: false, status: 401, error: "unauthorized" };
}

export function toKstDateTime(date: string, time: string): Date | null {
  const normalized = time && time.includes(":") ? `${time}:00` : "18:30:00";
  const ms = Date.parse(`${date}T${normalized}+09:00`);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function minutesUntil(dateTime: Date, now = new Date()): number {
  return Math.floor((dateTime.getTime() - now.getTime()) / 60000);
}

/** 한 유저당 최신 endpoint 만 남긴다 (구버전 endpoint 중복 push 방지). */
function uniqueLatestSubByUser(subs: ActiveSubscription[]): ActiveSubscription[] {
  const map = new Map<string, ActiveSubscription>();
  for (const sub of subs) {
    const prev = map.get(sub.userId);
    if (!prev || sub.updatedAt.getTime() > prev.updatedAt.getTime()) {
      map.set(sub.userId, sub);
    }
  }
  return [...map.values()];
}

/**
 * `NotificationDispatchState` 로 (alertKind, teamScope, eventKey) 락 1개를 잡는다.
 * 동시에 두 cron이 같은 알림을 발송하려 해도 한쪽만 통과.
 */
export async function markDispatchOnce(input: {
  alertKind: AlertKind;
  teamScope: string;
  eventKey: string;
  gameExternalId?: string | null;
  payload?: Prisma.InputJsonValue;
}): Promise<boolean> {
  try {
    await prisma.notificationDispatchState.create({
      data: {
        alertKind: input.alertKind,
        teamScope: input.teamScope,
        eventKey: input.eventKey,
        gameExternalId: input.gameExternalId ?? null,
        payload: input.payload,
      },
    });
    return true;
  } catch (error) {
    const prismaError = error as Prisma.PrismaClientKnownRequestError;
    if (prismaError?.code === "P2002") return false;
    throw error;
  }
}

const PUSH_FAIL_DISABLE_STATUSES = new Set([401, 403, 404, 410]);

/**
 * 실제 FCM 발송 로직 (alpha guard 없음 — 호출 전에 guard 해야 함).
 * sendTeamTopicNotification 과 deliverQueuedNotification 두 곳에서 공유.
 */
async function _doDeliverPush(input: {
  teamId: string;
  topicKey: TopicKey;
  title: string;
  body: string;
  url: string;
  payload: Prisma.InputJsonValue;
  type: "GAME_START" | "GAME_RESULT" | "SCORE_UPDATE" | "SYSTEM";
  origin: string;
}): Promise<{ sent: number; disabled: number; inboxCreated: number }> {
  const rawSubs = await prisma.pushSubscription.findMany({
    where: {
      enabled: true,
      user: { favoriteTeam: input.teamId },
    },
    select: {
      endpoint: true,
      p256dh: true,
      auth: true,
      userId: true,
      topics: true,
      updatedAt: true,
      user: { select: { favoriteTeam: true } },
    },
  });
  const subs = uniqueLatestSubByUser(rawSubs as ActiveSubscription[]).filter(
    (sub) => matchesCurrentPushEnv(sub.topics) && isTopicEnabled(sub.topics, input.topicKey)
  );
  if (subs.length === 0) return { sent: 0, disabled: 0, inboxCreated: 0 };

  const pushResults = await mapWithConcurrency(subs, 12, async (sub) => {
    const push = await sendWebPush(
      { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      {
        title: input.title,
        body: input.body,
        url: input.url,
        teamId: input.teamId,
      },
      { favoriteTeam: input.teamId, origin: input.origin }
    );
    return { sub, push };
  });

  const disableTargets = pushResults
    .filter((row) => row.push.statusCode && PUSH_FAIL_DISABLE_STATUSES.has(row.push.statusCode))
    .map((row) => row.sub);

  let disabled = 0;
  if (disableTargets.length > 0) {
    const rows = await mapWithConcurrency(disableTargets, 8, (sub) =>
      prisma.pushSubscription.updateMany({
        where: { userId: sub.userId, endpoint: sub.endpoint, enabled: true },
        data: { enabled: false },
      })
    );
    disabled = rows.reduce((acc, row) => acc + row.count, 0);
  }

  const sentRows = pushResults.filter((row) => row.push.ok);
  let inboxCreated = 0;
  if (sentRows.length > 0) {
    const created = await prisma.notification.createMany({
      data: sentRows.map((row) => ({
        userId: row.sub.userId,
        title: input.title,
        body: input.body,
        deeplinkUrl: input.url,
        sentAt: new Date(),
        type: input.type,
        payload: input.payload,
      })),
    });
    inboxCreated = created.count;
  }

  return { sent: sentRows.length, disabled, inboxCreated };
}

/**
 * 크론/이벤트 감지 코드가 호출하는 공개 API.
 *
 * AUTO_CONFIRM_PUSH=true  → 즉시 FCM 발송 (기존 동작)
 * AUTO_CONFIRM_PUSH=false → DB에 PENDING 저장 후 어드민 승인 대기
 *
 * alpha 환경 안전장치는 항상 적용: ALPHA_ALLOW_REAL_PUSH=1 이 아니면 실 발송 차단.
 */
export async function sendTeamTopicNotification(input: {
  teamId: string;
  topicKey: TopicKey;
  title: string;
  body: string;
  url: string;
  payload: Prisma.InputJsonValue;
  type: "GAME_START" | "GAME_RESULT" | "SCORE_UPDATE" | "SYSTEM";
  origin: string;
}): Promise<{ sent: number; disabled: number; inboxCreated: number; queued?: number }> {
  // alpha 안전장치
  if (isAlphaServerEnv() && process.env.ALPHA_ALLOW_REAL_PUSH !== "1") {
    return { sent: 0, disabled: 0, inboxCreated: 0 };
  }

  // AUTO_CONFIRM_PUSH=true 이면 즉시 발송, false(또는 미설정)면 PENDING 저장
  const autoConfirm = process.env.AUTO_CONFIRM_PUSH === "true";

  if (!autoConfirm) {
    await prisma.pendingPushNotification.create({
      data: {
        teamId: input.teamId,
        topicKey: input.topicKey,
        title: input.title,
        body: input.body,
        url: input.url,
        type: input.type,
        payload: input.payload as Prisma.InputJsonValue,
        status: "PENDING",
      },
    });
    return { sent: 0, disabled: 0, inboxCreated: 0, queued: 1 };
  }

  return _doDeliverPush(input);
}

/**
 * 어드민 대시보드에서 PENDING 알림을 승인할 때 사용.
 * AUTO_CONFIRM_PUSH 분기를 우회하고 실제 FCM 발송 후 상태를 SENT 로 업데이트.
 */
export async function deliverQueuedNotification(
  pendingId: string,
  origin: string
): Promise<{ sent: number; disabled: number; inboxCreated: number; error?: string }> {
  const pending = await prisma.pendingPushNotification.findUnique({ where: { id: pendingId } });
  if (!pending) return { sent: 0, disabled: 0, inboxCreated: 0, error: "not_found" };
  if (pending.status !== "PENDING") {
    return { sent: 0, disabled: 0, inboxCreated: 0, error: `already_${pending.status.toLowerCase()}` };
  }

  const result = await _doDeliverPush({
    teamId: pending.teamId,
    topicKey: pending.topicKey as TopicKey,
    title: pending.title,
    body: pending.body,
    url: pending.url,
    type: pending.type as "GAME_START" | "GAME_RESULT" | "SCORE_UPDATE" | "SYSTEM",
    payload: (pending.payload ?? {}) as Prisma.InputJsonValue,
    origin,
  });

  await prisma.pendingPushNotification.update({
    where: { id: pendingId },
    data: { status: "SENT", sentAt: new Date(), sentCount: result.sent },
  });

  return result;
}
