import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findTeam } from "@/lib/teams";
import { shouldSkipCronInAlpha } from "@/lib/appEnv";
import {
  fetchOfficialHighlightEntries,
  pickMatchingHighlightForGame,
} from "@/lib/highlightFeed";
import { authorizeCron, markDispatchOnce, sendTeamTopicNotification } from "@/services/notificationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function buildHighlightMessage(input: {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  fanTeamId: string;
}) {
  const isHomeFan = input.fanTeamId === input.homeTeam;
  const myScore = isHomeFan ? input.homeScore : input.awayScore;
  const oppScore = isHomeFan ? input.awayScore : input.homeScore;
  if (myScore > oppScore) {
    return {
      title: "🔥 [승리 요약]",
      body: "오늘 역대급 명경기! 안 본 사람 없게 해라. 지금 바로 확인!",
    };
  }
  if (myScore < oppScore) {
    return {
      title: "😱 [하이라이트]",
      body: "오늘 야구 기억 삭제하고 싶지만... 그래도 봐야겠다면 여기 클릭.",
    };
  }
  return {
    title: "🎬 [하이라이트]",
    body: "비겼지만 핵심 장면은 다시 봐야 한다. 요약 영상 확인.",
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const auth = authorizeCron(req, url);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (shouldSkipCronInAlpha(url)) return NextResponse.json({ ok: true, skipped: "ALPHA_ENV_CRON_DISABLED" });

  const now = new Date();
  const minEndedAt = new Date(now.getTime() - 30 * 60 * 1000);
  const highlightPollThreshold = new Date(now.getTime() - 5 * 60 * 1000);
  const candidates = await prisma.game.findMany({
    where: {
      status: "RESULT",
      endedAt: { lte: minEndedAt },
      highlightNotifiedAt: null,
      OR: [
        { lastHighlightCheckedAt: null },
        { lastHighlightCheckedAt: { lte: highlightPollThreshold } },
      ],
    },
    orderBy: [{ endedAt: "desc" }],
    take: 16,
  });

  const entries = await fetchOfficialHighlightEntries(16);
  let checked = 0;
  let sent = 0;
  let matched = 0;

  for (const game of candidates) {
    checked += 1;
    await prisma.game.update({
      where: { id: game.id },
      data: { lastHighlightCheckedAt: new Date() },
    });
    const hit = pickMatchingHighlightForGame(entries, {
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
    });
    if (!hit) continue;
    matched += 1;

    for (const teamId of [game.homeTeam, game.awayTeam]) {
      const lock = await markDispatchOnce({
        alertKind: "highlight",
        teamScope: teamId,
        eventKey: `${game.externalId}:${hit.videoId}`,
        gameExternalId: game.externalId,
      });
      if (!lock) continue;
      const copy = buildHighlightMessage({
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        homeScore: game.homeScore,
        awayScore: game.awayScore,
        fanTeamId: teamId,
      });
      const result = await sendTeamTopicNotification({
        teamId,
        topicKey: "highlight",
        title: copy.title,
        body: copy.body,
        url: hit.url,
        payload: {
          kind: "highlight",
          gameExternalId: game.externalId,
          highlightVideoId: hit.videoId,
          highlightVideoUrl: hit.url,
          highlightTitle: hit.title,
          channelId: hit.channelId,
          channelLabel: hit.channelLabel,
        },
        type: "GAME_RESULT",
        origin: url.origin,
      });
      sent += result.sent;
    }

    await prisma.game.update({
      where: { id: game.id },
      data: {
        highlightNotifiedAt: new Date(),
        highlightVideoUrl: hit.url,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    checked,
    matched,
    sent,
    candidates: candidates.length,
  });
}
