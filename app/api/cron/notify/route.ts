import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendWebPush } from "@/lib/webPushServer";
import { findTeam } from "@/lib/teams";
import { fetchKboTodayGames, starterLabel, todayKstDate } from "@/lib/kbo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MESSAGE_TITLE = "KBO TODAY";
const MESSAGE_BODY = "곧 시작이다. 오늘 경기 같이 달리자 ⚾️";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = process.env.PUSH_LLM_MODEL ?? "claude-sonnet-4-6";

type ActiveSubscription = {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  topics: unknown;
  user: {
    favoriteTeam: string | null;
  };
};

type SubscriptionTopics = {
  preGame?: boolean;
  postGame?: boolean;
  gameEnd?: boolean;
};

type NotifyKind = "preGame" | "gameEnd";
type GameResultTone = "win" | "loss" | "draw";
type PreGameDetail = {
  opponentShort: string;
  time: string;
  stadium: string;
  starter: string;
};

function isNotifyEnabled(topics: unknown, kind: NotifyKind): boolean {
  if (!topics || typeof topics !== "object") return false;
  const parsed = topics as SubscriptionTopics;
  if (kind === "preGame") return Boolean(parsed.preGame);
  // Backward compatibility: legacy postGame 토글도 종료 알림으로 인정.
  return Boolean(parsed.gameEnd || parsed.postGame);
}

function hashString(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pickDeterministic<T>(items: readonly T[], seed: string): T {
  return items[hashString(seed) % items.length];
}

function buildPreGameCopy(teamId: string, dateSeed: string) {
  const team = findTeam(teamId);
  const samples = [
    `${team.short} 잠시 후 시작한다. 오늘은 우리가 먼저 때린다.`,
    `곧 플레이볼. ${team.short} 오늘도 찢어버리자.`,
    `경기 15분 전, 심장 뜀? ${team.short} 달려간다.`,
    `${team.short} 출근 완료. 이제 상대 멘탈 부수러 간다.`,
  ] as const;
  const body = pickDeterministic(samples, `${teamId}:${dateSeed}`);
  return {
    title: `${team.short} 곧 경기 시작! ⚾️`,
    body,
  };
}

function buildPreGameCopyWithDetails(teamId: string, detail: PreGameDetail) {
  const team = findTeam(teamId);
  return {
    title: `${team.short} vs ${detail.opponentShort} · ${detail.time}`,
    body: `${detail.stadium} · 선발 ${detail.starter}. 오늘도 찢어버리자 🔥`,
  };
}

function buildGameEndCopy(teamId: string, tone: GameResultTone, myScore?: number, oppScore?: number) {
  const team = findTeam(teamId);
  const scoreText =
    typeof myScore === "number" && typeof oppScore === "number"
      ? ` (${myScore}:${oppScore})`
      : "";
  if (tone === "win") {
    return {
      title: `${team.short} 이겼다 ㅋㅋ`,
      body: `오늘도 증명했다. ${team.short} 승리${scoreText}. 하이라이트 보러 가자.`,
    };
  }
  if (tone === "draw") {
    return {
      title: `${team.short} 오늘은 무승부`,
      body: `아쉽지만 안 졌다. ${team.short}${scoreText}. 다음 경기에서 끝내자.`,
    };
  }
  return {
    title: `${team.short} 오늘은 졌다`,
    body: `아 ㅅㅂ 오늘은 여기까지${scoreText}. 다음 판에서 바로 갚아준다.`,
  };
}

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clipForPush(text: string): string {
  const compact = compactText(text);
  if (compact.length <= 52) return compact;
  return `${compact.slice(0, 50)}..`;
}

function buildNotifySystemPrompt(teamShort: string, kind: NotifyKind): string {
  const situation =
    kind === "preGame"
      ? "경기 직전 응원 알림"
      : "경기 종료 직후 감정 알림";
  return `너는 KBO ${teamShort}의 30년 차 편파 팬이다.
지금은 ${situation} 문구를 만든다.

규칙:
- 오직 한 줄
- 24~48자
- 팬 커뮤니티 톤으로 날카롭고 재치 있게
- 이모지 1~2개 허용
- 불필요한 설명 금지
- 따옴표/번호/줄바꿈 금지`;
}

async function generateNotifyCopyWithLlm(input: {
  kind: NotifyKind;
  teamId: string;
  fallbackTitle: string;
  fallbackBody: string;
  resultTone: GameResultTone;
  myScore?: number;
  oppScore?: number;
}): Promise<{ title: string; body: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { title: input.fallbackTitle, body: input.fallbackBody };
  }

  const team = findTeam(input.teamId);
  const userPrompt =
    input.kind === "preGame"
      ? `상황: 경기 시작 직전\n팀: ${team.short}\n요구: 팬들 심장 뛰게 만드는 짧은 출정문`
      : `상황: 경기 종료\n팀: ${team.short}\n결과: ${input.resultTone}\n스코어: ${input.myScore ?? "-"}:${input.oppScore ?? "-"}\n요구: 결과 감정이 강하게 느껴지는 한 줄`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 64,
        temperature: 0.92,
        system: buildNotifySystemPrompt(team.short, input.kind),
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { title: input.fallbackTitle, body: input.fallbackBody };
    }
    const json = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const generated =
      json.content
        ?.filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text ?? "")
        .join(" ") ?? "";
    const body = clipForPush(generated);
    if (!body) {
      return { title: input.fallbackTitle, body: input.fallbackBody };
    }
    const title =
      input.kind === "preGame"
        ? `${team.short} 곧 경기 시작! ⚾️`
        : input.fallbackTitle;
    return { title, body };
  } catch {
    return { title: input.fallbackTitle, body: input.fallbackBody };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolvePreGameDetailsByTeam(): Promise<Map<string, PreGameDetail>> {
  const date = todayKstDate();
  const games = await fetchKboTodayGames(date);
  const map = new Map<string, PreGameDetail>();
  for (const game of games) {
    const home = findTeam(game.homeId);
    const away = findTeam(game.awayId);
    const homeDetail: PreGameDetail = {
      opponentShort: away.short,
      time: game.time,
      stadium: game.stadium,
      starter: starterLabel(game.homePitcher),
    };
    const awayDetail: PreGameDetail = {
      opponentShort: home.short,
      time: game.time,
      stadium: game.stadium,
      starter: starterLabel(game.awayPitcher),
    };
    map.set(game.homeId, homeDetail);
    map.set(game.awayId, awayDetail);
  }
  return map;
}

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // 로컬 개발 편의
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const kindParam = url.searchParams.get("kind");
  const kind: NotifyKind = kindParam === "gameEnd" ? "gameEnd" : "preGame";
  const teamId = url.searchParams.get("teamId")?.trim().toLowerCase() || null;
  const resultParam = url.searchParams.get("result");
  const resultTone: GameResultTone =
    resultParam === "win" || resultParam === "loss" || resultParam === "draw"
      ? resultParam
      : "win";
  const myScore = Number.parseInt(url.searchParams.get("myScore") ?? "", 10);
  const oppScore = Number.parseInt(url.searchParams.get("oppScore") ?? "", 10);
  const dateSeed = new Date().toISOString().slice(0, 10);

  const fallbackGenerated =
    teamId == null
      ? { title: MESSAGE_TITLE, body: MESSAGE_BODY }
      : kind === "preGame"
        ? buildPreGameCopy(teamId, dateSeed)
        : buildGameEndCopy(
            teamId,
            resultTone,
            Number.isFinite(myScore) ? myScore : undefined,
            Number.isFinite(oppScore) ? oppScore : undefined
          );

  const generated =
    teamId == null
      ? fallbackGenerated
      : await generateNotifyCopyWithLlm({
          kind,
          teamId,
          fallbackTitle: fallbackGenerated.title,
          fallbackBody: fallbackGenerated.body,
          resultTone,
          myScore: Number.isFinite(myScore) ? myScore : undefined,
          oppScore: Number.isFinite(oppScore) ? oppScore : undefined,
        });

  const title = url.searchParams.get("title")?.trim() || generated.title;
  const body = url.searchParams.get("body")?.trim() || generated.body;

  const activeSubs: ActiveSubscription[] = await prisma.pushSubscription.findMany({
    where: {
      enabled: true,
      ...(teamId ? { user: { is: { favoriteTeam: teamId } } } : {}),
    },
    select: {
      id: true,
      userId: true,
      endpoint: true,
      p256dh: true,
      auth: true,
      topics: true,
      user: {
        select: {
          favoriteTeam: true,
        },
      },
    },
  });
  const filteredSubs = activeSubs.filter((sub) => isNotifyEnabled(sub.topics, kind));
  if (filteredSubs.length === 0) {
    return NextResponse.json({
      ok: true,
      sent: 0,
      disabled: 0,
      notificationsCreated: 0,
      message: `no ${kind} subscriptions`,
    });
  }

  const hasManualTitle = Boolean(url.searchParams.get("title")?.trim());
  const hasManualBody = Boolean(url.searchParams.get("body")?.trim());
  const preGameDetails =
    kind === "preGame" && !hasManualTitle && !hasManualBody
      ? await resolvePreGameDetailsByTeam()
      : new Map<string, PreGameDetail>();

  const copyCache = new Map<string, { title: string; body: string }>();
  const resolveCopyForSub = async (sub: ActiveSubscription) => {
    const favorite = sub.user.favoriteTeam ?? teamId;
    if (!favorite) return { title, body };
    const cacheKey = `${kind}:${favorite}:${resultTone}:${myScore}:${oppScore}:${dateSeed}`;
    const cached = copyCache.get(cacheKey);
    if (cached) return cached;

    let copy: { title: string; body: string };
    if (kind === "preGame" && !hasManualTitle && !hasManualBody) {
      const detail = preGameDetails.get(favorite);
      if (detail) {
        copy = buildPreGameCopyWithDetails(favorite, detail);
      } else {
        copy = buildPreGameCopy(favorite, dateSeed);
      }
    } else if (!hasManualTitle && !hasManualBody) {
      copy =
        favorite === teamId
          ? generated
          : await generateNotifyCopyWithLlm({
              kind,
              teamId: favorite,
              fallbackTitle:
                kind === "gameEnd"
                  ? buildGameEndCopy(
                      favorite,
                      resultTone,
                      Number.isFinite(myScore) ? myScore : undefined,
                      Number.isFinite(oppScore) ? oppScore : undefined
                    ).title
                  : buildPreGameCopy(favorite, dateSeed).title,
              fallbackBody:
                kind === "gameEnd"
                  ? buildGameEndCopy(
                      favorite,
                      resultTone,
                      Number.isFinite(myScore) ? myScore : undefined,
                      Number.isFinite(oppScore) ? oppScore : undefined
                    ).body
                  : buildPreGameCopy(favorite, dateSeed).body,
              resultTone,
              myScore: Number.isFinite(myScore) ? myScore : undefined,
              oppScore: Number.isFinite(oppScore) ? oppScore : undefined,
            });
    } else {
      copy = { title, body };
    }

    copyCache.set(cacheKey, copy);
    return copy;
  };

  const targetUserIds = Array.from(new Set(filteredSubs.map((s) => s.userId)));
  const userCopyMap = new Map<string, { title: string; body: string }>();
  for (const sub of filteredSubs) {
    if (userCopyMap.has(sub.userId)) continue;
    userCopyMap.set(sub.userId, await resolveCopyForSub(sub));
  }
  await prisma.notification.createMany({
    data: targetUserIds.map((userId) => ({
      userId,
      type: kind === "preGame" ? "PREDICTION_REMINDER" : "GAME_RESULT",
      title: userCopyMap.get(userId)?.title ?? title,
      body: userCopyMap.get(userId)?.body ?? body,
      deeplinkUrl: "/today",
      sentAt: new Date(),
    })),
  });

  let sent = 0;
  let disabled = 0;
  for (const sub of filteredSubs) {
    const copy = await resolveCopyForSub(sub);
    const result = await sendWebPush(
      {
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
      {
        title: copy.title,
        body: copy.body,
        url: "/today",
        ...(sub.user.favoriteTeam ?? teamId
          ? { teamId: sub.user.favoriteTeam ?? teamId ?? undefined }
          : {}),
      },
      { favoriteTeam: sub.user.favoriteTeam, origin: url.origin }
    );
    if (result.ok) {
      sent += 1;
      continue;
    }
    if (
      result.statusCode === 401 ||
      result.statusCode === 403 ||
      result.statusCode === 404 ||
      result.statusCode === 410
    ) {
      await prisma.pushSubscription.update({
        where: { id: sub.id },
        data: { enabled: false },
      });
      disabled += 1;
    }
  }

  await prisma.user.updateMany({
    where: { id: { in: targetUserIds } },
    data: { lastNotifiedAt: new Date() },
  });

  return NextResponse.json({
    ok: true,
    kind,
    teamId,
    sent,
    disabled,
    notificationsCreated: targetUserIds.length,
  });
}
