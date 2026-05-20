import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { findTeam, TEAMS } from "@/lib/teams";
import PendingNotificationsSection from "./PendingNotificationsSection";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "GROUND · Admin Dashboard",
  description: "MVP traction dashboard for push subscription funnel.",
};

type SearchParamsInput =
  | Record<string, string | string[] | undefined>
  | Promise<Record<string, string | string[] | undefined>>;

type Props = {
  searchParams?: SearchParamsInput;
};

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function startOfTodayKst(now = new Date()): Date {
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const kst = new Date(utcMs + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();
  return new Date(Date.UTC(y, m, d, -9, 0, 0, 0));
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("ko-KR").format(n);
}

function formatDateTimeKst(date: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function resolveTeamLabel(teamId: string | null): string {
  if (!teamId) return "팀 미지정";
  const team = TEAMS.find((item) => item.id === teamId);
  return team ? team.name : teamId.toUpperCase();
}

type RankingRow = {
  rank: number;
  teamId: string;
  label: string;
  short: string;
  accent: string;
  count: number;
  ratio: number;
};

export default async function AdminDashboardPage({ searchParams }: Props) {
  const params = await Promise.resolve(searchParams ?? {});
  const key = firstParam(params.key);
  const expected = process.env.ADMIN_SECRET ?? process.env.ADMIN_PASSWORD;
  if (!expected || !key || key !== expected) notFound();
  const db = prisma as any;

  const todayStart = startOfTodayKst();

  const [totalUsers, teamRows, todaysTriggers, todayNotifications, pendingNotifications] = await Promise.all([
    db.user.count({
      where: {
        pushSubscriptions: {
          some: { enabled: true },
        },
      },
    }),
    db.user.groupBy({
      by: ["favoriteTeam"],
      where: {
        favoriteTeam: { not: null },
        pushSubscriptions: {
          some: { enabled: true },
        },
      },
      _count: { _all: true },
      orderBy: { _count: { favoriteTeam: "desc" } },
      take: 10,
    }),
    db.notification.count({
      where: {
        sentAt: { gte: todayStart },
      },
    }),
    db.notification.findMany({
      where: {
        sentAt: { gte: todayStart },
      },
      orderBy: {
        sentAt: "desc",
      },
      select: {
        id: true,
        userId: true,
        type: true,
        title: true,
        body: true,
        sentAt: true,
        createdAt: true,
        user: {
          select: {
            favoriteTeam: true,
          },
        },
      },
      take: 3000,
    }),
    db.pendingPushNotification.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        teamId: true,
        topicKey: true,
        title: true,
        body: true,
        url: true,
        type: true,
        status: true,
        createdAt: true,
      },
    }),
  ]);

  const maxCount = teamRows[0]?._count._all ?? 1;
  const ranking: RankingRow[] = teamRows.map((row: any, idx: number): RankingRow => {
    const teamId = row.favoriteTeam ?? "unknown";
    const team = teamId === "unknown" ? null : findTeam(teamId);
    const count = row._count._all;
    const ratio = Math.max(6, Math.round((count / maxCount) * 100));
    return {
      rank: idx + 1,
      teamId,
      label: team ? team.name : teamId,
      short: team ? team.short : teamId.toUpperCase(),
      accent: team ? team.accent : "#888888",
      count,
      ratio,
    };
  });

  const grouped = new Map<
    string,
    {
      key: string;
      sentAt: Date;
      type: string;
      title: string;
      body: string;
      userIds: Set<string>;
      teamCount: Map<string, number>;
    }
  >();
  for (const row of todayNotifications) {
    const sentAt = row.sentAt ?? row.createdAt;
    const key = [sentAt.toISOString(), row.type, row.title, row.body].join("::");
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        key,
        sentAt,
        type: row.type,
        title: row.title,
        body: row.body,
        userIds: new Set([row.userId]),
        teamCount: new Map(),
      });
    } else {
      existing.userIds.add(row.userId);
    }
    const group = grouped.get(key);
    if (!group) continue;
    const teamId = row.user.favoriteTeam ?? "unknown";
    group.teamCount.set(teamId, (group.teamCount.get(teamId) ?? 0) + 1);
  }

  const todayAlertRuns = Array.from(grouped.values())
    .map((group) => {
      const sortedTeams = Array.from(group.teamCount.entries()).sort((a, b) => b[1] - a[1]);
      const targetTeam =
        sortedTeams.length === 0
          ? "팀 미지정"
          : sortedTeams.length === 1
            ? resolveTeamLabel(sortedTeams[0][0] === "unknown" ? null : sortedTeams[0][0])
            : `혼합(${sortedTeams.length}팀)`;
      const teamBreakdown = sortedTeams
        .slice(0, 3)
        .map(([teamId, count]) => `${resolveTeamLabel(teamId === "unknown" ? null : teamId)} ${formatNumber(count)}명`)
        .join(" · ");
      return {
        ...group,
        receivers: group.userIds.size,
        targetTeam,
        teamBreakdown,
      };
    })
    .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());

  return (
    <main className="h-full overflow-y-auto bg-slate-950 text-slate-100">
      <section className="mx-auto max-w-5xl px-6 py-10 pb-28">
        <div className="mb-7">
          <p className="text-[11px] uppercase tracking-[0.34em] text-slate-400">GROUND ADMIN</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">트랙션 대시보드</h1>
          <p className="mt-2 text-sm text-slate-400">
            활성 구독 유저와 구단별 팬 화력을 Prisma에서 실시간 집계합니다.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.25)]">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Total Active Users</p>
            <p className="mt-3 text-4xl font-bold tracking-tight text-white">{formatNumber(totalUsers)}</p>
            <p className="mt-1 text-xs text-slate-400">enabled 푸시 구독 기준</p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.25)]">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Today&apos;s Triggers</p>
            <p className="mt-3 text-4xl font-bold tracking-tight text-white">{formatNumber(todaysTriggers)}</p>
            <p className="mt-1 text-xs text-slate-400">KST 오늘 sentAt 기준</p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.25)]">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Top Team</p>
            <p className="mt-3 text-2xl font-bold tracking-tight text-white">
              {ranking[0] ? ranking[0].label : "데이터 없음"}
            </p>
            <p className="mt-2 text-xs text-slate-400">
              {ranking[0] ? `${formatNumber(ranking[0].count)}명` : "집계 대기"}
            </p>
          </div>
        </div>

        <div className="mt-8 rounded-2xl border border-white/10 bg-slate-900/60 p-5">
          <h2 className="text-lg font-semibold tracking-tight text-white">구단별 화력 랭킹</h2>
          <p className="mt-1 text-xs text-slate-400">
            favoriteTeam + 활성 구독자 기준 Top 10
          </p>

          {ranking.length === 0 ? (
            <p className="mt-6 text-sm text-slate-400">아직 집계할 구독 데이터가 없습니다.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {ranking.map((row: RankingRow) => (
                <li
                  key={row.teamId}
                  className="rounded-xl border border-white/5 bg-slate-950/55 p-3"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-white/10 px-1 text-[11px] font-bold">
                        {row.rank}
                      </span>
                      <span className="text-sm font-semibold">{row.label}</span>
                      <span className="text-[11px] text-slate-400">{row.short}</span>
                    </div>
                    <span className="text-sm font-bold text-white">{formatNumber(row.count)}명</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${row.ratio}%`,
                        backgroundColor: row.accent,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <PendingNotificationsSection
          initialItems={pendingNotifications.map((n: any) => ({
            ...n,
            createdAt: n.createdAt.toISOString(),
          }))}
          adminKey={key!}
        />

        <div className="mt-8 rounded-2xl border border-white/10 bg-slate-900/60 p-5">
          <h2 className="text-lg font-semibold tracking-tight text-white">오늘 발송 알럿 히스토리</h2>
          <p className="mt-1 text-xs text-slate-400">
            발송 시각 + 메시지 기준으로 묶어, 어떤 팀에 몇 명에게 어떤 내용을 보냈는지 보여줍니다.
          </p>

          {todayAlertRuns.length === 0 ? (
            <p className="mt-6 text-sm text-slate-400">오늘 발송된 알럿이 없습니다.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {todayAlertRuns.map((run) => (
                <li
                  key={run.key}
                  className="rounded-xl border border-white/5 bg-slate-950/55 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-white">{run.title}</p>
                    <span className="text-xs text-slate-400">{formatDateTimeKst(run.sentAt)} KST</span>
                  </div>
                  <p className="mt-2 text-sm text-slate-200">{run.body}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-300">
                    <span>타입: {run.type}</span>
                    <span>대상팀: {run.targetTeam}</span>
                    <span>수신: {formatNumber(run.receivers)}명</span>
                  </div>
                  {run.teamBreakdown ? (
                    <p className="mt-2 text-xs text-slate-400">팀 분포: {run.teamBreakdown}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}
