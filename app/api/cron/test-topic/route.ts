import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findTeam } from "@/lib/teams";
import { isAlphaServerEnv } from "@/lib/appEnv";
import { sendWebPush } from "@/lib/webPushServer";
import { authorizeCron, sendTeamTopicNotification, type TopicKey } from "@/services/notificationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ALLOWED_TOPICS: TopicKey[] = [
  "pitcher",
  "preGame",
  "score",
  "livePitcherChange",
  "liveStrikeout",
  "postGame",
  "highlight",
];

function parseTopic(raw: string | null): TopicKey | null {
  if (!raw) return null;
  const topic = raw.trim() as TopicKey;
  return ALLOWED_TOPICS.includes(topic) ? topic : null;
}

function defaultCopy(teamId: string, topic: TopicKey): { title: string; body: string } {
  const team = findTeam(teamId).short;
  switch (topic) {
    case "pitcher":
      return {
        title: `🧪 ${team} 경기 프리뷰 테스트`,
        body: "토글 검증용 테스트 메시지입니다. (경기 프리뷰)",
      };
    case "preGame":
      return {
        title: `🧪 ${team} 경기 시작 테스트`,
        body: "토글 검증용 테스트 메시지입니다. (경기 시작)",
      };
    case "score":
      return {
        title: `🧪 ${team} 스코어 알림 테스트`,
        body: "토글 검증용 테스트 메시지입니다. (스코어)",
      };
    case "livePitcherChange":
      return {
        title: `🧪 ${team} 라이브 상황 테스트`,
        body: "토글 검증용 테스트 메시지입니다. (투수 교체)",
      };
    case "liveStrikeout":
      return {
        title: `🧪 ${team} 라이브 상황 테스트`,
        body: "토글 검증용 테스트 메시지입니다. (탈삼진)",
      };
    case "postGame":
      return {
        title: `🧪 ${team} 경기 결과 테스트`,
        body: "토글 검증용 테스트 메시지입니다. (경기 결과)",
      };
    case "highlight":
      return {
        title: `🧪 ${team} 하이라이트 테스트`,
        body: "토글 검증용 테스트 메시지입니다. (하이라이트)",
      };
    default:
      return {
        title: "🧪 알림 테스트",
        body: "토글 검증용 테스트 메시지입니다.",
      };
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const auth = authorizeCron(req, url);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (!isAlphaServerEnv()) {
    return NextResponse.json({ ok: false, error: "alpha_only" }, { status: 403 });
  }

  const teamId = (url.searchParams.get("teamId") ?? "").trim().toLowerCase();
  if (!teamId) return NextResponse.json({ ok: false, error: "teamId_required" }, { status: 400 });

  // `listUsers=1` 이면 alpha 구독자 userId 목록만 반환 (발송 없음).
  if (url.searchParams.get("listUsers") === "1") {
    const subs = await prisma.pushSubscription.findMany({
      where: { enabled: true, user: { favoriteTeam: teamId } },
      select: { userId: true, topics: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
    const alpha = subs.filter((s) => (s.topics as Record<string, unknown>)?.appEnv === "alpha");
    return NextResponse.json({
      ok: true,
      teamId,
      alphaCount: alpha.length,
      users: alpha.map((s) => ({ userId: s.userId, updatedAt: s.updatedAt })),
    });
  }

  const topic = parseTopic(url.searchParams.get("topic"));
  if (!topic) return NextResponse.json({ ok: false, error: "invalid_topic" }, { status: 400 });

  const copy = defaultCopy(teamId, topic);
  const title = (url.searchParams.get("title") ?? "").trim() || copy.title;
  const body = (url.searchParams.get("body") ?? "").trim() || copy.body;

  // `userId=` 파라미터가 있으면 그 1명에게만 직접 발송 (테스트 오발 방지).
  // 없으면 팀 전체 alpha 구독자에게 sendTeamTopicNotification 경유.
  const targetUserId = (url.searchParams.get("userId") ?? "").trim();
  if (targetUserId) {
    const sub = await prisma.pushSubscription.findFirst({
      where: { userId: targetUserId, enabled: true },
      orderBy: { updatedAt: "desc" },
      select: { endpoint: true, p256dh: true, auth: true },
    });
    if (!sub) {
      return NextResponse.json({ ok: false, error: "subscription_not_found", userId: targetUserId });
    }
    const push = await sendWebPush(
      { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      { title, body, url: "/today", teamId },
      { favoriteTeam: teamId, origin: url.origin }
    );
    return NextResponse.json({ ok: push.ok, userId: targetUserId, teamId, topic, sent: push.ok ? 1 : 0 });
  }

  const result = await sendTeamTopicNotification({
    teamId,
    topicKey: topic,
    title,
    body,
    url: "/today",
    payload: {
      kind: "topic-test",
      teamId,
      topic,
      issuedAt: new Date().toISOString(),
    },
    type: "SYSTEM",
    origin: url.origin,
  });

  return NextResponse.json({
    ok: true,
    teamId,
    topic,
    sent: result.sent,
    disabled: result.disabled,
    inboxCreated: result.inboxCreated,
  });
}

