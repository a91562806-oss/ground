import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findTeam } from "@/lib/teams";
import { fetchKboSchedule, todayKstDate } from "@/lib/kbo";
import {
  fetchPostGameFacts,
  generatePostGameReport,
  type PostGameFacts,
} from "@/lib/postGameReport";
import { isAlphaServerEnv, shouldSkipCronInAlpha } from "@/lib/appEnv";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  authorizeCron,
  markDispatchOnce,
  sendTeamTopicNotification,
} from "@/services/notificationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 경기 결과(매운맛 한줄평 + 본문) cron.
 * - 일반 운영: 오늘 RESULT 상태 게임을 양 팀 단위로 LLM 리포트 생성 + push 발송.
 * - alpha 한정 mock 모드 (`mock=1`): 실 네이버 데이터 없이 강제 시나리오로 동일 흐름을 돌릴 수 있다.
 *     모든 mock 파라미터는 `isAlphaServerEnv()` 가 true 일 때만 적용된다.
 */

type PostgameJob = {
  externalId: string;
  teamId: string;
  opponentTeamId: string;
  myScore: number;
  oppScore: number;
  mySide: "home" | "away";
  facts: PostGameFacts | null; // mock 모드면 사전 생성, 일반이면 null → fetch.
};

type MockPostgameOverrides = {
  teamId: string;
  opponentTeamId: string;
  myScore: number;
  oppScore: number;
  myHits: number | null;
  oppHits: number | null;
  myErrors: number | null;
  oppErrors: number | null;
  myHomeRuns: number | null;
  oppHomeRuns: number | null;
  externalId: string;
  bothTeams: boolean;
};

function nullableInt(raw: string | null, fallback: number | null): number | null {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function readIntWithDefault(raw: string | null, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function resolveTone(myScore: number, oppScore: number): "win" | "loss" | "draw" {
  if (myScore > oppScore) return "win";
  if (myScore < oppScore) return "loss";
  return "draw";
}

function readMockOverrides(url: URL): MockPostgameOverrides | null {
  if (url.searchParams.get("mock") !== "1") return null;
  if (!isAlphaServerEnv()) return null;

  const teamId = (url.searchParams.get("teamId") ?? "lg").trim().toLowerCase();
  const opponentTeamId = (url.searchParams.get("opponentTeamId") ?? "kia").trim().toLowerCase();
  const myScore = readIntWithDefault(url.searchParams.get("myScore"), 0);
  const oppScore = readIntWithDefault(url.searchParams.get("oppScore"), 14);
  return {
    teamId,
    opponentTeamId,
    myScore,
    oppScore,
    myHits: nullableInt(url.searchParams.get("myHits"), 2),
    oppHits: nullableInt(url.searchParams.get("oppHits"), 14),
    myErrors: nullableInt(url.searchParams.get("myErrors"), 3),
    oppErrors: nullableInt(url.searchParams.get("oppErrors"), 0),
    myHomeRuns: nullableInt(url.searchParams.get("myHomeRuns"), 0),
    oppHomeRuns: nullableInt(url.searchParams.get("oppHomeRuns"), 2),
    externalId:
      (url.searchParams.get("mockGameId") ?? "").trim() || `alpha-mock-${Date.now()}`,
    bothTeams: url.searchParams.get("bothTeams") !== "0",
  };
}

function buildMockFacts(input: {
  teamId: string;
  opponentTeamId: string;
  externalId: string;
  myScore: number;
  oppScore: number;
  myHits: number | null;
  oppHits: number | null;
  myErrors: number | null;
  oppErrors: number | null;
  myHomeRuns: number | null;
  oppHomeRuns: number | null;
}): PostGameFacts {
  return {
    externalId: input.externalId,
    myTeam: findTeam(input.teamId).short,
    oppTeam: findTeam(input.opponentTeamId).short,
    myScore: input.myScore,
    oppScore: input.oppScore,
    myHits: input.myHits,
    oppHits: input.oppHits,
    myErrors: input.myErrors,
    oppErrors: input.oppErrors,
    myHomeRuns: input.myHomeRuns,
    oppHomeRuns: input.oppHomeRuns,
    winningPitcher: null,
    losingPitcher: null,
    savePitcher: null,
    clutchHit: null,
    homeRun: null,
    error: null,
    notable: [],
  };
}

function buildMockJobs(mock: MockPostgameOverrides): PostgameJob[] {
  const primary: PostgameJob = {
    externalId: mock.externalId,
    teamId: mock.teamId,
    opponentTeamId: mock.opponentTeamId,
    myScore: mock.myScore,
    oppScore: mock.oppScore,
    mySide: "home",
    facts: buildMockFacts({
      teamId: mock.teamId,
      opponentTeamId: mock.opponentTeamId,
      externalId: mock.externalId,
      myScore: mock.myScore,
      oppScore: mock.oppScore,
      myHits: mock.myHits,
      oppHits: mock.oppHits,
      myErrors: mock.myErrors,
      oppErrors: mock.oppErrors,
      myHomeRuns: mock.myHomeRuns,
      oppHomeRuns: mock.oppHomeRuns,
    }),
  };
  if (!mock.bothTeams) return [primary];

  const opposite: PostgameJob = {
    externalId: mock.externalId,
    teamId: mock.opponentTeamId,
    opponentTeamId: mock.teamId,
    myScore: mock.oppScore,
    oppScore: mock.myScore,
    mySide: "away",
    facts: buildMockFacts({
      teamId: mock.opponentTeamId,
      opponentTeamId: mock.teamId,
      externalId: mock.externalId,
      myScore: mock.oppScore,
      oppScore: mock.myScore,
      myHits: mock.oppHits,
      oppHits: mock.myHits,
      myErrors: mock.oppErrors,
      oppErrors: mock.myErrors,
      myHomeRuns: mock.oppHomeRuns,
      oppHomeRuns: mock.myHomeRuns,
    }),
  };
  return [primary, opposite];
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const auth = authorizeCron(req, url);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (shouldSkipCronInAlpha(url)) return NextResponse.json({ ok: true, skipped: "ALPHA_ENV_CRON_DISABLED" });

  const force = url.searchParams.get("force") === "1";
  const teamFilter = (url.searchParams.get("teamId") ?? "").trim().toLowerCase();
  const date = todayKstDate();
  const mock = readMockOverrides(url);

  let jobs: PostgameJob[];
  if (mock) {
    jobs = buildMockJobs(mock);
  } else {
    const schedule = await fetchKboSchedule(date);
    const games = schedule.today.filter((g) => g.status === "RESULT" && g.result);
    jobs = [];
    for (const game of games) {
      for (const teamId of [game.homeId, game.awayId]) {
        if (teamFilter && teamId !== teamFilter) continue;
        const isHomeFan = teamId === game.homeId;
        jobs.push({
          externalId: game.id,
          teamId,
          opponentTeamId: isHomeFan ? game.awayId : game.homeId,
          myScore: isHomeFan ? game.result!.homeScore : game.result!.awayScore,
          oppScore: isHomeFan ? game.result!.awayScore : game.result!.homeScore,
          mySide: isHomeFan ? "home" : "away",
          facts: null,
        });
      }
    }
  }

  let generated = 0;
  let sent = 0;
  let skipped = 0;
  await mapWithConcurrency(jobs, 2, async (job) => {
    const lock = await markDispatchOnce({
      alertKind: "postgame",
      teamScope: job.teamId,
      eventKey: `${date}:${job.externalId}:postgame`,
      gameExternalId: job.externalId,
    });
    if (!lock && !force) {
      skipped += 1;
      return;
    }
    const facts =
      job.facts ??
      (await fetchPostGameFacts({
        externalId: job.externalId,
        teamId: job.teamId,
        opponentTeamId: job.opponentTeamId,
        myScore: job.myScore,
        oppScore: job.oppScore,
        mySide: job.mySide,
      }));
    const report = await generatePostGameReport({
      teamId: job.teamId,
      tone: resolveTone(job.myScore, job.oppScore),
      facts,
    });
    await prisma.postGameReport.upsert({
      where: { externalId_teamId: { externalId: job.externalId, teamId: job.teamId } },
      create: {
        externalId: job.externalId,
        teamId: job.teamId,
        gameDate: new Date(`${date}T00:00:00+09:00`),
        status: "READY",
        title: report.headline,
        content: report.content,
        bodyLines: [report.content],
        facts: facts as never,
        generatedAt: new Date(),
        error: null,
      },
      update: {
        status: "READY",
        title: report.headline,
        content: report.content,
        bodyLines: [report.content],
        facts: facts as never,
        generatedAt: new Date(),
        error: null,
      },
    });
    generated += 1;

    const push = await sendTeamTopicNotification({
      teamId: job.teamId,
      topicKey: "postGame",
      title: report.headline,
      body: report.content,
      url: "/today",
      payload: {
        kind: "postgame",
        gameId: job.externalId,
        teamId: job.teamId,
        opponentTeamId: job.opponentTeamId,
        facts,
      },
      type: "GAME_RESULT",
      origin: url.origin,
    });
    sent += push.sent;
  });

  return NextResponse.json({
    ok: true,
    date,
    mock: Boolean(mock),
    jobs: jobs.length,
    generated,
    sent,
    skipped,
  });
}
