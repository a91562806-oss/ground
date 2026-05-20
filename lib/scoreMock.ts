/**
 * `check-score` cron 의 alpha 환경 검증용 mock 스냅샷.
 * production 에서는 호출되지 않으며, `lib/score/devOverrides.ts` 가 입구.
 */

export type MockScoreGame = {
  externalId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  status: "BEFORE" | "LIVE" | "RESULT" | "CANCEL";
  gameDate: Date;
};

const SCORE_BY_TICK: ReadonlyArray<{ home: number; away: number }> = [
  { home: 0, away: 0 },
  { home: 1, away: 0 },
  { home: 1, away: 1 },
  { home: 2, away: 1 },
];

export async function fetchMockScoreSnapshotByTick(
  tickOverride: number,
  now: Date = new Date()
): Promise<MockScoreGame[]> {
  const normalized = Math.abs(Math.floor(tickOverride)) % SCORE_BY_TICK.length;
  const score = SCORE_BY_TICK[normalized];
  const gameDate = new Date(now);
  gameDate.setHours(18, 30, 0, 0);
  return [
    {
      externalId: "mock-2026-lg-doosan",
      homeTeam: "doosan",
      awayTeam: "lg",
      homeScore: score.home,
      awayScore: score.away,
      status: "LIVE",
      gameDate,
    },
  ];
}
