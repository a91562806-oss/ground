/**
 * `check-score` cron 파이프라인에서 공유하는 타입 정의.
 */

export type LiveScoreStatus = "BEFORE" | "LIVE" | "RESULT" | "CANCEL";
export type CancelReason = "RAIN" | "OTHER";

export type LiveScoreGame = {
  externalId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  status: LiveScoreStatus;
  cancelReason: CancelReason | null;
  gameDate: Date | null;
};
