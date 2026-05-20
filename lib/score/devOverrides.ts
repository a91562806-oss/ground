import { isAlphaServerEnv } from "@/lib/appEnv";
import { fetchMockScoreSnapshotByTick } from "@/lib/scoreMock";
import type { CancelReason, LiveScoreGame, LiveScoreStatus } from "@/lib/score/types";

/**
 * alpha 환경 전용 디버그 훅.
 *   - `tick=N` : `lib/scoreMock` 의 스냅샷 사용 (실 네이버 API 우회)
 *   - `mockStatus=BEFORE|LIVE|RESULT|CANCEL` : 상태 강제
 *   - `mockCancelReason=RAIN|OTHER` : 취소 사유 강제
 *   - `mockGameId=...` : `markDispatchOnce` 충돌 회피용 외부 id 덮어쓰기
 *   - `bypassLock=1` : advisory lock 우회 (검증 전용)
 *
 * production 환경에서는 모두 무시.
 */

export type ScoreCronDevOverrides = {
  tick: number | null;
  mockStatus: LiveScoreStatus | null;
  mockCancelReason: CancelReason | null;
  mockGameId: string | null;
  bypassLock: boolean;
};

const EMPTY_OVERRIDES: ScoreCronDevOverrides = {
  tick: null,
  mockStatus: null,
  mockCancelReason: null,
  mockGameId: null,
  bypassLock: false,
};

function parseStatus(raw: string): LiveScoreStatus | null {
  switch (raw) {
    case "BEFORE":
    case "LIVE":
    case "RESULT":
    case "CANCEL":
      return raw;
    default:
      return null;
  }
}

export function readScoreCronDevOverrides(url: URL): ScoreCronDevOverrides {
  if (!isAlphaServerEnv()) return EMPTY_OVERRIDES;

  const tickRaw = url.searchParams.get("tick");
  const tickNum = tickRaw != null && tickRaw !== "" ? Number(tickRaw) : null;
  const tick = Number.isFinite(tickNum) ? (tickNum as number) : null;

  const statusRaw = (url.searchParams.get("mockStatus") ?? "").trim().toUpperCase();
  const reasonRaw = (url.searchParams.get("mockCancelReason") ?? "").trim().toUpperCase();
  const idRaw = (url.searchParams.get("mockGameId") ?? "").trim();
  const bypassLock = (url.searchParams.get("bypassLock") ?? "").toLowerCase() === "1";

  return {
    tick,
    mockStatus: parseStatus(statusRaw),
    mockCancelReason: reasonRaw === "RAIN" ? "RAIN" : reasonRaw === "OTHER" ? "OTHER" : null,
    mockGameId: idRaw.length > 0 ? idRaw : null,
    bypassLock,
  };
}

/**
 * Mock 스냅샷에 override 를 덮어 씌운다.
 * tick override 가 켜져 있을 때만 호출.
 */
export async function loadMockSnapshotWithOverrides(
  overrides: ScoreCronDevOverrides
): Promise<LiveScoreGame[]> {
  if (overrides.tick == null) return [];
  const raw = await fetchMockScoreSnapshotByTick(overrides.tick);
  return raw.map((g) => {
    const status: LiveScoreStatus = overrides.mockStatus ?? g.status;
    const cancelReason: CancelReason | null =
      status === "CANCEL" ? overrides.mockCancelReason ?? "OTHER" : null;
    return {
      externalId: overrides.mockGameId ?? g.externalId,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      status,
      cancelReason,
      gameDate: g.gameDate,
    } satisfies LiveScoreGame;
  });
}
