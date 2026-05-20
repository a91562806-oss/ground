import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isKboRegularOffDay, todayKstDate } from "@/lib/kbo";
import { finishCronRun, startCronRun } from "@/lib/cronRunLogger";
import { shouldSkipCronInAlpha } from "@/lib/appEnv";
import { fetchLiveScoreSnapshot } from "@/lib/score/snapshot";
import { releaseCheckScoreLock, tryAcquireCheckScoreLock } from "@/lib/score/lock";
import { loadMockSnapshotWithOverrides, readScoreCronDevOverrides } from "@/lib/score/devOverrides";
import { sendCancelAlerts } from "@/lib/score/cancelAlert";
import { dispatchScoreAlertsForGame } from "@/lib/score/scoreAlert";
import { authorizeCron } from "@/services/notificationService";
import { isKboGameHour } from "@/lib/cronGuard";
import type { LiveScoreGame } from "@/lib/score/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * 점수 변동 cron — 6대 알림 시스템 중 "스코어 알림" 책임만 담당.
 *
 *  - 라이브 이벤트(투수교체/탈삼진) → `/api/cron/live-events`
 *  - 경기 종료 한줄평/리뷰     → `/api/cron/postgame`
 *  - 하이라이트                 → `/api/cron/check-highlight`
 *  - 우천/취소 1차 발송         → `/api/cron/preview` (1시간 전 트리거)
 *
 * 이 cron 은 위 라우트들의 fallback / 보강 역할로 다음을 처리한다:
 *   1) 스냅샷 fetch + DB upsert (모든 cron 의 입력 데이터)
 *   2) 점수 변동 감지 → `dispatchScoreAlertsForGame`
 *   3) 경기가 종료 상태로 전환된 순간 `endedAt` 만 갱신 (postgame cron 이 알아서 발송)
 *   4) preview cron 시간이 지난 뒤 발생한 취소 → `sendCancelAlerts` 로 fallback 발송
 */

type RouteSummary = {
  fastMode: boolean;
  checked: number;
  changed: number;
  llmCalls: number;
  cancelSent: number;
  pushSent: number;
  disabled: number;
  inboxCreated: number;
  errors: number;
  failedGameIds: string[];
  snapshotCount: number;
  fetchError: string | null;
  triggerSource: string;
  targetDate: string;
  skipped?: string;
  clearedGames?: number;
};

function isFastMode(url: URL): boolean {
  const raw = (url.searchParams.get("fast") ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function dayRangeKst(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

async function fetchLatestPlayText(externalId: string): Promise<string | null> {
  const endpoints = [
    `https://api-gw.sports.naver.com/schedule/games/${externalId}/relay`,
    `https://api-gw.sports.naver.com/schedule/games/${externalId}/relayTexts`,
  ];
  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 900);
      const res = await fetch(endpoint, {
        headers: {
          "user-agent": "Mozilla/5.0 GroundBot/1.0",
          accept: "application/json",
          referer: "https://m.sports.naver.com/",
        },
        cache: "no-store",
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
      if (!res.ok) continue;
      const json = await res.json();
      const text = JSON.stringify(json).replace(/\s+/g, " ").trim();
      if (text.length >= 8) return text.slice(0, 600);
    } catch {
      // ignore and try next endpoint
    }
  }
  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const auth = authorizeCron(req, url);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (shouldSkipCronInAlpha(url)) {
    return NextResponse.json({ ok: true, skipped: "ALPHA_ENV_CRON_DISABLED" });
  }

  // 경기 시간대 외에는 즉시 종료 (주중 18~22:30, 주말 14~21시)
  // force=1 파라미터로 수동 트리거 시 우회 가능
  if (!isKboGameHour() && !url.searchParams.get("force")) {
    return NextResponse.json({ ok: true, skipped: "OUT_OF_GAME_HOURS" });
  }

  const fastMode = isFastMode(url);
  const targetDate = todayKstDate();
  const isOffDay = isKboRegularOffDay(targetDate);
  const triggerSource = url.searchParams.get("source") ?? "unknown";
  const dev = readScoreCronDevOverrides(url);

  const runId = await startCronRun("check-score", {
    fastMode,
    tickRaw: dev.tick,
    targetDate,
    isOffDay,
    triggerSource,
  });
  let lockAcquired = false;

  const summary: RouteSummary = {
    fastMode,
    checked: 0,
    changed: 0,
    llmCalls: 0,
    cancelSent: 0,
    pushSent: 0,
    disabled: 0,
    inboxCreated: 0,
    errors: 0,
    failedGameIds: [],
    snapshotCount: 0,
    fetchError: null,
    triggerSource,
    targetDate,
  };

  let snapshot: LiveScoreGame[] = [];

  try {
    lockAcquired = dev.bypassLock ? true : await tryAcquireCheckScoreLock();
    if (!lockAcquired) {
      summary.skipped = "OVERLAPPED_RUN";
      await finishCronRun({
        id: runId,
        status: "partial",
        summary,
        error: "overlapped run skipped by advisory lock",
      });
      return NextResponse.json({ ok: true, runId, ...summary });
    }

    if (isOffDay && dev.tick == null) {
      const { start, end } = dayRangeKst(targetDate);
      const cleared = await prisma.game.deleteMany({
        where: { gameDate: { gte: start, lt: end } },
      });
      summary.skipped = "MONDAY_OFF";
      summary.clearedGames = cleared.count;
      await finishCronRun({ id: runId, status: "success", summary });
      return NextResponse.json({ ok: true, runId, ...summary });
    }

    try {
      snapshot =
        dev.tick != null
          ? await loadMockSnapshotWithOverrides(dev)
          : await fetchLiveScoreSnapshot(targetDate);
    } catch (error) {
      summary.fetchError = (error as Error).message;
      summary.errors += 1;
      console.error("[check-score] snapshot fetch failed", error);
      snapshot = [];
    }
    summary.snapshotCount = snapshot.length;

    if (snapshot.length === 0 || snapshot.every((game) => game.status === "CANCEL")) {
      if (snapshot.length > 0) {
        for (const game of snapshot) {
          const cancelSummary = await sendCancelAlerts({ game, targetDate, origin: url.origin });
          summary.cancelSent += cancelSummary.sent;
          summary.disabled += cancelSummary.disabled;
          summary.inboxCreated += cancelSummary.inboxCreated;
        }
      }
      const { start, end } = dayRangeKst(targetDate);
      const cleared = await prisma.game.deleteMany({
        where: { gameDate: { gte: start, lt: end } },
      });
      summary.skipped = snapshot.length === 0 ? "NO_GAMES" : "ALL_CANCELLED";
      summary.clearedGames = cleared.count;
      await finishCronRun({
        id: runId,
        status: summary.fetchError ? "partial" : "success",
        summary,
        error: summary.fetchError,
      });
      return NextResponse.json({ ok: !summary.fetchError, runId, ...summary });
    }

    for (const game of snapshot) {
      summary.checked += 1;
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
            endedAt: game.status === "RESULT" ? new Date() : null,
            lastSyncedAt: new Date(),
          },
        });

        if (!previous) {
          // 새로 들어온 게임이 이미 CANCEL 상태라면 즉시 취소 알림.
          if (game.status === "CANCEL") {
            const cancelSummary = await sendCancelAlerts({ game, targetDate, origin: url.origin });
            summary.cancelSent += cancelSummary.sent;
            summary.disabled += cancelSummary.disabled;
            summary.inboxCreated += cancelSummary.inboxCreated;
          }
          continue;
        }

        const homeDelta = game.homeScore - previous.homeScore;
        const awayDelta = game.awayScore - previous.awayScore;
        const scoreChanged = homeDelta > 0 || awayDelta > 0;
        const justEnded = previous.status !== "RESULT" && game.status === "RESULT";
        const justCancelled = previous.status !== "CANCEL" && game.status === "CANCEL";

        if (justEnded) {
          await prisma.game.update({
            where: { id: updated.id },
            data: {
              endedAt: new Date(),
              highlightNotifiedAt: null,
              highlightVideoUrl: null,
              lastHighlightCheckedAt: null,
            },
          });
        }

        if (justCancelled) {
          const cancelSummary = await sendCancelAlerts({ game, targetDate, origin: url.origin });
          summary.cancelSent += cancelSummary.sent;
          summary.disabled += cancelSummary.disabled;
          summary.inboxCreated += cancelSummary.inboxCreated;
        }

        if (!scoreChanged) continue;

        const scoreDedupeKey = `score:${game.externalId}:${game.homeScore}:${game.awayScore}`;
        const alreadyNotified = await prisma.notification.findFirst({
          where: {
            type: "SCORE_UPDATE",
            createdAt: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) },
            payload: { path: ["dedupeKey"], equals: scoreDedupeKey },
          },
          select: { id: true },
        });
        if (alreadyNotified) continue;

        const scoreAlertKey = `${game.homeScore}:${game.awayScore}`;
        const dedupe = await prisma.game.updateMany({
          where: {
            id: updated.id,
            OR: [{ lastScoreAlertKey: null }, { lastScoreAlertKey: { not: scoreAlertKey } }],
          },
          data: { lastScoreAlertKey: scoreAlertKey, lastScoreAlertAt: new Date() },
        });
        if (dedupe.count === 0) continue;
        summary.changed += 1;

        const latestPlayText = fastMode
          ? `스코어 변동: ${game.homeTeam} ${game.homeScore}:${game.awayScore} ${game.awayTeam}`
          : (await fetchLatestPlayText(game.externalId)) ??
            `스코어 변동: ${game.homeTeam} ${game.homeScore}:${game.awayScore} ${game.awayTeam}`;

        const result = await dispatchScoreAlertsForGame({
          game,
          previousHomeScore: previous.homeScore,
          previousAwayScore: previous.awayScore,
          dbGameId: updated.id,
          latestPlayText,
          fastMode,
          origin: url.origin,
        });
        summary.pushSent += result.sent;
        summary.disabled += result.disabled;
        summary.inboxCreated += result.inboxCreated;
        summary.llmCalls += result.llmCalls;
      } catch (error) {
        summary.errors += 1;
        summary.failedGameIds.push(game.externalId);
        console.error("[check-score] failed for game", game.externalId, error);
      }
    }

    await finishCronRun({
      id: runId,
      status: summary.errors > 0 || summary.fetchError ? "partial" : "success",
      summary,
      error: summary.fetchError,
    });
    return NextResponse.json({
      ok: summary.errors === 0 && !summary.fetchError,
      runId,
      ...summary,
    });
  } catch (error) {
    const message = (error as Error).message;
    summary.errors += 1;
    await finishCronRun({ id: runId, status: "error", summary, error: message });
    return NextResponse.json({ ok: false, runId, error: message, ...summary }, { status: 500 });
  } finally {
    if (lockAcquired) {
      await releaseCheckScoreLock();
    }
  }
}
