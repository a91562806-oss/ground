import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendWebPush } from "@/lib/webPushServer";
import {
  fetchMockScoreSnapshotByTick,
} from "@/lib/scoreMock";
import { findTeam } from "@/lib/teams";
import { isKboRegularOffDay, todayKstDate } from "@/lib/kbo";
import { buildBiasedScoreCopy, computePulseState } from "@/lib/pushTemplate";
import { generateScorePushCopy } from "@/lib/pushLlm";
import { finishCronRun, startCronRun } from "@/lib/cronRunLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type GameEndTone = "win" | "loss" | "draw";
type LiveScoreGame = {
  externalId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  status: "BEFORE" | "LIVE" | "RESULT" | "CANCEL";
  gameDate: Date | null;
};

type SubscriptionTopics = {
  score?: boolean;
  postGame?: boolean;
  gameEnd?: boolean;
};

type JsonObject = Record<string, unknown>;

function isScoreAlertEnabled(topics: unknown): boolean {
  if (!topics || typeof topics !== "object") return false;
  return Boolean((topics as SubscriptionTopics).score);
}

function isGameEndAlertEnabled(topics: unknown): boolean {
  if (!topics || typeof topics !== "object") return false;
  const parsed = topics as SubscriptionTopics;
  return Boolean(parsed.postGame || parsed.gameEnd);
}

function isAuthorized(req: Request, url: URL): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  const querySecret = url.searchParams.get("secret");
  return auth === `Bearer ${secret}` || querySecret === secret;
}

function isFastMode(url: URL): boolean {
  const raw = (url.searchParams.get("fast") ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function buildGameEndCopy(game: LiveScoreGame, favoriteTeam: string, tone: GameEndTone) {
  const isHomeFan = favoriteTeam === game.homeTeam;
  const myScore = isHomeFan ? game.homeScore : game.awayScore;
  const oppScore = isHomeFan ? game.awayScore : game.homeScore;
  const myTeam = findTeam(favoriteTeam);
  const oppTeam = findTeam(isHomeFan ? game.awayTeam : game.homeTeam);

  if (tone === "win") {
    return {
      title: `✅ ${myTeam.short} 승리 확정`,
      body: `이겼다 ㅋㅋ ${myTeam.short} ${myScore}:${oppScore} ${oppTeam.short}. 하이라이트 보러 가자.`,
    };
  }
  if (tone === "draw") {
    return {
      title: `🤝 ${myTeam.short} 무승부`,
      body: `${myTeam.short} ${myScore}:${oppScore} ${oppTeam.short}. 안 졌다, 다음 경기에서 끝내자.`,
    };
  }
  return {
    title: `❌ ${myTeam.short} 패배`,
    body: `아 ㅅㅂ ${myTeam.short} ${myScore}:${oppScore} ${oppTeam.short}... 다음 판에서 바로 갚는다.`,
  };
}

const NAVER_BASE = "https://api-gw.sports.naver.com";
const NAVER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 GroundBot/1.0";

const NAVER_TEAM_MAP: Record<string, string> = {
  LG: "lg",
  OB: "doosan",
  HT: "kia",
  HH: "hanwha",
  WO: "kiwoom",
  LT: "lotte",
  NC: "nc",
  SK: "ssg",
  SS: "samsung",
  KT: "kt",
};

function normalizeStatus(code: string | undefined): LiveScoreGame["status"] {
  switch ((code ?? "").toUpperCase()) {
    case "BEFORE":
    case "READY":
      return "BEFORE";
    case "STARTED":
    case "PLAYING":
    case "LIVE":
      return "LIVE";
    case "RESULT":
    case "FINISH":
    case "ENDED":
      return "RESULT";
    case "CANCEL":
    case "POSTPONED":
    case "CANCELLED":
      return "CANCEL";
    default:
      return "BEFORE";
  }
}

function parseGameDate(gameDate?: string, gameDateTime?: string): Date | null {
  if (typeof gameDateTime === "string") {
    const ms = Date.parse(gameDateTime);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  if (typeof gameDate === "string" && gameDate.length === 8) {
    const iso = `${gameDate.slice(0, 4)}-${gameDate.slice(4, 6)}-${gameDate.slice(6, 8)}T00:00:00+09:00`;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return null;
}

function readStringValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function collectCandidateTexts(root: unknown): string[] {
  const queue: unknown[] = [root];
  const out: string[] = [];
  const visited = new Set<unknown>();
  const keys = ["relay", "text", "comment", "summary", "play", "situation", "content"];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }
    if (typeof current !== "object") continue;
    const obj = current as JsonObject;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") {
        const lower = key.toLowerCase();
        const text = readStringValue(value);
        if (!text) continue;
        if (keys.some((token) => lower.includes(token))) {
          out.push(text);
        }
      } else if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }
  return out;
}

function pickLatestPlayText(payload: unknown): string | null {
  const candidates = collectCandidateTexts(payload)
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 8);
  if (candidates.length === 0) return null;
  return candidates[0];
}

async function fetchLatestPlayText(gameId: string): Promise<string | null> {
  const endpoints = [
    `${NAVER_BASE}/schedule/games/${gameId}/relay`,
    `${NAVER_BASE}/schedule/games/${gameId}/relayTexts`,
    `${NAVER_BASE}/schedule/games/${gameId}`,
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await fetchJsonWithTimeout(endpoint, 300);
      if (!res.ok) continue;
      const json = await res.json();
      const text = pickLatestPlayText(json);
      if (text) return text;
    } catch {
      // ignore and try next endpoint
    }
  }
  return null;
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        "user-agent": NAVER_UA,
        accept: "application/json",
        referer: "https://m.sports.naver.com/",
      },
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function fetchLiveScoreSnapshot(): Promise<LiveScoreGame[]> {
  const date = todayKstDate();
  const url =
    `${NAVER_BASE}/schedule/games` +
    `?fields=basic,statusInfo,score` +
    `&upperCategoryId=kbaseball&categoryId=kbo` +
    `&fromDate=${date}&toDate=${date}&size=200`;
  const res = await fetchJsonWithTimeout(url, 1200);
  if (!res.ok) throw new Error(`naver score HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: {
      games?: Array<{
        gameId?: string;
        gameDate?: string;
        gameDateTime?: string;
        homeTeamCode?: string;
        awayTeamCode?: string;
        homeTeamScore?: number;
        awayTeamScore?: number;
        statusCode?: string;
      }>;
    };
  };
  const games = json?.result?.games ?? [];
  return games
    .map((g) => {
      const homeTeam = NAVER_TEAM_MAP[(g.homeTeamCode ?? "").toUpperCase()];
      const awayTeam = NAVER_TEAM_MAP[(g.awayTeamCode ?? "").toUpperCase()];
      if (!homeTeam || !awayTeam || !g.gameId) return null;
      return {
        externalId: g.gameId,
        homeTeam,
        awayTeam,
        homeScore: typeof g.homeTeamScore === "number" ? g.homeTeamScore : 0,
        awayScore: typeof g.awayTeamScore === "number" ? g.awayTeamScore : 0,
        status: normalizeStatus(g.statusCode),
        gameDate: parseGameDate(g.gameDate, g.gameDateTime),
      } as LiveScoreGame;
    })
    .filter((g): g is LiveScoreGame => Boolean(g));
}

function dayRangeKst(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!isAuthorized(req, url)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const fastMode = isFastMode(url);
  const targetDate = todayKstDate();
  const isOffDay = isKboRegularOffDay(targetDate);
  const tickRaw = url.searchParams.get("tick");
  const triggerSource = url.searchParams.get("source") ?? "unknown";
  const runId = await startCronRun("check-score", {
    fastMode,
    tickRaw,
    targetDate,
    isOffDay,
    triggerSource,
  });

  let checked = 0;
  let changed = 0;
  let pushSent = 0;
  let disabled = 0;
  let inboxCreated = 0;
  let llmCalls = 0;
  let errors = 0;
  const failedGameIds: string[] = [];
  let fetchError: string | null = null;
  let snapshot: LiveScoreGame[] = [];

  try {
    if (isOffDay && (tickRaw == null || tickRaw === "")) {
      const { start, end } = dayRangeKst(targetDate);
      const cleared = await prisma.game.deleteMany({
        where: {
          gameDate: {
            gte: start,
            lt: end,
          },
        },
      });
      const summary = {
        fastMode,
        checked,
        changed,
        llmCalls,
        pushSent,
        disabled,
        inboxCreated,
        errors,
        failedGameIds,
        snapshotCount: 0,
        fetchError,
        triggerSource,
        targetDate,
        skipped: "MONDAY_OFF",
        clearedGames: cleared.count,
      };
      await finishCronRun({
        id: runId,
        status: "success",
        summary,
      });
      return NextResponse.json({ ok: true, runId, ...summary });
    }

    try {
      snapshot =
        tickRaw != null && tickRaw !== ""
          ? (await fetchMockScoreSnapshotByTick(Number(tickRaw))).map((g) => ({
              externalId: g.externalId,
              homeTeam: g.homeTeam,
              awayTeam: g.awayTeam,
              homeScore: g.homeScore,
              awayScore: g.awayScore,
              status: g.status,
              gameDate: g.gameDate,
            }))
          : await fetchLiveScoreSnapshot();
    } catch (error) {
      fetchError = (error as Error).message;
      errors += 1;
      console.error("[check-score] snapshot fetch failed", error);
      snapshot = [];
    }

    if (snapshot.length === 0 || snapshot.every((game) => game.status === "CANCEL")) {
      const { start, end } = dayRangeKst(targetDate);
      const cleared = await prisma.game.deleteMany({
        where: {
          gameDate: {
            gte: start,
            lt: end,
          },
        },
      });
      const summary = {
        fastMode,
        checked,
        changed,
        llmCalls,
        pushSent,
        disabled,
        inboxCreated,
        errors,
        failedGameIds,
        snapshotCount: snapshot.length,
        fetchError,
        triggerSource,
        targetDate,
        skipped: snapshot.length === 0 ? "NO_GAMES" : "ALL_CANCELLED",
        clearedGames: cleared.count,
      };
      await finishCronRun({
        id: runId,
        status: fetchError ? "partial" : "success",
        summary,
        error: fetchError,
      });
      return NextResponse.json({ ok: !fetchError, runId, ...summary });
    }

    for (const game of snapshot) {
      checked += 1;
      try {
        const previous = await prisma.game.findUnique({
          where: { externalId: game.externalId },
        });

        const updated = await prisma.game.upsert({
          where: { externalId: game.externalId },
          update: {
            homeTeam: game.homeTeam,
            awayTeam: game.awayTeam,
            homeScore: game.homeScore,
            awayScore: game.awayScore,
            status: game.status,
            gameDate: game.gameDate,
            lastSyncedAt: new Date(),
          },
          create: {
            externalId: game.externalId,
            homeTeam: game.homeTeam,
            awayTeam: game.awayTeam,
            homeScore: game.homeScore,
            awayScore: game.awayScore,
            status: game.status,
            gameDate: game.gameDate,
            lastSyncedAt: new Date(),
          },
        });

        if (!previous) continue;
        const homeDelta = game.homeScore - previous.homeScore;
        const awayDelta = game.awayScore - previous.awayScore;
        if (homeDelta <= 0 && awayDelta <= 0) continue;

        changed += 1;
        const latestPlayText = fastMode
          ? `스코어 변동: ${game.homeTeam} ${game.homeScore}:${game.awayScore} ${game.awayTeam}`
          : (await fetchLatestPlayText(game.externalId)) ??
            `스코어 변동: ${game.homeTeam} ${game.homeScore}:${game.awayScore} ${game.awayTeam}`;
        const activeSubs = await prisma.pushSubscription.findMany({
          where: {
            enabled: true,
            user: {
              favoriteTeam: {
                in: [game.homeTeam, game.awayTeam],
              },
            },
          },
          select: {
            endpoint: true,
            p256dh: true,
            auth: true,
            userId: true,
            topics: true,
            user: {
              select: {
                favoriteTeam: true,
              },
            },
          },
        });

        const scoreTargets = activeSubs
          .filter((sub) => isScoreAlertEnabled(sub.topics))
          .map((sub) => ({ sub }));

        const scoreCopyCache = new Map<string, Promise<{ title: string; body: string }>>();
        const scoreResults = await mapWithConcurrency(scoreTargets, 12, async ({ sub }) => {
          const favoriteTeam = sub.user.favoriteTeam;
          if (!favoriteTeam) return null;

          let tone: "for" | "against" | null = null;
          if (favoriteTeam === game.homeTeam) {
            if (homeDelta > 0) tone = "for";
            else if (awayDelta > 0) tone = "against";
          } else if (favoriteTeam === game.awayTeam) {
            if (awayDelta > 0) tone = "for";
            else if (homeDelta > 0) tone = "against";
          }
          if (!tone) return null;

          const isHomeFan = favoriteTeam === game.homeTeam;
          const prevMyScore = isHomeFan ? previous.homeScore : previous.awayScore;
          const prevOppScore = isHomeFan ? previous.awayScore : previous.homeScore;
          const myScore = isHomeFan ? game.homeScore : game.awayScore;
          const oppScore = isHomeFan ? game.awayScore : game.homeScore;
          const state = computePulseState(prevMyScore, prevOppScore, myScore, oppScore);
          const myTeam = findTeam(favoriteTeam);
          const oppTeam = findTeam(isHomeFan ? game.awayTeam : game.homeTeam);
          const fallback = buildBiasedScoreCopy({
            teamShort: myTeam.short,
            oppShort: oppTeam.short,
            myScore,
            oppScore,
            tone,
            state,
          });

          const cacheKey = `${favoriteTeam}:${myScore}:${oppScore}:${tone}:${latestPlayText}`;
          let copyPromise = scoreCopyCache.get(cacheKey);
          if (!copyPromise) {
            if (fastMode) {
              copyPromise = Promise.resolve(fallback);
            } else {
              llmCalls += 1;
              copyPromise = generateScorePushCopy({
                favoriteTeam,
                opponentTeam: isHomeFan ? game.awayTeam : game.homeTeam,
                myScore,
                oppScore,
                latestPlayText,
                fallbackTitle: fallback.title,
                fallbackBody: fallback.body,
              });
            }
            scoreCopyCache.set(cacheKey, copyPromise);
          }
          const aiCopy = await copyPromise;
          const push = await sendWebPush(
            {
              endpoint: sub.endpoint,
              p256dh: sub.p256dh,
              auth: sub.auth,
            },
            {
              title: aiCopy.title,
              body: aiCopy.body,
              url: "/today",
              latestPlayText,
              teamId: favoriteTeam,
            },
            { favoriteTeam, origin: url.origin }
          );

          return {
            sub,
            tone,
            aiCopy,
            push,
            payload: {
              gameId: updated.id,
              externalId: game.externalId,
              homeTeam: game.homeTeam,
              awayTeam: game.awayTeam,
              homeScore: game.homeScore,
              awayScore: game.awayScore,
              tone,
              latestPlayText,
            } as Prisma.InputJsonValue,
          };
        });

        const disableTargets = scoreResults
          .filter(
            (r) =>
              r &&
              (r.push.statusCode === 401 ||
                r.push.statusCode === 403 ||
                r.push.statusCode === 404 ||
                r.push.statusCode === 410)
          )
          .map((r) => r!.sub);

        if (disableTargets.length > 0) {
          const disableResults = await mapWithConcurrency(disableTargets, 8, (sub) =>
            prisma.pushSubscription.updateMany({
              where: {
                userId: sub.userId,
                endpoint: sub.endpoint,
                enabled: true,
              },
              data: { enabled: false },
            })
          );
          disabled += disableResults.reduce((acc, row) => acc + row.count, 0);
        }

        const inboxRows: Array<{
          userId: string;
          title: string;
          body: string;
          deeplinkUrl: string;
          sentAt: Date;
          type: "SCORE_UPDATE";
          payload: Prisma.InputJsonValue;
        }> = [];
        const inboxKey = new Set<string>();
        for (const row of scoreResults) {
          if (!row) continue;
          if (row.push.ok) pushSent += 1;
          const key = `${row.sub.userId}:${row.aiCopy.title}:${row.aiCopy.body}`;
          if (inboxKey.has(key)) continue;
          inboxKey.add(key);
          inboxRows.push({
            userId: row.sub.userId,
            title: row.aiCopy.title,
            body: row.aiCopy.body,
            deeplinkUrl: "/today",
            sentAt: new Date(),
            type: "SCORE_UPDATE",
            payload: row.payload,
          });
        }

        if (inboxRows.length > 0) {
          const result = await prisma.notification.createMany({ data: inboxRows });
          inboxCreated += result.count;
        }

        const justEnded = previous.status !== "RESULT" && game.status === "RESULT";
        if (!justEnded) continue;

        const endSubs = await prisma.pushSubscription.findMany({
          where: {
            enabled: true,
            user: {
              favoriteTeam: {
                in: [game.homeTeam, game.awayTeam],
              },
            },
          },
          select: {
            endpoint: true,
            p256dh: true,
            auth: true,
            userId: true,
            topics: true,
            user: {
              select: {
                favoriteTeam: true,
              },
            },
          },
        });

        const endResults = await mapWithConcurrency(
          endSubs.filter((sub) => isGameEndAlertEnabled(sub.topics)),
          12,
          async (sub) => {
            const favoriteTeam = sub.user.favoriteTeam;
            if (!favoriteTeam) return null;

            let tone: GameEndTone | null = null;
            if (favoriteTeam === game.homeTeam) {
              if (game.homeScore > game.awayScore) tone = "win";
              else if (game.homeScore < game.awayScore) tone = "loss";
              else tone = "draw";
            } else if (favoriteTeam === game.awayTeam) {
              if (game.awayScore > game.homeScore) tone = "win";
              else if (game.awayScore < game.homeScore) tone = "loss";
              else tone = "draw";
            }
            if (!tone) return null;

            const copy = buildGameEndCopy(game, favoriteTeam, tone);
            const push = await sendWebPush(
              {
                endpoint: sub.endpoint,
                p256dh: sub.p256dh,
                auth: sub.auth,
              },
              {
                title: copy.title,
                body: copy.body,
                url: "/today",
                teamId: favoriteTeam,
              },
              { favoriteTeam, origin: url.origin }
            );

            return {
              sub,
              tone,
              copy,
              push,
            };
          }
        );

        const endDisableTargets = endResults
          .filter(
            (r) =>
              r &&
              (r.push.statusCode === 401 ||
                r.push.statusCode === 403 ||
                r.push.statusCode === 404 ||
                r.push.statusCode === 410)
          )
          .map((r) => r!.sub);
        if (endDisableTargets.length > 0) {
          const disableResults = await mapWithConcurrency(endDisableTargets, 8, (sub) =>
            prisma.pushSubscription.updateMany({
              where: {
                userId: sub.userId,
                endpoint: sub.endpoint,
                enabled: true,
              },
              data: { enabled: false },
            })
          );
          disabled += disableResults.reduce((acc, row) => acc + row.count, 0);
        }

        const endInboxRows: Array<{
          userId: string;
          title: string;
          body: string;
          deeplinkUrl: string;
          sentAt: Date;
          type: "GAME_RESULT";
          payload: Prisma.InputJsonValue;
        }> = [];
        const endInboxKey = new Set<string>();

        for (const row of endResults) {
          if (!row) continue;
          if (row.push.ok) pushSent += 1;
          const key = `${row.sub.userId}:${row.copy.title}:${row.copy.body}`;
          if (endInboxKey.has(key)) continue;
          endInboxKey.add(key);
          endInboxRows.push({
            userId: row.sub.userId,
            title: row.copy.title,
            body: row.copy.body,
            deeplinkUrl: "/today",
            sentAt: new Date(),
            type: "GAME_RESULT",
            payload: {
              gameId: updated.id,
              externalId: game.externalId,
              homeTeam: game.homeTeam,
              awayTeam: game.awayTeam,
              homeScore: game.homeScore,
              awayScore: game.awayScore,
              tone: row.tone,
            },
          });
        }

        if (endInboxRows.length > 0) {
          const result = await prisma.notification.createMany({ data: endInboxRows });
          inboxCreated += result.count;
        }
      } catch (error) {
        errors += 1;
        failedGameIds.push(game.externalId);
        console.error("[check-score] failed for game", game.externalId, error);
      }
    }

    const summary = {
      fastMode,
      checked,
      changed,
      llmCalls,
      pushSent,
      disabled,
      inboxCreated,
      errors,
      failedGameIds,
      snapshotCount: snapshot.length,
      fetchError,
      triggerSource,
      targetDate,
    };
    await finishCronRun({
      id: runId,
      status: errors > 0 || fetchError ? "partial" : "success",
      summary,
      error: fetchError,
    });

    return NextResponse.json({
      ok: errors === 0 && !fetchError,
      runId,
      ...summary,
    });
  } catch (error) {
    const message = (error as Error).message;
    await finishCronRun({
      id: runId,
      status: "error",
      summary: {
        fastMode,
        checked,
        changed,
        llmCalls,
        pushSent,
        disabled,
        inboxCreated,
        errors: errors + 1,
        failedGameIds,
        triggerSource,
      },
      error: message,
    });
    return NextResponse.json(
      {
        ok: false,
        runId,
        error: message,
        checked,
        changed,
        llmCalls,
        pushSent,
        disabled,
        inboxCreated,
        errors: errors + 1,
        failedGameIds,
      },
      { status: 500 }
    );
  }
}
