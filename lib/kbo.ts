/**
 * KBO 실시간 데이터 어댑터 (서버 사이드 전용 — Node runtime).
 *
 *  - 1차 소스: 네이버 스포츠 JSON (api-gw.sports.naver.com)
 *  - 실패 / 시즌 데이터 부재 시 → 정적 더미 (lib/games.ts, config/standings.ts) 폴백
 *
 *  내부 노출 타입은 기존 Game / StandingRow 와 호환되도록 매핑한다.
 *  ────────────────────────────────────────────────────────────────────
 *  ⚠ 이 모듈은 fetch 를 그대로 쓰므로 클라이언트 import 금지.
 *    클라이언트는 /api/kbo/today 또는 /api/kbo/standings 호출.
 */

import {
  TODAY_GAMES,
  highlightUrlForFinishedGame,
  type Game,
  type GameResult,
} from "@/lib/games";
import { STANDINGS, type StandingRow } from "@/config/standings";

const NAVER_BASE = "https://api-gw.sports.naver.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 GroundBot/1.0";

/** 네이버 팀코드 → 우리 내부 teamId (소문자 기준) */
const NAVER_TEAM_MAP: Record<string, string> = {
  LG: "lg",
  OB: "doosan", // 두산 (구 OB 베어스 코드 그대로)
  HT: "kia",
  HH: "hanwha",
  WO: "kiwoom",
  LT: "lotte",
  NC: "nc",
  SK: "ssg", // SK 와이번스 → SSG 인수 후에도 SK 코드 유지되는 케이스
  SS: "samsung",
  KT: "kt",
};

/** 네이버 statusCode → 내부 단순화 */
type LiveStatus = "BEFORE" | "LIVE" | "RESULT" | "CANCEL" | "OTHER";
function normalizeStatus(code: string | undefined): LiveStatus {
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
      return "OTHER";
  }
}

export type LiveGame = Game & {
  /** 라이브 상태 — UI 의 '경기 전 / 경기 중 / 종료 / 우천 취소' 분기 */
  status: LiveStatus;
  /** 취소 사유 (가능한 경우만 추론) */
  cancelReason: "RAIN" | "OTHER" | null;
  /** 선발 라인업 (미발표/파싱 실패 시 null) */
  homeLineup: LineupItem[] | null;
  awayLineup: LineupItem[] | null;
};

export type TodayFeedStatus =
  | "NORMAL"
  | "MONDAY_OFF"
  | "RAIN_CANCELLED"
  | "NO_GAMES";

export function isKboRegularOffDay(date: string): boolean {
  const [y, m, d] = date.split("-").map((v) => Number.parseInt(v, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  // KST 달력 날짜를 고정값으로 판정하기 위해 UTC 정오 기준으로 요일 계산
  // (서버 로컬 타임존/서머타임 영향 제거)
  const day = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
  return day === 1;
}

export function resolveTodayFeedStatus(date: string, games: LiveGame[]): TodayFeedStatus {
  const hasRainCancelled = games.some((game) => game.cancelReason === "RAIN");
  const allCancelled = games.length > 0 && games.every((game) => game.status === "CANCEL");
  if (hasRainCancelled || allCancelled) return "RAIN_CANCELLED";
  if (isKboRegularOffDay(date) && games.length === 0) return "MONDAY_OFF";
  if (games.length === 0) return "NO_GAMES";
  return "NORMAL";
}

export function resolveTodayFeedMessage(status: TodayFeedStatus): string | null {
  if (status === "MONDAY_OFF") {
    return "오늘 월요일이라 야구 없다... 무슨 낙으로 사냐 😭";
  }
  if (status === "RAIN_CANCELLED") {
    return "하... 비 와서 오늘 경기 취소됨 🌧️ 투수 로테이션 개이득인가?";
  }
  if (status === "NO_GAMES") {
    return "오늘 경기가 없다... 그래도 우리 팀만 기다린다.";
  }
  return null;
}

export type LineupItem = {
  order: string;
  name: string;
  position: string;
};

/** YYYY-MM-DD (KST) — 서버 시간이 어디든 한국 캘린더 기준으로 고정 */
export function todayKstDate(d: Date = new Date()): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

/** 선발 투수 안전 변환 — 빈 값 / "미정" / "未定" 류는 모두 null 로 정규화 */
export function safeStarter(name?: string | null): string | null {
  if (name == null) return null;
  const t = String(name).trim();
  if (!t) return null;
  if (t === "미정" || t === "未定" || t === "TBD" || t === "?" || t === "-") return null;
  return t;
}

/** 선발 투수 라벨 — UI 노출용 ("선발: 김광현" / "선발: 미정") */
export function starterLabel(name?: string | null): string {
  const safe = safeStarter(name);
  return safe ?? "미정";
}

// ────────────────────────────────────────────────────────────────────
// 네이버 어댑터 — 일정/스코어/선발
// ────────────────────────────────────────────────────────────────────

type NaverScheduleGame = {
  gameId?: string;
  gameDate?: string;        // YYYYMMDD
  gameDateTime?: string;    // ISO
  gtime?: string;           // HH:mm
  homeTeamCode?: string;
  awayTeamCode?: string;
  stadium?: string;
  statusCode?: string;
  /** 네이버는 취소 경기도 statusCode:"BEFORE" 유지하면서 cancel:true 병행 */
  cancel?: boolean;
  statusInfo?: string;
  homeStarterName?: string;
  awayStarterName?: string;
  homeCurrentPitcherName?: string;
  awayCurrentPitcherName?: string;
  homeTeamScore?: number;
  awayTeamScore?: number;
  winner?: "HOME" | "AWAY" | "DRAW" | string;
  winningPitcherName?: string;
  losingPitcherName?: string;
  savePitcherName?: string;
};

function resolveGameStatus(raw: NaverScheduleGame): LiveStatus {
  const base = normalizeStatus(raw.statusCode);
  if (base === "CANCEL") return "CANCEL";
  if (raw.cancel === true) return "CANCEL";
  const info = (raw.statusInfo ?? "").toLowerCase();
  if (info.includes("취소") || info.includes("cancel") || info.includes("postponed")) return "CANCEL";
  return base;
}

function inferCancelReason(raw: NaverScheduleGame): "RAIN" | "OTHER" | null {
  const status = resolveGameStatus(raw);
  if (status !== "CANCEL") return null;
  const info = (raw.statusInfo ?? "").toLowerCase();
  if (info.includes("우천") || info.includes("rain")) return "RAIN";
  const text = JSON.stringify(raw).toLowerCase();
  if (text.includes("우천") || text.includes("rain")) return "RAIN";
  return "OTHER";
}

function adaptNaverGame(raw: NaverScheduleGame, fallbackDate: string): LiveGame | null {
  const homeId = NAVER_TEAM_MAP[(raw.homeTeamCode ?? "").toUpperCase()];
  const awayId = NAVER_TEAM_MAP[(raw.awayTeamCode ?? "").toUpperCase()];
  if (!homeId || !awayId) return null;

  const status = resolveGameStatus(raw);
  const dateRaw = raw.gameDate ?? "";
  const date =
    dateRaw.length === 8
      ? `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`
      : raw.gameDateTime?.slice(0, 10) ?? fallbackDate;
  const time =
    raw.gtime ??
    (raw.gameDateTime ? raw.gameDateTime.slice(11, 16) : "00:00");

  let result: GameResult | undefined;
  if (
    status === "RESULT" &&
    typeof raw.homeTeamScore === "number" &&
    typeof raw.awayTeamScore === "number"
  ) {
    let winnerId: string | null = null;
    if (raw.winner === "HOME") winnerId = homeId;
    else if (raw.winner === "AWAY") winnerId = awayId;
    else if (raw.homeTeamScore > raw.awayTeamScore) winnerId = homeId;
    else if (raw.awayTeamScore > raw.homeTeamScore) winnerId = awayId;
    result = {
      homeScore: raw.homeTeamScore,
      awayScore: raw.awayTeamScore,
      winnerId,
      winningPitcher: safeStarter(raw.winningPitcherName) ?? undefined,
      losingPitcher: safeStarter(raw.losingPitcherName) ?? undefined,
      savePitcher: safeStarter(raw.savePitcherName) ?? undefined,
    };
  }

  return {
    id: raw.gameId ?? `${date}-${awayId}-${homeId}`,
    date,
    time,
    awayId,
    homeId,
    stadium: raw.stadium ?? "",
    awayPitcher: safeStarter(raw.awayStarterName) ?? "미정",
    homePitcher: safeStarter(raw.homeStarterName) ?? "미정",
    homeLineup: null,
    awayLineup: null,
    result,
    status,
    cancelReason: inferCancelReason(raw),
  };
}

/**
 * 임의 날짜 범위(KST) 의 KBO 경기. 단일 라이브 fetcher.
 *  - fromDate / toDate 는 YYYY-MM-DD (포함). 동일 날짜면 단일일치 호출과 동일.
 *  - 라이브가 죽으면 throw (상위에서 결정해라). 단일 day fetch 는 별도 함수에서 정적 폴백.
 */
async function fetchKboGamesRange(
  fromDate: string,
  toDate: string
): Promise<LiveGame[]> {
  // size 미지정 시 Naver 가 10건만 페이지네이션해서 돌려준다 (gameTotalCount 와 별개).
  // 9일치(D-7~D+1) ≈ 최대 45경기라 size=200 으로 한 번에 전부 수신.
  const url =
    `${NAVER_BASE}/schedule/games` +
    `?fields=basic,statusInfo,homeStarter,awayStarter,winningPitcher,losingPitcher` +
    `&upperCategoryId=kbaseball&categoryId=kbo` +
    `&fromDate=${fromDate}&toDate=${toDate}&size=200`;
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "application/json",
      referer: "https://m.sports.naver.com/",
    },
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error(`naver schedule HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: { games?: NaverScheduleGame[] };
  };
  const raw = json?.result?.games ?? [];
  const games = raw
    .map((g) => adaptNaverGame(g, fromDate))
    .filter((g): g is LiveGame => Boolean(g));
  if (games.length === 0) throw new Error("naver returned 0 games");
  return games;
}

/**
 * 단일 게임 상세 (선발투수 포함) — `/schedule/games/{gameId}`.
 *
 * 네이버 schedule(list) 응답에는 `homeStarterName/awayStarterName` 필드 자체가
 * 빠져 있다 (fields= 어떤 조합을 줘도 미노출, 시즌 무관 동일).
 * 반면 단일 game 엔드포인트는 `result.game.homeStarterName` 형태로 직접 노출.
 *  → today/tomorrow 카드/포스터에서 "미정" 으로 박히는 문제 해결용.
 */
type NaverGameDetail = {
  result?: {
    game?: {
      homeStarterName?: string | null;
      awayStarterName?: string | null;
      homeCurrentPitcherName?: string | null;
      awayCurrentPitcherName?: string | null;
    };
  };
};

async function fetchGameStarters(
  gameId: string
): Promise<{ home: string | null; away: string | null }> {
  try {
    const res = await fetch(`${NAVER_BASE}/schedule/games/${gameId}`, {
      headers: {
        "user-agent": UA,
        accept: "application/json",
        referer: "https://m.sports.naver.com/",
      },
      next: { revalidate: 60 },
    });
    if (!res.ok) return { home: null, away: null };
    const j = (await res.json()) as NaverGameDetail;
    const g = j?.result?.game;
    return {
      home:
        safeStarter(g?.homeStarterName) ??
        safeStarter(g?.homeCurrentPitcherName),
      away:
        safeStarter(g?.awayStarterName) ??
        safeStarter(g?.awayCurrentPitcherName),
    };
  } catch {
    return { home: null, away: null };
  }
}

type NaverLineupResponse = {
  result?: {
    lineUpData?: unknown;
  };
};

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function readString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function readOrder(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim().toUpperCase();
  if (!t) return null;
  if (t === "P") return "P";
  const n = Number.parseInt(t, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 9) return String(n);
  return null;
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function pickSideNode(lineUpData: unknown, side: "home" | "away"): unknown {
  const root = asRecord(lineUpData);
  if (!root) return lineUpData;
  const keys = Object.keys(root);
  const sideNeedles = side === "home" ? ["home", "h"] : ["away", "a", "visitor"];
  const priorityNeedles = ["lineup", "line_up", "batter", "hitter", "pitcher", "starter", "team"];
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (!includesAny(lower, sideNeedles)) continue;
    if (includesAny(lower, priorityNeedles)) return root[key];
  }
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (includesAny(lower, sideNeedles)) return root[key];
  }
  return lineUpData;
}

function sideMatches(candidate: Record<string, unknown>, side: "home" | "away"): boolean {
  const marker =
    readString(candidate.homeAwayCode) ??
    readString(candidate.homeAway) ??
    readString(candidate.teamType) ??
    readString(candidate.side) ??
    readString(candidate.teamSide);
  if (!marker) return true;
  const m = marker.toLowerCase();
  if (side === "home") return m === "home" || m === "h";
  return m === "away" || m === "a" || m === "visitor";
}

function parseLineupFromNode(node: unknown, side: "home" | "away"): LineupItem[] {
  const out: LineupItem[] = [];
  const visited = new Set<unknown>();
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    const obj = asRecord(current);
    if (!obj) continue;
    if (!sideMatches(obj, side)) continue;
    const name =
      readString(obj.name) ??
      readString(obj.playerName) ??
      readString(obj.athleteName) ??
      readString(obj.batterName) ??
      readString(obj.pitcherName);
    const position =
      readString(obj.positionName) ??
      readString(obj.position) ??
      readString(obj.roleName) ??
      readString(obj.role) ??
      readString(obj.fieldPosition);
    let order =
      readOrder(obj.order) ??
      readOrder(obj.battingOrder) ??
      readOrder(obj.turn) ??
      readOrder(obj.seq) ??
      readOrder(obj.lineupOrder);
    if (
      order == null &&
      (position?.includes("투수") || position?.toLowerCase().includes("pitcher"))
    ) {
      order = "P";
    }
    if (name && position && order) {
      out.push({ order, name, position });
    }
    for (const value of Object.values(obj)) {
      if (value && (Array.isArray(value) || typeof value === "object")) {
        stack.push(value);
      }
    }
  }
  const dedup = new Map<string, LineupItem>();
  for (const item of out) dedup.set(`${item.order}:${item.name}`, item);
  return [...dedup.values()].sort((a, b) => {
    const ao = a.order === "P" ? 99 : Number.parseInt(a.order, 10);
    const bo = b.order === "P" ? 99 : Number.parseInt(b.order, 10);
    return ao - bo;
  });
}

async function fetchGameLineups(
  gameId: string
): Promise<{ homeLineup: LineupItem[] | null; awayLineup: LineupItem[] | null }> {
  try {
    const res = await fetch(`${NAVER_BASE}/schedule/games/${gameId}/lineup`, {
      headers: {
        "user-agent": UA,
        accept: "application/json",
        referer: "https://m.sports.naver.com/",
      },
      next: { revalidate: 60 },
    });
    if (!res.ok) return { homeLineup: null, awayLineup: null };
    const j = (await res.json()) as NaverLineupResponse;
    const lineUpData = j?.result?.lineUpData;
    if (!lineUpData) return { homeLineup: null, awayLineup: null };
    const homeFromSideNode = parseLineupFromNode(pickSideNode(lineUpData, "home"), "home");
    const awayFromSideNode = parseLineupFromNode(pickSideNode(lineUpData, "away"), "away");
    const home = homeFromSideNode.length > 0 ? homeFromSideNode : null;
    const away = awayFromSideNode.length > 0 ? awayFromSideNode : null;
    if (home || away) return { homeLineup: home, awayLineup: away };
    const homeFallback = parseLineupFromNode(lineUpData, "home");
    const awayFallback = parseLineupFromNode(lineUpData, "away");
    return {
      homeLineup: homeFallback.length > 0 ? homeFallback : null,
      awayLineup: awayFallback.length > 0 ? awayFallback : null,
    };
  } catch {
    return { homeLineup: null, awayLineup: null };
  }
}

/**
 * 비어있는 선발투수("미정")만 단일 game 엔드포인트로 보강.
 *  - 호출 비용 절약: starter 가 이미 채워진 game 은 스킵.
 *  - 병렬 fetch (Promise.all) — 보통 동시 5건 이내.
 */
async function enrichStarters(games: LiveGame[]): Promise<LiveGame[]> {
  const need = games.filter(
    (g) => g.homePitcher === "미정" || g.awayPitcher === "미정"
  );
  if (need.length === 0) return games;
  const results = await Promise.all(
    need.map(async (g) => [g.id, await fetchGameStarters(g.id)] as const)
  );
  const map = new Map(results);
  return games.map((g) => {
    const s = map.get(g.id);
    if (!s) return g;
    return {
      ...g,
      homePitcher: g.homePitcher !== "미정" ? g.homePitcher : s.home ?? "미정",
      awayPitcher: g.awayPitcher !== "미정" ? g.awayPitcher : s.away ?? "미정",
    };
  });
}

async function enrichLineups(games: LiveGame[]): Promise<LiveGame[]> {
  if (games.length === 0) return games;
  const results = await Promise.all(
    games.map(async (g) => [g.id, await fetchGameLineups(g.id)] as const)
  );
  const map = new Map(results);
  return games.map((g) => {
    const lineup = map.get(g.id);
    if (!lineup) return g;
    return {
      ...g,
      homeLineup: lineup.homeLineup,
      awayLineup: lineup.awayLineup,
    };
  });
}

/**
 * 오늘(KST) 의 KBO 경기 리스트.
 *  - 1차: 네이버 schedule API + 단일 game endpoint 로 선발 보강
 *  - 실패 시: 빈 배열 반환 (Today 탭에 잘못된 목업 경기 노출 방지)
 */
export async function fetchKboTodayGames(date?: string): Promise<LiveGame[]> {
  const target = date ?? todayKstDate();
  if (isKboRegularOffDay(target)) {
    return [];
  }
  try {
    const games = await fetchKboGamesRange(target, target);
    const withStarters = await enrichStarters(games);
    return await enrichLineups(withStarters);
  } catch (err) {
    console.warn(
      `[kbo] live games fetch failed (${(err as Error).message}); returning empty today games`
    );
    return [];
  }
}

/** ISO YYYY-MM-DD 에 day 만큼 더한 KST 날짜 */
export function addDaysKst(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  const t = Date.UTC(y, m - 1, d) + days * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export type ScheduleBundle = {
  /** 기준일(=오늘 KST) */
  date: string;
  /** 지난 7일(D-7~D-1), 오래된 → 최신 */
  past: LiveGame[];
  /** 오늘 경기 */
  today: LiveGame[];
  /** 내일 경기 (D+1) */
  tomorrow: LiveGame[];
  /** 모레 ~ D+6 (UI 에서 미래 일정 스크롤) */
  upcoming: LiveGame[];
  /** 라이브 fetch 실패 시 true */
  fallback: boolean;
};

/** 스케줄 API에 하이라이트 필드가 없어도, 종료 경기엔 결정론적 유튜브 형식 URL 부여 */
function withFinishedGameHighlights(games: LiveGame[]): LiveGame[] {
  return games.map((g) => {
    if (!g.result || g.highlightUrl) return g;
    return { ...g, highlightUrl: highlightUrlForFinishedGame(g) };
  });
}

/**
 * Schedule 탭용 통합 fetch — D-7 ~ D+6 한 방.
 *  - 1차: 네이버 range 쿼리 (단일 호출, size=200 으로 14일치 ≈ 70경기 커버)
 *  - 실패: 정적 PAST/TODAY/TOMORROW 폴백 (upcoming 은 비움) + fallback=true
 */
export async function fetchKboSchedule(today?: string): Promise<ScheduleBundle> {
  const base = today ?? todayKstDate();
  const from = addDaysKst(base, -7);
  const to = addDaysKst(base, +6);
  const tomorrowDate = addDaysKst(base, +1);
  const sortByDateTime = (a: LiveGame, b: LiveGame) =>
    a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date);
  try {
    const all = await fetchKboGamesRange(from, to);
    const past = all.filter((g) => g.date < base).sort(sortByDateTime);
    const todayRaw = all
      .filter((g) => g.date === base)
      .sort((a, b) => a.time.localeCompare(b.time));
    const tomorrowRaw = all
      .filter((g) => g.date === tomorrowDate)
      .sort((a, b) => a.time.localeCompare(b.time));
    const upcomingRaw = all
      .filter((g) => g.date > tomorrowDate)
      .sort(sortByDateTime);
    // 14일치 전부 단일 game 엔드포인트로 선발 보강.
    // 취미·학습 프로젝트라 호출 비용 신경 안 씀 (ISR 60s 캐시로 분당 1회 수준).
    const [pastEnriched, today_, tomorrow, upcoming] = await Promise.all([
      enrichStarters(past),
      enrichStarters(todayRaw),
      enrichStarters(tomorrowRaw),
      enrichStarters(upcomingRaw),
    ]);
    // 라이브가 살아있는 한 빈 날(월요일·휴식일)은 빈 배열로 정직하게 반환.
    return {
      date: base,
      past: withFinishedGameHighlights(pastEnriched),
      today: withFinishedGameHighlights(today_),
      tomorrow: withFinishedGameHighlights(tomorrow),
      upcoming: withFinishedGameHighlights(upcoming),
      fallback: false,
    };
  } catch (err) {
    console.warn(
      `[kbo] schedule fetch failed (${(err as Error).message}); falling back to static`
    );
    const { PAST_GAMES, TODAY_GAMES, TOMORROW_GAMES } = await import(
      "@/lib/games"
    );
    const stamp = (g: import("@/lib/games").Game): LiveGame => ({
      ...g,
      status: g.result ? "RESULT" : "BEFORE",
      cancelReason: null,
      homeLineup: null,
      awayLineup: null,
    });
    return {
      date: base,
      past: PAST_GAMES.map(stamp),
      today: TODAY_GAMES.map(stamp),
      tomorrow: TOMORROW_GAMES.map(stamp),
      upcoming: [],
      fallback: true,
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// 순위표 — 시즌 전체 일정에서 직접 derive (네이버 ranking 엔드포인트가 404)
// ────────────────────────────────────────────────────────────────────

/**
 * KBO 정규시즌 개막일 (KST). 시범경기를 제외하기 위한 기준.
 *  - 매년 3월 말 개막. 2026 시즌은 3/22 개막 (네이버 일정 기준).
 *  - 새 시즌엔 이 값만 갱신하면 됨.
 */
const KBO_SEASON_OPENER: Record<number, string> = {
  2026: "2026-03-22",
};

function seasonOpenerForYear(year: number): string {
  return KBO_SEASON_OPENER[year] ?? `${year}-03-22`;
}

/**
 * 시즌 전체(1/1~12/31) 일정 → size=1000 한 방으로 가져옴 (KBO 시즌 ≈ 720경기).
 * 5분 캐시.
 */
async function fetchKboSeasonGames(year: number): Promise<LiveGame[]> {
  const url =
    `${NAVER_BASE}/schedule/games` +
    `?fields=basic,statusInfo` +
    `&upperCategoryId=kbaseball&categoryId=kbo` +
    `&fromDate=${year}-01-01&toDate=${year}-12-31&size=1000`;
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "application/json",
      referer: "https://m.sports.naver.com/",
    },
    next: { revalidate: 300 },
  });
  if (!res.ok) throw new Error(`naver season HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: { games?: NaverScheduleGame[] };
  };
  const raw = json?.result?.games ?? [];
  const games = raw
    .map((g) => adaptNaverGame(g, `${year}-01-01`))
    .filter((g): g is LiveGame => Boolean(g));
  return games;
}

/**
 * 정규시즌 결과(RESULT) 만 필터링 → 팀별 W/L/D/streak 누적 → 순위 계산.
 *  - 승률(winRate) = W / (W+L)  · 무승부 제외 (KBO 공식)
 *  - 게임차(GB) = ((1위.W - 본인.W) + (본인.L - 1위.L)) / 2
 *  - 정렬: 승률 desc → 승수 desc
 *  - 최근 연속(streak): 최근 5경기 결과 문자열 (예: "WWLWW")
 */
function deriveStandingsFromGames(games: LiveGame[]): StandingRow[] {
  type Stat = {
    wins: number;
    losses: number;
    draws: number;
    /** 시간순 결과 — 마지막 5개를 streak 로 노출 */
    recent: ("W" | "L" | "D")[];
  };
  const stats = new Map<string, Stat>();
  for (const teamId of Object.values(NAVER_TEAM_MAP)) {
    if (!stats.has(teamId)) {
      stats.set(teamId, { wins: 0, losses: 0, draws: 0, recent: [] });
    }
  }
  // 시간 오름차순 — recent 가 자연스럽게 시간 순서
  const finished = games
    .filter((g) => g.status === "RESULT" && g.result)
    .sort((a, b) =>
      a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)
    );
  for (const g of finished) {
    const r = g.result!;
    const home = stats.get(g.homeId);
    const away = stats.get(g.awayId);
    if (!home || !away) continue;
    if (r.winnerId == null) {
      home.draws++;
      away.draws++;
      home.recent.push("D");
      away.recent.push("D");
    } else if (r.winnerId === g.homeId) {
      home.wins++;
      away.losses++;
      home.recent.push("W");
      away.recent.push("L");
    } else {
      away.wins++;
      home.losses++;
      away.recent.push("W");
      home.recent.push("L");
    }
  }
  const rows: StandingRow[] = [];
  for (const [teamId, s] of stats.entries()) {
    const decided = s.wins + s.losses;
    const winRate = decided === 0 ? 0 : s.wins / decided;
    rows.push({
      rank: 0,
      teamId,
      games: s.wins + s.losses + s.draws,
      wins: s.wins,
      losses: s.losses,
      draws: s.draws,
      winRate,
      gamesBehind: 0,
      streak: s.recent.slice(-5).join("") || "—",
    });
  }
  rows.sort((a, b) => {
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    return b.wins - a.wins;
  });
  rows.forEach((r, i) => (r.rank = i + 1));
  if (rows.length > 0) {
    const top = rows[0];
    for (const r of rows) {
      r.gamesBehind = (top.wins - r.wins + (r.losses - top.losses)) / 2;
    }
  }
  return rows;
}

/** KBO 정규시즌 순위. 네이버 schedule 일정 → 결과 누적 derive. 실패 시 정적 STANDINGS. */
export async function fetchKboStandings(): Promise<StandingRow[]> {
  try {
    const year = parseInt(todayKstDate().slice(0, 4), 10);
    const all = await fetchKboSeasonGames(year);
    const opener = seasonOpenerForYear(year);
    const regular = all.filter((g) => g.date >= opener);
    const rows = deriveStandingsFromGames(regular);
    if (rows.length === 0) throw new Error("derived 0 rows");
    return rows;
  } catch (err) {
    console.warn(
      `[kbo] standings derive failed (${(err as Error).message}); falling back to static STANDINGS`
    );
    return STANDINGS;
  }
}

// ────────────────────────────────────────────────────────────────────
// 헬퍼 — UI / 프롬프트 양쪽에서 공유
// ────────────────────────────────────────────────────────────────────

/** teamId 의 오늘 경기 1건 + 이 팀이 home/away 어느 쪽인지 */
export type TeamGameView = {
  game: LiveGame;
  side: "home" | "away";
  /** 이 팀의 선발 투수 (있으면 이름, 없으면 null) */
  starter: string | null;
  /** 상대 팀 id */
  opponentId: string;
  /** 이 팀의 스코어 (RESULT 시) */
  myScore: number | null;
  /** 상대 스코어 (RESULT 시) */
  oppScore: number | null;
  /** 승리 확정 여부 (RESULT && winnerId === teamId) */
  isWinner: boolean;
  /** 무승부 (RESULT && winnerId === null) */
  isDraw: boolean;
};

export function getTeamGame(games: LiveGame[], teamId: string): TeamGameView | null {
  const id = teamId.toLowerCase();
  const g = games.find((x) => x.homeId === id || x.awayId === id);
  if (!g) return null;
  const side: "home" | "away" = g.homeId === id ? "home" : "away";
  const starter = safeStarter(side === "home" ? g.homePitcher : g.awayPitcher);
  const opponentId = side === "home" ? g.awayId : g.homeId;
  const myScore =
    g.result == null ? null : side === "home" ? g.result.homeScore : g.result.awayScore;
  const oppScore =
    g.result == null ? null : side === "home" ? g.result.awayScore : g.result.homeScore;
  const isWinner = g.result?.winnerId != null && g.result.winnerId === id;
  const isDraw = g.result != null && g.result.winnerId == null;
  return { game: g, side, starter, opponentId, myScore, oppScore, isWinner, isDraw };
}

/** standings 에서 teamId 의 순위 추출. 없으면 null. */
export function getTeamRank(rows: StandingRow[], teamId: string): StandingRow | null {
  const id = teamId.toLowerCase();
  return rows.find((r) => r.teamId === id) ?? null;
}
