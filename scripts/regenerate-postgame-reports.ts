import path from "node:path";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ path: path.resolve(process.cwd(), ".env.local") });
dotenvConfig({ path: path.resolve(process.cwd(), ".env") });

function usage() {
  console.log("Usage: npx tsx scripts/regenerate-postgame-reports.ts [--date=YYYY-MM-DD] [--team=TEAM_ID]");
}

function getArg(name: string): string | null {
  const hit = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.split("=", 2)[1] ?? null : null;
}

async function main() {
  const [{ prisma }, { fetchKboSchedule, todayKstDate }, { fetchPostGameFacts, generatePostGameReport }] =
    await Promise.all([import("@/lib/prisma"), import("@/lib/kbo"), import("@/lib/postGameReport")]);
  const date = getArg("--date") ?? todayKstDate();
  const teamFilter = getArg("--team");

  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error(
      "ANTHROPIC_API_KEY not found. Put it in .env.local or export it before running this script."
    );
  }

  const schedule = await fetchKboSchedule(date);
  const ended = schedule.today.filter((g) => g.status === "RESULT" && g.result);
  if (ended.length === 0) {
    console.log(`[postgame-regenerate] no RESULT games on ${date}`);
    return;
  }

  let updated = 0;
  for (const g of ended) {
    const homeScore = g.result?.homeScore ?? 0;
    const awayScore = g.result?.awayScore ?? 0;
    const jobs = [
      { teamId: g.homeId, oppId: g.awayId, myScore: homeScore, oppScore: awayScore, mySide: "home" as const },
      { teamId: g.awayId, oppId: g.homeId, myScore: awayScore, oppScore: homeScore, mySide: "away" as const },
    ].filter((job) => !teamFilter || job.teamId === teamFilter);

    for (const job of jobs) {
      const tone = job.myScore > job.oppScore ? "win" : job.myScore < job.oppScore ? "loss" : "draw";
      const facts = await fetchPostGameFacts({
        externalId: g.id,
        teamId: job.teamId,
        opponentTeamId: job.oppId,
        myScore: job.myScore,
        oppScore: job.oppScore,
        mySide: job.mySide,
      });
      const report = await generatePostGameReport({
        teamId: job.teamId,
        tone,
        facts,
        strictLlm: true,
      });

      await prisma.postGameReport.upsert({
        where: { externalId_teamId: { externalId: g.id, teamId: job.teamId } },
        create: {
          externalId: g.id,
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
      updated += 1;
      console.log(`[postgame-regenerate] ${g.id} ${job.teamId} -> ${report.headline}`);
    }
  }

  console.log(`[postgame-regenerate] done date=${date} updated=${updated}`);
}

void main()
  .catch((error) => {
    console.error("[postgame-regenerate] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("@/lib/prisma");
    await prisma.$disconnect();
  });
