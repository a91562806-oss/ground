import { NextResponse } from "next/server";
import { fetchKboSchedule, todayKstDate } from "@/lib/kbo";
import { findTeam } from "@/lib/teams";
import { shouldSkipCronInAlpha } from "@/lib/appEnv";
import { authorizeCron, markDispatchOnce, sendTeamTopicNotification } from "@/services/notificationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const NAVER_BASE = "https://api-gw.sports.naver.com";

async function fetchLatestRelayText(gameId: string): Promise<string | null> {
  const endpoints = [
    `${NAVER_BASE}/schedule/games/${gameId}/relay`,
    `${NAVER_BASE}/schedule/games/${gameId}/relayTexts`,
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        headers: {
          "user-agent": "Mozilla/5.0 GroundBot/1.0",
          accept: "application/json",
          referer: "https://m.sports.naver.com/",
        },
        cache: "no-store",
      });
      if (!res.ok) continue;
      const json = (await res.json()) as unknown;
      const text = JSON.stringify(json);
      if (text.length > 0) return text;
    } catch {
      // ignore
    }
  }
  return null;
}

function detectKinds(text: string): Array<"pitcherChange" | "strikeout"> {
  const out: Array<"pitcherChange" | "strikeout"> = [];
  if (/투수\s*교체|투수교체/.test(text)) out.push("pitcherChange");
  if (/삼진|탈삼진/.test(text)) out.push("strikeout");
  return out;
}

function buildLiveEventCopy(kind: "pitcherChange" | "strikeout", myTeam: string, oppTeam: string): string {
  if (kind === "pitcherChange") {
    return `${myTeam}-${oppTeam}전, 방금 투수 교체. 여기서 흐름 뒤집어야 한다.`;
  }
  return `${myTeam}-${oppTeam}전, 방금 탈삼진. 지금부터 분위기 타면 된다.`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const auth = authorizeCron(req, url);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (shouldSkipCronInAlpha(url)) return NextResponse.json({ ok: true, skipped: "ALPHA_ENV_CRON_DISABLED" });

  const date = todayKstDate();
  const schedule = await fetchKboSchedule(date);
  const liveGames = schedule.today.filter((game) => game.status === "LIVE");
  let sent = 0;
  let skipped = 0;

  for (const game of liveGames) {
    const relayText = await fetchLatestRelayText(game.id);
    if (!relayText) continue;
    const kinds = detectKinds(relayText);
    for (const kind of kinds) {
      for (const teamId of [game.homeId, game.awayId]) {
        const lock = await markDispatchOnce({
          alertKind: "live-event",
          teamScope: teamId,
          eventKey: `${game.id}:${kind}:${relayText.slice(0, 120)}`,
          gameExternalId: game.id,
        });
        if (!lock) {
          skipped += 1;
          continue;
        }
        const opponentTeamId = teamId === game.homeId ? game.awayId : game.homeId;
        const body = buildLiveEventCopy(kind, findTeam(teamId).short, findTeam(opponentTeamId).short);
        const result = await sendTeamTopicNotification({
          teamId,
          topicKey: kind === "pitcherChange" ? "livePitcherChange" : "liveStrikeout",
          title: kind === "pitcherChange" ? "🎯 라이브 경기 상황" : "⚡ 라이브 경기 상황",
          body,
          url: "/today",
          payload: {
            kind: "live-event",
            eventKind: kind,
            gameId: game.id,
            teamId,
            opponentTeamId,
          },
          type: "SYSTEM",
          origin: url.origin,
        });
        sent += result.sent;
      }
    }
  }
  return NextResponse.json({ ok: true, date, sent, skipped, liveGames: liveGames.length });
}
