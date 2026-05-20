import { todayKstDate } from "@/lib/kbo";
import type { LiveScoreGame, LiveScoreStatus } from "@/lib/score/types";

/**
 * 네이버 라이브 스코어 어댑터 — 단순 fetch + 정규화.
 * 점수/상태/취소 사유만 필요한 쪽 (check-score cron) 전용 경량 버전.
 * 일정/선발/라인업이 필요한 곳은 `lib/kbo` 를 사용한다.
 */

const NAVER_BASE = "https://api-gw.sports.naver.com";
const NAVER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 GroundBot/1.0";

const NAVER_TEAM_MAP: Record<string, string> = {
  LG: "lg",
  OB: "doosan",
  HT: "kia",
  HH: "hanwha",
  WO: "kiwoom",
  LT: "lotte",
  NC: "nc",
  SK: "ssg",
  SS: "samsung",
  KT: "kt",
};

type NaverScheduleGameRaw = {
  gameId?: string;
  gameDate?: string;
  gameDateTime?: string;
  homeTeamCode?: string;
  awayTeamCode?: string;
  homeTeamScore?: number;
  awayTeamScore?: number;
  statusCode?: string;
  /** 네이버는 취소 경기를 statusCode:"BEFORE" 유지하면서 cancel:true 로 별도 표기함 */
  cancel?: boolean;
  statusInfo?: string;
};

function normalizeStatus(code: string | undefined): LiveScoreStatus {
  switch ((code ?? "").toUpperCase()) {
    case "BEFORE":
    case "READY":
      return "BEFORE";
    case "STARTED":
    case "PLAYING":
    case "LIVE":
      return "LIVE";
    case "RESULT":
    case "FINISH":
    case "ENDED":
      return "RESULT";
    case "CANCEL":
    case "POSTPONED":
    case "CANCELLED":
      return "CANCEL";
    default:
      return "BEFORE";
  }
}

function parseGameDate(gameDate?: string, gameDateTime?: string): Date | null {
  if (typeof gameDateTime === "string") {
    const ms = Date.parse(gameDateTime);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  if (typeof gameDate === "string" && gameDate.length === 8) {
    const iso = `${gameDate.slice(0, 4)}-${gameDate.slice(4, 6)}-${gameDate.slice(6, 8)}T00:00:00+09:00`;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return null;
}

function inferCancelReason(raw: NaverScheduleGameRaw, status: LiveScoreStatus): "RAIN" | "OTHER" | null {
  if (status !== "CANCEL") return null;
  const info = (raw.statusInfo ?? "").toLowerCase();
  if (info.includes("우천") || info.includes("rain")) return "RAIN";
  const text = JSON.stringify(raw).toLowerCase();
  if (text.includes("우천") || text.includes("rain")) return "RAIN";
  return "OTHER";
}

/**
 * 네이버는 취소 경기도 statusCode:"BEFORE" 를 유지하면서
 * cancel:true 또는 statusInfo:"경기취소"/"우천취소" 를 병행 사용한다.
 * 이를 CANCEL 로 정규화하는 헬퍼.
 */
function resolveStatus(raw: NaverScheduleGameRaw): LiveScoreStatus {
  const base = normalizeStatus(raw.statusCode);
  if (base === "CANCEL") return "CANCEL";
  if (raw.cancel === true) return "CANCEL";
  const info = (raw.statusInfo ?? "").toLowerCase();
  if (info.includes("취소") || info.includes("cancel") || info.includes("postponed")) return "CANCEL";
  return base;
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        "user-agent": NAVER_UA,
        accept: "application/json",
        referer: "https://m.sports.naver.com/",
      },
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchLiveScoreSnapshot(date: string = todayKstDate()): Promise<LiveScoreGame[]> {
  const url =
    `${NAVER_BASE}/schedule/games` +
    `?fields=basic,statusInfo,score` +
    `&upperCategoryId=kbaseball&categoryId=kbo` +
    `&fromDate=${date}&toDate=${date}&size=200`;
  const res = await fetchJsonWithTimeout(url, 1200);
  if (!res.ok) throw new Error(`naver score HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: { games?: NaverScheduleGameRaw[] };
  };
  const games = json?.result?.games ?? [];
  return games
    .map((g) => {
      const homeTeam = NAVER_TEAM_MAP[(g.homeTeamCode ?? "").toUpperCase()];
      const awayTeam = NAVER_TEAM_MAP[(g.awayTeamCode ?? "").toUpperCase()];
      if (!homeTeam || !awayTeam || !g.gameId) return null;
      const status = resolveStatus(g);
      return {
        externalId: g.gameId,
        homeTeam,
        awayTeam,
        homeScore: typeof g.homeTeamScore === "number" ? g.homeTeamScore : 0,
        awayScore: typeof g.awayTeamScore === "number" ? g.awayTeamScore : 0,
        status,
        cancelReason: inferCancelReason(g, status),
        gameDate: parseGameDate(g.gameDate, g.gameDateTime),
      } satisfies LiveScoreGame;
    })
    .filter((g): g is LiveScoreGame => Boolean(g));
}
