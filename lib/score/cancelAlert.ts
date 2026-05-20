import { findTeam } from "@/lib/teams";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  markDispatchOnce,
  sendTeamTopicNotification,
} from "@/services/notificationService";
import type { LiveScoreGame } from "@/lib/score/types";

/**
 * 게임이 BEFORE/LIVE → CANCEL 로 바뀌었거나, 스냅샷에서 처음 CANCEL 로 들어온 경우
 * 양 팀 팬에게 우천/취소 알림을 1회 발송한다.
 *
 * 사용자가 별도로 켜는 토글이 없도록, `pitcher` (= 프리뷰) 토픽과 묶었다.
 * 동일 알림은 preview cron 에서도 같은 키(`{date}:{gameId}:cancel`)로 잠가두기 때문에
 * 중복 발송될 일이 없다.
 */
export async function sendCancelAlerts(input: {
  game: LiveScoreGame;
  targetDate: string;
  origin: string;
}): Promise<{ sent: number; disabled: number; inboxCreated: number; skipped: number }> {
  const teamIds: string[] = [input.game.homeTeam, input.game.awayTeam];
  let sent = 0;
  let disabled = 0;
  let inboxCreated = 0;
  let skipped = 0;

  await mapWithConcurrency(teamIds, 2, async (teamId) => {
    const lock = await markDispatchOnce({
      alertKind: "cancel",
      teamScope: teamId,
      eventKey: `${input.targetDate}:${input.game.externalId}:cancel`,
      gameExternalId: input.game.externalId,
    });
    if (!lock) {
      skipped += 1;
      return;
    }
    const isHomeFan = teamId === input.game.homeTeam;
    const myTeam = findTeam(teamId);
    const oppTeam = findTeam(isHomeFan ? input.game.awayTeam : input.game.homeTeam);
    const cancelLabel = input.game.cancelReason === "RAIN" ? "우천취소" : "경기 취소";
    const bodyReason =
      input.game.cancelReason === "RAIN"
        ? `오늘 ${oppTeam.short}전 우천취소.`
        : `오늘 ${oppTeam.short}전 취소.`;
    const result = await sendTeamTopicNotification({
      teamId,
      topicKey: "pitcher",
      title: `🌧️ ${myTeam.short} ${cancelLabel}`,
      body: `${bodyReason} 로테이션은 아끼고 내일 제대로 가자.`,
      url: "/today",
      payload: {
        kind: "game-cancel",
        externalId: input.game.externalId,
        homeTeam: input.game.homeTeam,
        awayTeam: input.game.awayTeam,
        teamId,
        cancelReason: input.game.cancelReason ?? "OTHER",
      },
      type: "SYSTEM",
      origin: input.origin,
    });
    sent += result.sent;
    disabled += result.disabled;
    inboxCreated += result.inboxCreated;
  });

  return { sent, disabled, inboxCreated, skipped };
}
