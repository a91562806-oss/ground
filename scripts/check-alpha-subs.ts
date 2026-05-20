import { prisma } from "../lib/prisma";

async function main() {
  const teamId = process.argv[2] ?? null;
  const subs = await prisma.pushSubscription.findMany({
    where: {
      enabled: true,
      ...(teamId ? { user: { favoriteTeam: teamId } } : {}),
    },
    select: {
      id: true,
      userId: true,
      topics: true,
      updatedAt: true,
      endpoint: true,
      user: { select: { favoriteTeam: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });

  console.log(`\nactive subscriptions (top 20 by updatedAt): ${subs.length}\n`);
  for (const s of subs) {
    const t = (s.topics ?? {}) as Record<string, unknown>;
    const ep = s.endpoint.length > 80 ? s.endpoint.slice(0, 80) + "…" : s.endpoint;
    console.log({
      userId: s.userId.slice(0, 8),
      team: s.user.favoriteTeam,
      updatedAt: s.updatedAt.toISOString(),
      appEnv: t.appEnv,
      postGame: t.postGame,
      score: t.score,
      pitcher: t.pitcher,
      preview: t.preview,
      gameStart: t.gameStart,
      liveEvents: t.liveEvents,
      highlight: t.highlight,
      endpoint: ep,
    });
  }

  const groups = await prisma.pushSubscription.groupBy({
    by: ["enabled"],
    _count: { _all: true },
  });
  console.log("\nenabled distribution:", groups);

  const teamCounts = await prisma.user.groupBy({
    by: ["favoriteTeam"],
    where: { favoriteTeam: { not: null }, pushSubscriptions: { some: { enabled: true } } },
    _count: { _all: true },
  });
  console.log("\nactive subscribers per team:", teamCounts);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(() => prisma.$disconnect());
