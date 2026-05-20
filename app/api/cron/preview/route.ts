import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findTeam } from "@/lib/teams";
import { fetchKboSchedule, todayKstDate, type LiveGame } from "@/lib/kbo";
import { fetchPregameNewsContext, generatePregamePreview } from "@/lib/pregamePreview";
import { shouldSkipCronInAlpha } from "@/lib/appEnv";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  authorizeCron,
  markDispatchOnce,
  minutesUntil,
  sendTeamTopicNotification,
  toKstDateTime,
} from "@/services/notificationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 경기 프리뷰 cron
 *  - 경기 1시간 전(45~75분 윈도우) 트리거
 *  - 각 팀별로 LLM 매운맛 프리뷰를 생성해 DB(`PregamePreview`)에 저장 (Today 탭 모달용)
 *  - 동일 게임이 취소(특히 우천취소)된 경우, 프리뷰 대신 취소 알림을 발송 (별도 토글 없음)
 *  - 정상 게임은 `pitcher` 토픽으로 푸시 발송 (`markDispatchOnce` 로 exactly-once)
 *
 * 디버그용 query:
 *   - `force=1`     — 시간 윈도우 무시
 *   - `teamId=...`  — 특정 팀만 처리
 */

type PreviewJob = {
  game: LiveGame;
  teamId: string;
  opponentTeamId: string;
};

function buildGameCancelCopy(input: {
  game: LiveGame;
  fanTeamId: string;
}): { title: string; body: string } {
  const isHomeFan = input.fanTeamId === input.game.homeId;
  const myTeam = findTeam(input.fanTeamId);
  const oppTeam = findTeam(isHomeFan ? input.game.awayId : input.game.homeId);
  const cancelLabel = input.game.cancelReason === "RAIN" ? "우천취소" : "경기 취소";
  const bodyReason =
    input.game.cancelReason === "RAIN"
      ? `오늘 ${oppTeam.short}전 우천취소.`
      : `오늘 ${oppTeam.short}전 취소.`;
  return {
    title: `🌧️ ${myTeam.short} ${cancelLabel}`,
    body: `${bodyReason} 로테이션은 아끼고 내일 제대로 가자.`,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const auth = authorizeCron(req, url);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (shouldSkipCronInAlpha(url)) {
    return NextResponse.json({ ok: true, skipped: "ALPHA_ENV_CRON_DISABLED" });
  }

  const force = url.searchParams.get("force") === "1";
  const teamFilter = (url.searchParams.get("teamId") ?? "").trim().toLowerCase();
  const date = todayKstDate();
  const schedule = await fetchKboSchedule(date);
  const todays = schedule.today;

  const jobs: PreviewJob[] = [];
  const cancelJobs: PreviewJob[] = [];

  for (const game of todays) {
    const inTimeWindow = (() => {
      if (force) return true;
      const dt = toKstDateTime(date, game.time);
      if (!dt) return false;
      const mins = minutesUntil(dt);
      return mins >= 45 && mins <= 75;
    })();
    if (!inTimeWindow) continue;

    for (const teamId of [game.homeId, game.awayId]) {
      if (teamFilter && teamId !== teamFilter) continue;
      const opponentTeamId = teamId === game.homeId ? game.awayId : game.homeId;
      if (game.status === "CANCEL") {
        cancelJobs.push({ game, teamId, opponentTeamId });
      } else if (game.status === "BEFORE") {
        jobs.push({ game, teamId, opponentTeamId });
      }
    }
  }

  let previewSent = 0;
  let previewSkipped = 0;
  let previewFailed = 0;
  let cancelSent = 0;
  let cancelSkipped = 0;

  await mapWithConcurrency(cancelJobs, 4, async ({ game, teamId }) => {
    const lock = await markDispatchOnce({
      alertKind: "cancel",
      teamScope: teamId,
      eventKey: `${date}:${game.id}:cancel`,
      gameExternalId: game.id,
    });
    if (!lock) {
      cancelSkipped += 1;
      return;
    }
    const copy = buildGameCancelCopy({ game, fanTeamId: teamId });
    const result = await sendTeamTopicNotification({
      teamId,
      topicKey: "pitcher",
      title: copy.title,
      body: copy.body,
      url: "/today",
      payload: {
        kind: "game-cancel",
        gameId: game.id,
        teamId,
        cancelReason: game.cancelReason ?? "OTHER",
      },
      type: "SYSTEM",
      origin: url.origin,
    });
    cancelSent += result.sent;
  });

  await mapWithConcurrency(jobs, 2, async ({ game, teamId, opponentTeamId }) => {
    await prisma.pregamePreview.upsert({
      where: { date_teamId: { date, teamId } },
      update: {
        gameId: game.id,
        opponentTeamId,
        gameTime: game.time,
        stadium: game.stadium,
        status: "PENDING",
        error: null,
      },
      create: {
        date,
        teamId,
        gameId: game.id,
        opponentTeamId,
        gameTime: game.time,
        stadium: game.stadium,
        status: "PENDING",
      },
    });

    let preview: Awaited<ReturnType<typeof generatePregamePreview>> | null = null;
    try {
      const recentGames = schedule.past
        .filter((pastGame) => pastGame.homeId === teamId || pastGame.awayId === teamId)
        .slice(-5);
      const newsContext = await fetchPregameNewsContext({
        gameId: game.id,
        teamId,
        opponentTeamId,
      });
      preview = await generatePregamePreview({
        date,
        game,
        teamId,
        opponentTeamId,
        recentGames,
        newsContext,
      });
      await prisma.pregamePreview.update({
        where: { date_teamId: { date, teamId } },
        data: {
          status: "READY",
          title: preview.title,
          bodyLines: preview.lines,
          context: preview.context,
          generatedAt: new Date(),
          error: null,
        },
      });
    } catch (error) {
      await prisma.pregamePreview.update({
        where: { date_teamId: { date, teamId } },
        data: {
          status: "FAILED",
          error: (error as Error).message.slice(0, 400),
        },
      });
      previewFailed += 1;
      return;
    }

    const lock = await markDispatchOnce({
      alertKind: "preview",
      teamScope: teamId,
      eventKey: `${date}:${game.id}:preview`,
      gameExternalId: game.id,
    });
    if (!lock) {
      previewSkipped += 1;
      return;
    }

    const body = preview.lines.slice(0, 2).join(" ");
    const result = await sendTeamTopicNotification({
      teamId,
      topicKey: "pitcher",
      title: preview.title,
      body,
      url: "/today",
      payload: {
        kind: "preview",
        gameId: game.id,
        teamId,
        opponentTeamId,
        source: preview.source,
        lines: preview.lines,
      },
      type: "SYSTEM",
      origin: url.origin,
    });
    previewSent += result.sent;
  });

  return NextResponse.json({
    ok: true,
    date,
    todays: todays.length,
    previewSent,
    previewSkipped,
    previewFailed,
    cancelSent,
    cancelSkipped,
  });
}
