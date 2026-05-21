"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronUp, Play } from "lucide-react";
import {
  PAST_GAMES,
  TODAY_GAMES,
  TOMORROW_GAMES,
  type Game,
} from "@/lib/games";
import { findTeam } from "@/lib/teams";
import { useKboSchedule } from "@/lib/useKboSchedule";
import { starterLabel, type LiveGame, type ScheduleBundle } from "@/lib/kbo";
import { venueDisplayLines } from "@/lib/venue";

const EMPTY_GAMES: Game[] = [];

type Section = {
  /** 정렬용 ISO 날짜 */
  date: string;
  /** 화면 라벨 (예: "4월 18일 · 금") */
  dateLabel: string;
  /** 상단 작은 뱃지 */
  badge: "PAST" | "TODAY" | "TOMORROW" | "UPCOMING";
  /** 과거 일자 vs 오늘/미래 vs 오늘에 따라 톤 다르게 */
  tone: "past" | "today" | "future";
  /** Game 또는 LiveGame (LiveGame 은 status 필드 추가) */
  games: (Game | LiveGame)[];
};

const KO_DOW = ["일", "월", "화", "수", "목", "금", "토"];

/** ISO date (YYYY-MM-DD) → "4월 18일 · 금" */
function formatDateLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const dow = KO_DOW[d.getUTCDay()];
  return `${month}월 ${day}일 · ${dow}`;
}

/** 같은 날짜끼리 묶어 ascending(오래된→최신) 으로 반환 */
function groupByDate<T extends { date: string }>(
  games: T[]
): Array<{ date: string; games: T[] }> {
  const map = new Map<string, T[]>();
  for (const g of games) {
    const arr = map.get(g.date) ?? [];
    arr.push(g);
    map.set(g.date, arr);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, games]) => ({ date, games }));
}

export default function SchedulePageClient({
  initial,
}: {
  /** 서버에서 SSR 로 받아온 초기 번들 — 첫 paint 부터 라이브 데이터 노출. */
  initial: ScheduleBundle;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const currentSectionRef = useRef(0);
  const scrollLockedRef = useRef(false);
  const didLiveScrollRef = useRef(false);

  // ── 라이브 KBO 데이터 (initial 로 즉시 채워진 뒤 5분 폴링으로 갱신) ──
  const live = useKboSchedule(initial);

  // 라이브 데이터가 도착하면 그것을, 아니면 정적 mock 으로 빌드.
  // SSR 덕에 initial 이 항상 채워져 있어 첫 렌더부터 sourceXxx 가 라이브 값.
  const sections = useMemo<Section[]>(() => {
    const sourcePast: (Game | LiveGame)[] = live?.past ?? PAST_GAMES;
    const sourceToday: (Game | LiveGame)[] = live?.today ?? TODAY_GAMES;
    const sourceTomorrow: (Game | LiveGame)[] = live?.tomorrow ?? TOMORROW_GAMES;
    const sourceUpcoming: (Game | LiveGame)[] = live?.upcoming ?? EMPTY_GAMES;

    const past = groupByDate(sourcePast).map(
      ({ date, games }): Section => ({
        date,
        dateLabel: formatDateLabel(date),
        badge: "PAST",
        tone: "past",
        games,
      })
    );

    let todaySections = groupByDate(sourceToday).map(
      ({ date, games }): Section => ({
        date,
        dateLabel: formatDateLabel(date),
        badge: "TODAY",
        tone: "today",
        games,
      })
    );
    // 월요일·휴식일 등 today 경기 0건이라도 anchor 잡을 수 있게 placeholder 1섹션.
    if (todaySections.length === 0 && live?.date) {
      todaySections = [
        {
          date: live.date,
          dateLabel: formatDateLabel(live.date),
          badge: "TODAY",
          tone: "today",
          games: [],
        },
      ];
    }
    const tomorrowSections = groupByDate(sourceTomorrow).map(
      ({ date, games }): Section => ({
        date,
        dateLabel: formatDateLabel(date),
        badge: "TOMORROW",
        tone: "future",
        games,
      })
    );
    const upcomingSections = groupByDate(sourceUpcoming).map(
      ({ date, games }): Section => ({
        date,
        dateLabel: formatDateLabel(date),
        badge: "UPCOMING",
        tone: "future",
        games,
      })
    );

    return [...past, ...todaySections, ...tomorrowSections, ...upcomingSections];
  }, [live]);

  const todayIndex = useMemo(() => {
    const idx = sections.findIndex((s) => s.badge === "TODAY");
    return idx >= 0 ? idx : 0;
  }, [sections]);

  const scrollToSection = useCallback(
    (index: number, behavior: ScrollBehavior = "smooth") => {
      const root = rootRef.current;
      const target = sectionRefs.current[index];
      if (!root || !target) return;
      currentSectionRef.current = index;
      root.scrollTo({ top: target.offsetTop, behavior });
    },
    []
  );

  const bumpHaptic = useCallback(() => {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(12);
    }
  }, []);

  const stepSection = useCallback(
    (dir: 1 | -1) => {
      if (scrollLockedRef.current) return;
      const max = Math.max(0, sections.length - 1);
      const next = Math.min(max, Math.max(0, currentSectionRef.current + dir));
      if (next === currentSectionRef.current) return;
      scrollLockedRef.current = true;
      scrollToSection(next, "smooth");
      bumpHaptic();
      window.setTimeout(() => {
        scrollLockedRef.current = false;
      }, 430);
    },
    [sections.length, scrollToSection, bumpHaptic]
  );

  // 초기 mount 시 TODAY 섹션으로 점프.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    scrollToSection(todayIndex, "auto");
  }, [todayIndex, scrollToSection]);

  // 폴링으로 새 데이터가 도착했을 때 첫 갱신 한정으로만 보정 스크롤.
  useEffect(() => {
    if (didLiveScrollRef.current) return;
    if (!live) return;
    if (live === initial) {
      didLiveScrollRef.current = true;
      return;
    }
    const raf = requestAnimationFrame(() => {
      scrollToSection(todayIndex, "auto");
      didLiveScrollRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [live, initial, todayIndex, scrollToSection]);

  // 한 번 스크롤(휠/스와이프)할 때 날짜를 하나씩 넘기는 스냅 UX.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let touchStartX = 0;
    let touchStartY = 0;
    let touchDeltaY = 0;
    // 첫 N 픽셀로 가로/세로 의도 판별 — 가로면 PageShell drag 에 맡기고 본 핸들러 무시.
    let axis: "x" | "y" | null = null;

    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 8) return;
      e.preventDefault();
      stepSection(e.deltaY > 0 ? 1 : -1);
    };

    const onTouchStart = (e: TouchEvent) => {
      touchStartX = e.touches[0]?.clientX ?? 0;
      touchStartY = e.touches[0]?.clientY ?? 0;
      touchDeltaY = 0;
      axis = null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - touchStartX;
      const dy = t.clientY - touchStartY;
      if (axis == null && Math.hypot(dx, dy) > 8) {
        axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      if (axis === "x") {
        // 가로 스와이프 — PageShell 이 라우팅 처리.
        return;
      }
      touchDeltaY = touchStartY - t.clientY;
      // 세로 스냅 보존을 위해 default scroll 막음.
      e.preventDefault();
    };
    const onTouchEnd = () => {
      if (axis !== "y") return;
      if (Math.abs(touchDeltaY) < 24) return;
      stepSection(touchDeltaY > 0 ? 1 : -1);
    };

    root.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchmove", onTouchMove, { passive: false });
    root.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchmove", onTouchMove);
      root.removeEventListener("touchend", onTouchEnd);
    };
  }, [stepSection]);

  return (
    <div ref={rootRef} className="flex-1 min-h-0 overflow-y-auto">
      <section className="px-0 pb-10">
        <header className="px-7 pt-7">
          <p
            className="text-[10px] uppercase tracking-[0.32em] text-white/45"
            style={{ fontWeight: 600 }}
          >
            Schedule
          </p>
        </header>

        {sections.map((sec, i) => (
          <DaySection
            key={`${sec.badge}-${sec.date}-${i}`}
            section={sec}
            sectionRef={(el) => {
              sectionRefs.current[i] = el;
            }}
          />
        ))}

        <p
          className="px-7 pt-12 text-[10px] uppercase tracking-[0.32em] text-white/30"
          style={{ fontWeight: 600 }}
        >
          End of feed
        </p>
      </section>
    </div>
  );
}

function DaySection({
  section,
  sectionRef,
}: {
  section: Section;
  sectionRef?: (el: HTMLDivElement | null) => void;
}) {
  const muted = section.tone !== "today";
  const headingColor =
    section.tone === "today"
      ? "text-white"
      : section.tone === "future"
        ? "text-white/60"
        : "text-white/45";

  return (
    <div ref={sectionRef} className="px-5 pt-10">
      <div className="mb-4 px-2">
        <div
          className="mb-2 flex items-center gap-1.5 text-white/70 drop-shadow-md"
          style={{ textShadow: "0 1px 4px rgba(0,0,0,0.4)" }}
        >
          {section.badge === "PAST" && <ChevronUp size={12} strokeWidth={2.4} />}
          {(section.badge === "TOMORROW" || section.badge === "UPCOMING") && (
            <ChevronDown size={12} strokeWidth={2.4} />
          )}
          <span
            className="text-[10px] uppercase tracking-[0.3em]"
            style={{ fontWeight: 700 }}
          >
            {section.badge}
          </span>
        </div>
        <h2
          className={`text-[40px] leading-[0.95] tracking-tightest drop-shadow-md ${headingColor}`}
          style={{
            fontWeight: 900,
            textShadow: "0 2px 12px rgba(0,0,0,0.5)",
          }}
        >
          {section.dateLabel}
        </h2>
      </div>

      <ul className="flex flex-col gap-3">
        {section.games.map((g) => (
          <GameRow key={g.id} game={g} muted={muted} badge={section.badge} />
        ))}
        {section.games.length === 0 && (
          <li
            className="rounded-2xl border border-white/10 bg-black/40 py-10 text-center text-[11px] uppercase tracking-[0.3em] text-white/50 backdrop-blur-md"
            style={{ fontWeight: 700 }}
          >
            No games
          </li>
        )}
      </ul>
    </div>
  );
}

function GameRow({
  game,
  muted,
  badge,
}: {
  game: Game | LiveGame;
  muted?: boolean;
  badge: Section["badge"];
}) {
  const home = findTeam(game.homeId);
  const away = findTeam(game.awayId);
  const result = game.result;
  const liveStatus = (game as LiveGame).status;

  const text = muted ? "text-white/55" : "text-white";
  const subtext = muted ? "text-white/30" : "text-white/55";
  const awayWon = result?.winnerId === away.id;
  const homeWon = result?.winnerId === home.id;
  const draw = !!result && result.winnerId === null;

  const awayTeamColor = result
    ? awayWon
      ? "text-white"
      : "text-white/35"
    : text;
  const homeTeamColor = result
    ? homeWon
      ? "text-white"
      : "text-white/35"
    : text;

  const venue = venueDisplayLines(game.stadium);

  return (
    <li className="rounded-2xl border border-white/10 bg-black/40 p-4 backdrop-blur-md backdrop-saturate-150 shadow-[0_8px_22px_rgba(0,0,0,0.35)]">
      {/* ── 메인 행: 시간 | 원정팀 | 스코어/vs | 홈팀 | 뱃지 ── */}
      <div className="flex items-baseline gap-2">
        {/* 시간 */}
        <span
          className={`w-[52px] shrink-0 tabular-nums text-[17px] leading-none tracking-tight ${text}`}
          style={{ fontWeight: 800 }}
        >
          {game.time}
        </span>

        {/* 원정팀 — flex-1 + text-right 로 남은 공간 절반 */}
        <span
          className={`min-w-0 flex-1 truncate text-right text-[17px] leading-none tracking-tight drop-shadow-md ${awayTeamColor}`}
          style={{ fontWeight: 900, textShadow: "0 1px 6px rgba(0,0,0,0.45)" }}
        >
          {away.short}
        </span>

        {/* 스코어 or vs */}
        {result ? (
          <span
            className="shrink-0 min-w-[56px] text-center tabular-nums text-[15px] leading-none tracking-tight"
            style={{ fontWeight: 800 }}
          >
            <span className={awayWon ? "text-white" : "text-white/50"}>{result.awayScore}</span>
            <span className="mx-1 text-white/40">{draw ? "D" : ":"}</span>
            <span className={homeWon ? "text-white" : "text-white/50"}>{result.homeScore}</span>
          </span>
        ) : (
          <span
            className="shrink-0 min-w-[32px] text-center text-[10px] italic text-white/45"
            style={{ fontWeight: 400 }}
          >
            vs
          </span>
        )}

        {/* 홈팀 — flex-1 + text-left */}
        <span
          className={`min-w-0 flex-1 truncate text-left text-[17px] leading-none tracking-tight drop-shadow-md ${homeTeamColor}`}
          style={{ fontWeight: 900, textShadow: "0 1px 6px rgba(0,0,0,0.45)" }}
        >
          {home.short}
        </span>

        {/* 상태 뱃지 */}
        <div className="shrink-0 flex flex-col items-end gap-1">
          {result && (
            <ResultBadge winnerSide={awayWon ? "away" : homeWon ? "home" : "draw"} />
          )}
          {liveStatus === "LIVE" && !result && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[8.5px] uppercase"
              style={{ fontWeight: 800, letterSpacing: "0.2em", color: "#ff4d4d", background: "rgba(255,77,77,0.12)" }}
            >
              <span className="inline-block h-1 w-1 animate-pulse rounded-full" style={{ backgroundColor: "#ff4d4d" }} />
              LIVE
            </span>
          )}
          {liveStatus === "CANCEL" && !result && (
            <span
              className="rounded-full px-2 py-[2px] text-[8.5px] uppercase"
              style={{ fontWeight: 800, letterSpacing: "0.2em", color: "rgba(255,255,255,0.4)", background: "rgba(255,255,255,0.06)" }}
            >
              CXL
            </span>
          )}
        </div>
      </div>

      {/* ── 서브 행: 투수 정보 ── */}
      {!(badge === "PAST" && result) && (
        <p
          className={`mt-2 truncate text-[11px] leading-tight tracking-wide ${subtext}`}
          style={{ fontWeight: 400 }}
        >
          {result ? (
            draw ? (
              <>무승부 · {starterLabel(game.awayPitcher)} vs {starterLabel(game.homePitcher)}</>
            ) : (
              <>{result.winningPitcher ?? "—"}<span className="mx-1.5 text-white/20">·</span>{result.losingPitcher ?? "—"}</>
            )
          ) : (
            <>
              {badge !== "TODAY" && <span className="text-white/40" style={{ fontWeight: 600 }}>선발 </span>}
              {starterLabel(game.awayPitcher)}<span className="mx-1.5 text-white/20">vs</span>{starterLabel(game.homePitcher)}
            </>
          )}
        </p>
      )}

      {/* ── 구장 + HIGHLIGHT ── */}
      <div className="mt-2 flex items-end justify-between gap-2">
        {venue.primary ? (
          <div className={`space-y-0.5 ${muted ? "text-white/38" : "text-white/52"}`}>
            <p className="text-[11px] leading-snug tracking-[0.08em]" style={{ fontWeight: 600 }}>{venue.primary}</p>
            {venue.secondary && (
              <p className={`text-[10px] leading-snug tracking-wide ${muted ? "text-white/28" : "text-white/36"}`} style={{ fontWeight: 400 }}>{venue.secondary}</p>
            )}
          </div>
        ) : <span />}
        <HighlightLink url={game.highlightUrl} muted={muted} />
      </div>
    </li>
  );
}

function ResultBadge({
  winnerSide,
}: {
  winnerSide: "away" | "home" | "draw";
}) {
  const label = winnerSide === "draw" ? "DRAW" : "FT";
  return (
    <span
      className="rounded-full px-2 py-[2px] text-[8.5px] uppercase"
      style={{
        fontWeight: 700,
        letterSpacing: "0.24em",
        color: "rgba(255,255,255,0.55)",
        background: "rgba(255,255,255,0.06)",
      }}
    >
      {label}
    </span>
  );
}

/** 유튜브 하이라이트 — 빨간 브랜드 없음, Play + HIGHLIGHT 만 */
function HighlightLink({
  url,
  muted,
}: {
  url?: string;
  muted?: boolean;
}) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={[
        "inline-flex items-center gap-1.5 bg-transparent",
        "text-[8px] font-medium uppercase tracking-[0.28em]",
        "transition-colors duration-200 ease-out",
        "focus-visible:rounded-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white/25",
        muted ? "text-white/40 hover:text-white" : "text-white/50 hover:text-white",
      ].join(" ")}
      style={{
        fontFamily:
          'ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      }}
    >
      <Play
        size={11}
        strokeWidth={1.15}
        className="shrink-0 opacity-90"
        aria-hidden
      />
      <span>HIGHLIGHT</span>
    </a>
  );
}
