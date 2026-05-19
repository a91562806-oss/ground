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
import { fetchPostGameFacts, generatePostGameReport } from "@/lib/postGameReport";
import { shouldSkipCronInAlpha } from "@/lib/appEnv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

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
  livePitcherChange?: boolean;
  liveStrikeout?: boolean;
  postGame?: boolean;
  gameEnd?: boolean;
};

type JsonObject = Record<string, unknown>;

type ActiveSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
  userId: string;
  topics: unknown;
  updatedAt: Date;
  user: {
    favoriteTeam: string | null;
  };
};

function isScoreAlertEnabled(topics: unknown): boolean {
  if (!topics || typeof topics !== "object") return false;
  return Boolean((topics as SubscriptionTopics).score);
}

function isLivePitcherChangeEnabled(topics: unknown): boolean {
  if (!topics || typeof topics !== "object") return true;
  const value = (topics as SubscriptionTopics).livePitcherChange;
  return value === undefined ? true : Boolean(value);
}

function isLiveStrikeoutEnabled(topics: unknown): boolean {
  if (!topics || typeof topics !== "object") return true;
  const value = (topics as SubscriptionTopics).liveStrikeout;
  return value === undefined ? true : Boolean(value);
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

const CHECK_SCORE_LOCK_KEY = 2026051901;

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
      const res = await fetchJsonWithTimeout(endpoint, 900);
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

async function fetchRecentBodiesByTeam(teamIds: string[]): Promise<Map<string, string[]>> {
  const unique = [...new Set(teamIds.filter(Boolean))];
  const out = new Map<string, string[]>();
  if (unique.length === 0) return out;
  await Promise.all(
    unique.map(async (teamId) => {
      const rows = await prisma.notification.findMany({
        where: {
          type: "SCORE_UPDATE",
          createdAt: { gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
          payload: {
            path: ["teamId"],
            equals: teamId,
          },
        },
        orderBy: { createdAt: "desc" },
        take: 12,
        select: { body: true },
      });
      out.set(
        teamId,
        rows
          .map((row) => row.body)
          .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
      );
    })
  );
  return out;
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

async function tryAcquireCheckScoreLock(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ locked: boolean }>>(
      `SELECT pg_try_advisory_lock(${CHECK_SCORE_LOCK_KEY}) AS locked`
    );
    return Boolean(rows?.[0]?.locked);
  } catch (error) {
    console.error("[check-score] failed to acquire advisory lock", error);
    return false;
  }
}

async function releaseCheckScoreLock(): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `SELECT pg_advisory_unlock(${CHECK_SCORE_LOCK_KEY})`
    );
  } catch (error) {
    console.error("[check-score] failed to release advisory lock", error);
  }
}

function dayRangeKst(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

type LiveEventKind = "pitcherChange" | "strikeout";
type LiveEventTone = "for" | "against" | "neutral";

function detectHalfInning(latestPlayText: string): "초" | "말" | null {
  const match = latestPlayText.match(/\d{1,2}회(초|말)/);
  if (!match) return null;
  return match[1] === "초" || match[1] === "말" ? match[1] : null;
}

function detectLiveEventKinds(latestPlayText: string): LiveEventKind[] {
  const normalized = latestPlayText.replace(/\s+/g, " ").trim();
  const kinds: LiveEventKind[] = [];
  if (/투수\s*교체|교체\s*[:：]?\s*투수|마운드에\s*오른|마운드에\s*오릅니다/.test(normalized)) {
    kinds.push("pitcherChange");
  }
  if (/(헛스윙|루킹)?\s*삼진|탈삼진|\bK{1,3}\b/i.test(normalized)) {
    kinds.push("strikeout");
  }
  return kinds;
}

function resolveLiveEventToneByFan(
  latestPlayText: string,
  game: LiveScoreGame,
  favoriteTeam: string
): LiveEventTone {
  const half = detectHalfInning(latestPlayText);
  if (half) {
    const defendingTeam = half === "초" ? game.homeTeam : game.awayTeam;
    if (favoriteTeam === defendingTeam) return "for";
    const battingTeam = defendingTeam === game.homeTeam ? game.awayTeam : game.homeTeam;
    if (favoriteTeam === battingTeam) return "against";
  }

  const text = latestPlayText.toLowerCase();
  const myShort = findTeam(favoriteTeam).short.toLowerCase();
  const oppTeamId = favoriteTeam === game.homeTeam ? game.awayTeam : game.homeTeam;
  const oppShort = findTeam(oppTeamId).short.toLowerCase();
  if (text.includes(myShort) && !text.includes(oppShort)) return "for";
  if (!text.includes(myShort) && text.includes(oppShort)) return "against";
  return "neutral";
}

function buildLiveEventCopy(input: {
  kind: LiveEventKind;
  tone: LiveEventTone;
  favoriteTeam: string;
  opponentTeam: string;
  latestPlayText: string;
}): { title: string; body: string } {
  const myTeam = findTeam(input.favoriteTeam);
  const oppTeam = findTeam(input.opponentTeam);
  const body = input.latestPlayText.replace(/\s+/g, " ").trim().slice(0, 80);

  if (input.kind === "pitcherChange") {
    if (input.tone === "for") {
      return {
        title: `🔄 ${myTeam.short} 투수 교체`,
        body: `[경기중] ${body}`,
      };
    }
    if (input.tone === "neutral") {
      return {
        title: `🔄 경기중 투수 교체`,
        body: `[경기중] ${body}`,
      };
    }
    return {
      title: `🔄 ${oppTeam.short} 투수 교체`,
      body: `[경기중] ${body}`,
    };
  }

  if (input.tone === "for") {
    return {
      title: `🧊 ${myTeam.short} 탈삼진`,
      body: `[경기중] ${body}`,
    };
  }
  if (input.tone === "neutral") {
    return {
      title: `🧊 경기중 탈삼진`,
      body: `[경기중] ${body}`,
    };
  }
  return {
    title: `😬 ${oppTeam.short} 탈삼진`,
    body: `[경기중] ${body}`,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!isAuthorized(req, url)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (shouldSkipCronInAlpha(url)) {
    return NextResponse.json({
      ok: true,
      skipped: "ALPHA_ENV_CRON_DISABLED",
    });
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
  let lockAcquired = false;

  let checked = 0;
  let changed = 0;
  let pushSent = 0;
  let disabled = 0;
  let inboxCreated = 0;
  let llmCalls = 0;
  let reportQueued = 0;
  let reportReady = 0;
  let reportFailed = 0;
  let errors = 0;
  const failedGameIds: string[] = [];
  let fetchError: string | null = null;
  let snapshot: LiveScoreGame[] = [];

  try {
    lockAcquired = await tryAcquireCheckScoreLock();
    if (!lockAcquired) {
      const summary = {
        fastMode,
        checked,
        changed,
        llmCalls,
        reportQueued,
        reportReady,
        reportFailed,
        pushSent,
        disabled,
        inboxCreated,
        errors,
        failedGameIds,
        snapshotCount: 0,
        fetchError,
        triggerSource,
        targetDate,
        skipped: "OVERLAPPED_RUN",
      };
      await finishCronRun({
        id: runId,
        status: "partial",
        summary,
        error: "overlapped run skipped by advisory lock",
      });
      return NextResponse.json({ ok: true, runId, ...summary });
    }

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
        reportQueued,
        reportReady,
        reportFailed,
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
        reportQueued,
        reportReady,
        reportFailed,
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
        const scoreChanged = homeDelta > 0 || awayDelta > 0;
        const justEnded = previous.status !== "RESULT" && game.status === "RESULT";
        const shouldCheckLiveEvents = game.status === "LIVE";
        if (!scoreChanged && !justEnded && !shouldCheckLiveEvents) continue;

        const latestPlayText = fastMode
          ? `스코어 변동: ${game.homeTeam} ${game.homeScore}:${game.awayScore} ${game.awayTeam}`
          : (await fetchLatestPlayText(game.externalId)) ??
            `스코어 변동: ${game.homeTeam} ${game.homeScore}:${game.awayScore} ${game.awayTeam}`;

        const detectedLiveKinds = shouldCheckLiveEvents ? detectLiveEventKinds(latestPlayText) : [];
        const liveKindsToSend = detectedLiveKinds.filter((kind) => kind === "pitcherChange" || kind === "strikeout");
        const shouldProcessLiveEvents = liveKindsToSend.length > 0;

        if (scoreChanged) {
          const scoreDedupeKey = `score:${game.externalId}:${game.homeScore}:${game.awayScore}`;
          const alreadyNotified = await prisma.notification.findFirst({
            where: {
              type: "SCORE_UPDATE",
              createdAt: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) },
              payload: {
                path: ["dedupeKey"],
                equals: scoreDedupeKey,
              },
            },
            select: { id: true },
          });
          if (alreadyNotified) {
            continue;
          }
          const scoreAlertKey = `${game.homeScore}:${game.awayScore}`;
          const dedupe = await prisma.game.updateMany({
            where: {
              id: updated.id,
              OR: [{ lastScoreAlertKey: null }, { lastScoreAlertKey: { not: scoreAlertKey } }],
            },
            data: {
              lastScoreAlertKey: scoreAlertKey,
              lastScoreAlertAt: new Date(),
            },
          });
          if (dedupe.count === 0) {
            continue;
          }
          changed += 1;
        }

        const rawSubs = await prisma.pushSubscription.findMany({
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
            updatedAt: true,
            user: {
              select: {
                favoriteTeam: true,
              },
            },
          },
        });
        const activeSubs = uniqueLatestSubByUser(rawSubs as ActiveSubscription[]);

        const scoreCopyCache = new Map<string, Promise<{ title: string; body: string }>>();
        const recentBodiesByTeam = scoreChanged
          ? await fetchRecentBodiesByTeam(
              activeSubs
                .map((sub) => sub.user.favoriteTeam)
                .filter((teamId): teamId is string => Boolean(teamId))
            )
          : new Map<string, string[]>();
        const scoreResults = scoreChanged
          ? await mapWithConcurrency(
              activeSubs.filter((sub) => isScoreAlertEnabled(sub.topics)).map((sub) => ({ sub })),
              12,
              async ({ sub }) => {
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
                      recentBodies: recentBodiesByTeam.get(favoriteTeam) ?? [],
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
                    dedupeKey: `score:${game.externalId}:${game.homeScore}:${game.awayScore}`,
                    gameId: updated.id,
                    externalId: game.externalId,
                    homeTeam: game.homeTeam,
                    awayTeam: game.awayTeam,
                    homeScore: game.homeScore,
                    awayScore: game.awayScore,
                    teamId: favoriteTeam,
                    tone,
                    latestPlayText,
                  } as Prisma.InputJsonValue,
                };
              }
            )
          : [];

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

        if (shouldProcessLiveEvents) {
          for (const kind of liveKindsToSend) {
            const alreadyNotified = await prisma.notification.findFirst({
              where: {
                type: "SCORE_UPDATE",
                createdAt: { gte: new Date(Date.now() - 20 * 60 * 1000) },
                payload: {
                  path: ["externalId"],
                  equals: game.externalId,
                },
                AND: [
                  {
                    payload: {
                      path: ["eventKind"],
                      equals: kind,
                    },
                  },
                  {
                    payload: {
                      path: ["latestPlayText"],
                      equals: latestPlayText,
                    },
                  },
                ],
              },
              select: { id: true },
            });
            if (alreadyNotified) continue;

            const liveTargets = activeSubs.filter((sub) =>
              kind === "pitcherChange"
                ? isLivePitcherChangeEnabled(sub.topics)
                : isLiveStrikeoutEnabled(sub.topics)
            );

            const liveResults = await mapWithConcurrency(liveTargets, 12, async (sub) => {
              const favoriteTeam = sub.user.favoriteTeam;
              if (!favoriteTeam) return null;
              const tone = resolveLiveEventToneByFan(latestPlayText, game, favoriteTeam);
              const opponentTeam = favoriteTeam === game.homeTeam ? game.awayTeam : game.homeTeam;
              const copy = buildLiveEventCopy({
                kind,
                tone,
                favoriteTeam,
                opponentTeam,
                latestPlayText,
              });
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
                  latestPlayText,
                  teamId: favoriteTeam,
                },
                { favoriteTeam, origin: url.origin }
              );
              return { sub, push, copy, tone };
            });

            const liveDisableTargets = liveResults
              .filter(
                (r) =>
                  r &&
                  (r.push.statusCode === 401 ||
                    r.push.statusCode === 403 ||
                    r.push.statusCode === 404 ||
                    r.push.statusCode === 410)
              )
              .map((r) => r!.sub);
            if (liveDisableTargets.length > 0) {
              const disableResults = await mapWithConcurrency(liveDisableTargets, 8, (sub) =>
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

            const liveInboxRows: Array<{
              userId: string;
              title: string;
              body: string;
              deeplinkUrl: string;
              sentAt: Date;
              type: "SCORE_UPDATE";
              payload: Prisma.InputJsonValue;
            }> = [];
            const liveInboxKey = new Set<string>();
            for (const row of liveResults) {
              if (!row) continue;
              if (row.push.ok) pushSent += 1;
              const key = `${row.sub.userId}:${row.copy.title}:${row.copy.body}`;
              if (liveInboxKey.has(key)) continue;
              liveInboxKey.add(key);
              liveInboxRows.push({
                userId: row.sub.userId,
                title: row.copy.title,
                body: row.copy.body,
                deeplinkUrl: "/today",
                sentAt: new Date(),
                type: "SCORE_UPDATE",
                payload: {
                  gameId: updated.id,
                  externalId: game.externalId,
                  homeTeam: game.homeTeam,
                  awayTeam: game.awayTeam,
                  homeScore: game.homeScore,
                  awayScore: game.awayScore,
                  teamId: row.sub.user.favoriteTeam,
                  latestPlayText,
                  eventKind: kind,
                  tone: row.tone,
                } as Prisma.InputJsonValue,
              });
            }
            if (liveInboxRows.length > 0) {
              const result = await prisma.notification.createMany({ data: liveInboxRows });
              inboxCreated += result.count;
            }
          }
        }

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
            updatedAt: true,
            user: {
              select: {
                favoriteTeam: true,
              },
            },
          },
        });
        const uniqueEndSubs = uniqueLatestSubByUser(endSubs as ActiveSubscription[]);

        const endResults = await mapWithConcurrency(
          uniqueEndSubs.filter((sub) => isGameEndAlertEnabled(sub.topics)),
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

        const reportTargets = [game.homeTeam, game.awayTeam];
        for (const teamId of reportTargets) {
          const opponentTeamId = teamId === game.homeTeam ? game.awayTeam : game.homeTeam;
          const isHomeFan = teamId === game.homeTeam;
          const myScore = isHomeFan ? game.homeScore : game.awayScore;
          const oppScore = isHomeFan ? game.awayScore : game.homeScore;
          const tone: "win" | "loss" | "draw" =
            myScore === oppScore ? "draw" : myScore > oppScore ? "win" : "loss";

          const existing = await prisma.postGameReport.findUnique({
            where: {
              externalId_teamId: {
                externalId: game.externalId,
                teamId,
              },
            },
            select: { status: true },
          });
          if (existing?.status === "READY") continue;
          reportQueued += 1;

          await prisma.postGameReport.upsert({
            where: {
              externalId_teamId: {
                externalId: game.externalId,
                teamId,
              },
            },
            update: {
              status: "GENERATING",
              gameDate: game.gameDate,
              error: null,
            },
            create: {
              externalId: game.externalId,
              teamId,
              gameDate: game.gameDate,
              status: "GENERATING",
            },
          });

          try {
            const facts = await fetchPostGameFacts({
              externalId: game.externalId,
              teamId,
              opponentTeamId,
              myScore,
              oppScore,
            });
            const report = await generatePostGameReport({
              teamId,
              tone,
              facts,
            });
            await prisma.postGameReport.update({
              where: {
                externalId_teamId: {
                  externalId: game.externalId,
                  teamId,
                },
              },
              data: {
                status: "READY",
                title: report.title,
                bodyLines: report.lines as Prisma.InputJsonValue,
                facts: facts as unknown as Prisma.InputJsonValue,
                generatedAt: new Date(),
                error: null,
              },
            });
            reportReady += 1;
          } catch (error) {
            await prisma.postGameReport.update({
              where: {
                externalId_teamId: {
                  externalId: game.externalId,
                  teamId,
                },
              },
              data: {
                status: "FAILED",
                error: (error as Error).message.slice(0, 400),
              },
            });
            reportFailed += 1;
          }
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
      reportQueued,
      reportReady,
      reportFailed,
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
        reportQueued,
        reportReady,
        reportFailed,
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
        reportQueued,
        reportReady,
        reportFailed,
        pushSent,
        disabled,
        inboxCreated,
        errors: errors + 1,
        failedGameIds,
      },
      { status: 500 }
    );
  } finally {
    if (lockAcquired) {
      await releaseCheckScoreLock();
    }
  }
}
