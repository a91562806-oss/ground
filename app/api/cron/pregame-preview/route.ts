import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchKboSchedule, todayKstDate } from "@/lib/kbo";
import { fetchPregameNewsContext, generatePregamePreview } from "@/lib/pregamePreview";
import { shouldSkipCronInAlpha } from "@/lib/appEnv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(req: Request, url: URL): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  const querySecret = url.searchParams.get("secret");
  return auth === `Bearer ${secret}` || querySecret === secret;
}

function isWeekdayKst(date: string): boolean {
  const [y, m, d] = date.split("-").map((v) => Number.parseInt(v, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  const dow = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
  return dow >= 1 && dow <= 5;
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

  const date = todayKstDate();
  const force = url.searchParams.get("force") === "1";
  if (!force && !isWeekdayKst(date)) {
    return NextResponse.json({
      ok: true,
      skipped: "WEEKEND",
      date,
      generated: 0,
    });
  }

  const schedule = await fetchKboSchedule(date);
  const targetGames = schedule.today.filter(
    (game) => game.status !== "RESULT" && game.status !== "CANCEL"
  );

  let generated = 0;
  let failed = 0;
  let skipped = 0;

  for (const game of targetGames) {
    for (const teamId of [game.homeId, game.awayId]) {
      const opponentTeamId = teamId === game.homeId ? game.awayId : game.homeId;
      const existing = await prisma.pregamePreview.findUnique({
        where: { date_teamId: { date, teamId } },
        select: { status: true },
      });
      if (existing?.status === "READY" && !force) {
        skipped += 1;
        continue;
      }

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

      try {
        const recentGames = schedule.past
          .filter((pastGame) => pastGame.homeId === teamId || pastGame.awayId === teamId)
          .slice(-5);
        const newsContext = await fetchPregameNewsContext({
          gameId: game.id,
          teamId,
          opponentTeamId,
        });
        const preview = await generatePregamePreview({
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
        generated += 1;
      } catch (error) {
        await prisma.pregamePreview.update({
          where: { date_teamId: { date, teamId } },
          data: {
            status: "FAILED",
            error: (error as Error).message.slice(0, 400),
          },
        });
        failed += 1;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    date,
    targetGames: targetGames.length,
    generated,
    failed,
    skipped,
  });
}
