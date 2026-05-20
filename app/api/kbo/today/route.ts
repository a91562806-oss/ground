import { NextResponse } from "next/server";
import {
  fetchKboSchedule,
  fetchKboStandings,
  resolveTodayFeedMessage,
  resolveTodayFeedStatus,
  todayKstDate,
} from "@/lib/kbo";
import { generateTodayStatusMessageWithLlm } from "@/lib/todayStatusLlm";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isPregamePreviewWindow(date: string, now = new Date()): boolean {
  const start = Date.parse(`${date}T17:30:00+09:00`);
  const end = Date.parse(`${date}T18:30:00+09:00`);
  const ms = now.getTime();
  return Number.isFinite(start) && Number.isFinite(end) && ms >= start && ms < end;
}

function postGameVisibleUntilKst(gameDate: Date): Date {
  const dateKst = gameDate.toISOString().slice(0, 10);
  const visibleUntilMs = Date.parse(`${dateKst}T12:00:00+09:00`) + 24 * 60 * 60 * 1000;
  return new Date(visibleUntilMs);
}

function isPostGameWindowActive(gameDate: Date, now = new Date()): boolean {
  return now.getTime() <= postGameVisibleUntilKst(gameDate).getTime();
}

/**
 * GET /api/kbo/today
 *   { date, status, message, games[], standings[], fallback }
 *
 * Today 탭은 Schedule 소스와 동일한 today 배열을 사용해 탭 간 데이터 정합성을 유지한다.
 * withStandings=0 이면 standings 계산을 생략해 로딩 지연을 줄인다.
 * 월요일/우천취소 상태 문구는 LLM 우선 생성 후, 실패 시 즉시 폴백 문구를 반환한다.
 */
export async function GET(req: Request) {
  const date = todayKstDate();
  const search = new URL(req.url).searchParams;
  const teamId = search.get("teamId");
  const withStandings = search.get("withStandings") !== "0";
  try {
    const schedule = await fetchKboSchedule(date);
    const standings = withStandings ? await fetchKboStandings() : [];
    const games = schedule.today;
    const teamGame = teamId
      ? games.find((game) => game.homeId === teamId || game.awayId === teamId) ?? null
      : null;
    const gamePhase =
      teamGame == null
        ? "NONE"
        : teamGame.status === "RESULT"
          ? "END"
          : teamGame.status === "LIVE"
            ? "LIVE"
            : "PRE";
    const status = resolveTodayFeedStatus(date, games);
    const fallback = resolveTodayFeedMessage(status);
    const message = fallback
      ? await generateTodayStatusMessageWithLlm({
          status,
          fallback,
          teamId,
        })
      : null;

    let postGameReport: {
      status: "PENDING" | "GENERATING" | "READY" | "FAILED";
      headline: string | null;
      content: string | null;
      active: boolean;
      visibleUntil: string | null;
      generatedAt: string | null;
    } | null = null;
    let pregamePreview: {
      status: "PENDING" | "READY" | "FAILED";
      title: string | null;
      lines: string[];
      active: boolean;
      generatedAt: string | null;
    } | null = null;

    if (teamId && teamGame?.status === "RESULT") {
      const report = await prisma.postGameReport.findUnique({
        where: {
          externalId_teamId: {
            externalId: teamGame.id,
            teamId,
          },
        },
        select: {
          status: true,
          gameDate: true,
          title: true,
          content: true,
          bodyLines: true,
          generatedAt: true,
        },
      });
      if (report) {
        const fallbackContent = Array.isArray(report.bodyLines)
          ? report.bodyLines.filter((line): line is string => typeof line === "string").join(" ")
          : null;
        postGameReport = {
          status: report.status,
          headline: report.title,
          content: report.content ?? fallbackContent,
          active: report.gameDate ? isPostGameWindowActive(report.gameDate) : true,
          visibleUntil: report.gameDate ? postGameVisibleUntilKst(report.gameDate).toISOString() : null,
          generatedAt: report.generatedAt ? report.generatedAt.toISOString() : null,
        };
      }
    }

    if (teamId && !postGameReport) {
      const latest = await prisma.postGameReport.findFirst({
        where: {
          teamId,
          status: "READY",
        },
        orderBy: [{ gameDate: "desc" }, { generatedAt: "desc" }],
        select: {
          status: true,
          gameDate: true,
          title: true,
          content: true,
          bodyLines: true,
          generatedAt: true,
        },
      });
      if (latest?.gameDate && isPostGameWindowActive(latest.gameDate)) {
        const fallbackContent = Array.isArray(latest.bodyLines)
          ? latest.bodyLines.filter((line): line is string => typeof line === "string").join(" ")
          : null;
        postGameReport = {
          status: latest.status,
          headline: latest.title,
          content: latest.content ?? fallbackContent,
          active: true,
          visibleUntil: postGameVisibleUntilKst(latest.gameDate).toISOString(),
          generatedAt: latest.generatedAt ? latest.generatedAt.toISOString() : null,
        };
      }
    }

    if (teamId && teamGame?.status === "BEFORE") {
      const row = await prisma.pregamePreview.findUnique({
        where: { date_teamId: { date, teamId } },
        select: {
          status: true,
          title: true,
          bodyLines: true,
          generatedAt: true,
        },
      });
      if (row) {
        pregamePreview = {
          status: row.status,
          title: row.title,
          lines: Array.isArray(row.bodyLines)
            ? row.bodyLines.filter((line): line is string => typeof line === "string")
            : [],
          active: isPregamePreviewWindow(date),
          generatedAt: row.generatedAt ? row.generatedAt.toISOString() : null,
        };
      }
    }

    return NextResponse.json({
      date,
      status,
      gamePhase,
      message,
      games,
      standings,
      pregamePreview,
      postGameReport,
      fallback: schedule.fallback,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: (err as Error).message,
        date,
        status: "NO_GAMES",
        gamePhase: "NONE",
        message: resolveTodayFeedMessage("NO_GAMES"),
        games: [],
        standings: [],
        pregamePreview: null,
        postGameReport: null,
      },
      { status: 500 }
    );
  }
}
