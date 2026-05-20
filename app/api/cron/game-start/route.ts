import { NextResponse } from "next/server";
import { fetchKboSchedule, todayKstDate } from "@/lib/kbo";
import { findTeam } from "@/lib/teams";
import { shouldSkipCronInAlpha } from "@/lib/appEnv";
import { authorizeCron, markDispatchOnce, minutesUntil, sendTeamTopicNotification, toKstDateTime } from "@/services/notificationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const TEMPLATES = [
  "15분 뒤 {상대팀}전. 치킨 세팅하셨죠? 먹으면서 보시죠.",
  "칼퇴 성공하셨습니까? 15분 뒤 {상대팀}전 플레이볼!",
  "15분 뒤 {상대팀}전. 이 팀을 또 믿어봅니다. 일단 켜시죠.",
  "잠시 후 플레이볼!, 혈압약 챙기셨죠?",
  "15분 뒤 {상대팀}전. 딴 팀은 몰라도 얘넨 꼭 잡아야 합니다.",
  "아무리 욕해도 야구는 봐야죠. 15분 뒤 {상대팀}전 시작합니다",
  "15분 뒤 {상대팀}전. 오늘은 제발 9회까지 보게 해주기를...",
  "곧 야구 시작, 오늘은 몇 회에 티비 끄게 될까요... 일단 켜봅니다.",
  "15분 뒤 {상대팀}전. 느낌이 쎄하지만... 속는 셈 치고 봅니다.",
  "15분 뒤 {상대팀}전. 어제는 잊고 플레이볼! 티비 켜시죠.",
] as const;

function pickTemplate(seed: string): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return TEMPLATES[(hash >>> 0) % TEMPLATES.length] ?? TEMPLATES[0];
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const auth = authorizeCron(req, url);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (shouldSkipCronInAlpha(url)) return NextResponse.json({ ok: true, skipped: "ALPHA_ENV_CRON_DISABLED" });

  const force = url.searchParams.get("force") === "1";
  const date = todayKstDate();
  const schedule = await fetchKboSchedule(date);
  const games = schedule.today.filter((g) => g.status === "BEFORE");
  let sent = 0;
  let skipped = 0;

  for (const game of games) {
    const gameDateTime = toKstDateTime(date, game.time);
    if (!gameDateTime) continue;
    const mins = minutesUntil(gameDateTime);
    if (!force && (mins < 10 || mins > 20)) continue;

    for (const teamId of [game.homeId, game.awayId]) {
      const lock = await markDispatchOnce({
        alertKind: "game-start",
        teamScope: teamId,
        eventKey: `${date}:${game.id}:game-start`,
        gameExternalId: game.id,
      });
      if (!lock) {
        skipped += 1;
        continue;
      }
      const opponentTeamId = teamId === game.homeId ? game.awayId : game.homeId;
      const opponent = findTeam(opponentTeamId).short;
      const body = pickTemplate(`${date}:${game.id}:${teamId}`).replaceAll("{상대팀}", opponent);
      const result = await sendTeamTopicNotification({
        teamId,
        topicKey: "preGame",
        title: "⏱️ 경기 시작 임박",
        body,
        url: "/today",
        payload: {
          kind: "game-start",
          gameId: game.id,
          teamId,
          opponentTeamId,
        },
        type: "GAME_START",
        origin: url.origin,
      });
      sent += result.sent;
    }
  }

  return NextResponse.json({ ok: true, date, sent, skipped, games: games.length });
}
