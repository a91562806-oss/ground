import { GameStatus, Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { fetchKboTodayGames, todayKstDate, type LineupItem } from "@/lib/kbo";
import { prisma } from "@/lib/prisma";
import { findTeam } from "@/lib/teams";
import { sendWebPush } from "@/lib/webPushServer";
import { buildBiasedLineupCopy, computePulseState } from "@/lib/pushTemplate";
import { shouldSkipCronInAlpha } from "@/lib/appEnv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type SubscriptionTopics = {
  pitcher?: boolean;
};

function isAuthorized(req: Request, url: URL): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  const querySecret = url.searchParams.get("secret");
  return auth === `Bearer ${secret}` || querySecret === secret;
}

function isDryRun(url: URL): boolean {
  const raw = (url.searchParams.get("dry") ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function isPitcherAlertEnabled(topics: unknown): boolean {
  if (!topics || typeof topics !== "object") return false;
  return Boolean((topics as SubscriptionTopics).pitcher);
}

function toGameStatus(status: string): GameStatus {
  if (status === "LIVE") return "LIVE";
  if (status === "RESULT") return "RESULT";
  if (status === "CANCEL") return "CANCEL";
  return "BEFORE";
}

function toGameDateTime(date: string, time: string): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hh = Number.parseInt(m[1], 10);
  const mm = Number.parseInt(m[2], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null;
  }
  const iso = `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function pickStarter(lineup: LineupItem[]): string {
  const pitcher =
    lineup.find((item) => item.order.toUpperCase() === "P") ??
    lineup.find((item) => item.position.includes("투수")) ??
    lineup.find((item) => item.position.toLowerCase().includes("pitcher"));
  if (pitcher?.name) return pitcher.name;
  return lineup[0]?.name ?? "미정";
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
  const dryRun = isDryRun(url);

  const targetDate = todayKstDate();
  const now = new Date();
  const games = await fetchKboTodayGames(targetDate);

  let checked = 0;
  let triggered = 0;
  let teamsTriggered = 0;
  let subscriptionsTargeted = 0;
  let pushSent = 0;
  let disabled = 0;
  let inboxCreated = 0;
  let markedNotified = 0;
  let wouldSend = 0;
  let errors = 0;

  const failedGameIds: string[] = [];

  for (const game of games) {
    checked += 1;
    try {
      const gameDate = toGameDateTime(game.date, game.time);
      const dbGame = await prisma.game.upsert({
        where: { externalId: game.id },
        update: {
          homeTeam: game.homeId,
          awayTeam: game.awayId,
          homeScore: game.result?.homeScore ?? 0,
          awayScore: game.result?.awayScore ?? 0,
          status: toGameStatus(game.status),
          gameDate,
          lastSyncedAt: now,
        },
        create: {
          externalId: game.id,
          homeTeam: game.homeId,
          awayTeam: game.awayId,
          homeScore: game.result?.homeScore ?? 0,
          awayScore: game.result?.awayScore ?? 0,
          status: toGameStatus(game.status),
          gameDate,
          lastSyncedAt: now,
        },
      });
      if (dbGame.isLineupNotified) continue;

      const homeLineup = game.homeLineup ?? [];
      const awayLineup = game.awayLineup ?? [];
      const hasLineup = homeLineup.length > 0 || awayLineup.length > 0;
      if (!hasLineup) continue;

      triggered += 1;

      const teamLineups = [
        { teamId: game.homeId, lineup: homeLineup },
        { teamId: game.awayId, lineup: awayLineup },
      ].filter((item) => item.lineup.length > 0);

      for (const teamLineup of teamLineups) {
        teamsTriggered += 1;
        const team = findTeam(teamLineup.teamId);
        const starter = pickStarter(teamLineup.lineup);
        const isHomeTeam = game.homeId === teamLineup.teamId;
        const myScore = isHomeTeam ? game.result?.homeScore ?? 0 : game.result?.awayScore ?? 0;
        const oppScore = isHomeTeam ? game.result?.awayScore ?? 0 : game.result?.homeScore ?? 0;
        const state = computePulseState(null, null, myScore, oppScore);
        const copy = buildBiasedLineupCopy({
          teamShort: team.short,
          starter,
          state,
        });
        const title = copy.title;
        const body = copy.body;

        const activeSubs = await prisma.pushSubscription.findMany({
          where: {
            enabled: true,
            user: {
              favoriteTeam: teamLineup.teamId,
            },
          },
          select: {
            id: true,
            endpoint: true,
            p256dh: true,
            auth: true,
            userId: true,
            topics: true,
          },
        });

        const pitcherSubs = activeSubs.filter((sub) => isPitcherAlertEnabled(sub.topics));
        if (pitcherSubs.length === 0) continue;

        const inboxRows: Array<{
          userId: string;
          title: string;
          body: string;
          deeplinkUrl: string;
          sentAt: Date;
          type: "GAME_START";
          payload: Prisma.InputJsonValue;
        }> = [];
        const inboxUserSet = new Set<string>();

        for (const sub of pitcherSubs) {
          subscriptionsTargeted += 1;
          if (dryRun) {
            wouldSend += 1;
          } else {
            const push = await sendWebPush(
              {
                endpoint: sub.endpoint,
                p256dh: sub.p256dh,
                auth: sub.auth,
              },
              {
                title,
                body,
                url: "/today",
                teamId: teamLineup.teamId,
              },
              { favoriteTeam: teamLineup.teamId, origin: url.origin }
            );
            if (push.ok) {
              pushSent += 1;
            } else if (
              push.statusCode === 401 ||
              push.statusCode === 403 ||
              push.statusCode === 404 ||
              push.statusCode === 410
            ) {
              await prisma.pushSubscription.update({
                where: { id: sub.id },
                data: { enabled: false },
              });
              disabled += 1;
            }
          }

          if (inboxUserSet.has(sub.userId)) continue;
          inboxUserSet.add(sub.userId);
          inboxRows.push({
            userId: sub.userId,
            title,
            body,
            deeplinkUrl: "/today",
            sentAt: new Date(),
            type: "GAME_START",
            payload: {
              externalId: game.id,
              teamId: teamLineup.teamId,
              starter,
              lineupCount: teamLineup.lineup.length,
            },
          });
        }

        if (!dryRun && inboxRows.length > 0) {
          const created = await prisma.notification.createMany({ data: inboxRows });
          inboxCreated += created.count;
        }
      }

      if (!dryRun) {
        await prisma.game.update({
          where: { id: dbGame.id },
          data: {
            isLineupNotified: true,
            lastSyncedAt: new Date(),
          },
        });
        markedNotified += 1;
      }
    } catch (error) {
      errors += 1;
      failedGameIds.push(game.id);
      console.error("[check-lineup] failed for game", game.id, error);
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    date: targetDate,
    checked,
    triggered,
    teamsTriggered,
    subscriptionsTargeted,
    wouldSend,
    pushSent,
    disabled,
    inboxCreated,
    markedNotified,
    errors,
    failedGameIds,
  });
}
