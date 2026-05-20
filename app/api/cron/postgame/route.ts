import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchKboSchedule, todayKstDate } from "@/lib/kbo";
import { fetchPostGameFacts, generatePostGameReport } from "@/lib/postGameReport";
import { shouldSkipCronInAlpha } from "@/lib/appEnv";
import { authorizeCron, markDispatchOnce, sendTeamTopicNotification } from "@/services/notificationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) break;
      out[i] = await mapper(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function resolveTone(myScore: number, oppScore: number): "win" | "loss" | "draw" {
  if (myScore > oppScore) return "win";
  if (myScore < oppScore) return "loss";
  return "draw";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const auth = authorizeCron(req, url);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (shouldSkipCronInAlpha(url)) return NextResponse.json({ ok: true, skipped: "ALPHA_ENV_CRON_DISABLED" });

  const force = url.searchParams.get("force") === "1";
  const teamFilter = (url.searchParams.get("teamId") ?? "").trim().toLowerCase();
  const date = todayKstDate();
  const schedule = await fetchKboSchedule(date);
  const games = schedule.today.filter((g) => g.status === "RESULT" && g.result);
  let generated = 0;
  let sent = 0;
  let skipped = 0;
  const jobs: Array<{ game: (typeof games)[number]; teamId: string }> = [];
  for (const game of games) {
    for (const teamId of [game.homeId, game.awayId]) {
      if (teamFilter && teamId !== teamFilter) continue;
      jobs.push({ game, teamId });
    }
  }
  await mapWithConcurrency(jobs, 2, async ({ game, teamId }) => {
      const lock = await markDispatchOnce({
        alertKind: "postgame",
        teamScope: teamId,
        eventKey: `${date}:${game.id}:postgame`,
        gameExternalId: game.id,
      });
      if (!lock && !force) {
        skipped += 1;
        return;
      }
      const isHomeFan = teamId === game.homeId;
      const opponentTeamId = isHomeFan ? game.awayId : game.homeId;
      const myScore = isHomeFan ? game.result!.homeScore : game.result!.awayScore;
      const oppScore = isHomeFan ? game.result!.awayScore : game.result!.homeScore;
      const facts = await fetchPostGameFacts({
        externalId: game.id,
        teamId,
        opponentTeamId,
        myScore,
        oppScore,
        mySide: isHomeFan ? "home" : "away",
      });
      const report = await generatePostGameReport({
        teamId,
        tone: resolveTone(myScore, oppScore),
        facts,
      });
      await prisma.postGameReport.upsert({
        where: { externalId_teamId: { externalId: game.id, teamId } },
        create: {
          externalId: game.id,
          teamId,
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
        teamId,
        topicKey: "postGame",
        title: report.headline,
        body: report.content,
        url: "/today",
        payload: {
          kind: "postgame",
          gameId: game.id,
          teamId,
          opponentTeamId,
          facts,
        },
        type: "GAME_RESULT",
        origin: url.origin,
      });
      sent += push.sent;
  });
  return NextResponse.json({ ok: true, date, games: games.length, generated, sent, skipped });
}
