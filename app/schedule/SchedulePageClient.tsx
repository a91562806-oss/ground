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
  const rootRef = useRef<HTMLElement | null>(null);
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

  // 초기 mount 시 TODAY 섹션으로 점프. SSR 덕분에 초기 콘텐츠가 이미 라이브이므로
  // 한 번의 effect 호출로 정확한 위치에 anchor.
  useEffect(() => {
    const root =
      rootRef.current ??
      (document.querySelector("main") instanceof HTMLElement
        ? (document.querySelector("main") as HTMLElement)
        : null);
    if (root && !rootRef.current) rootRef.current = root;
    if (!root) return;
    scrollToSection(todayIndex, "auto");
  }, [todayIndex, scrollToSection]);

  // 폴링으로 새 데이터가 도착했을 때, 사용자가 아직 스크롤하지 않은 첫 갱신 한정으로만
  // 보정 스크롤 (initial 과 동일한 데이터면 영향 없음).
  useEffect(() => {
    if (didLiveScrollRef.current) return;
    if (!live) return;
    if (live === initial) {
      // 첫 SSR 그대로면 폴링 갱신 아님 → 스킵
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
    const root =
      rootRef.current ??
      (document.querySelector("main") instanceof HTMLElement
        ? (document.querySelector("main") as HTMLElement)
        : null);
    if (root && !rootRef.current) rootRef.current = root;
    if (!root) return;

    let touchStartY = 0;
    let touchDeltaY = 0;

    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 8) return;
      e.preventDefault();
      stepSection(e.deltaY > 0 ? 1 : -1);
    };

    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
      touchDeltaY = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? touchStartY;
      touchDeltaY = touchStartY - y;
      e.preventDefault();
    };
    const onTouchEnd = () => {
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
    <li className="group flex items-start gap-5 rounded-2xl border border-white/10 bg-black/40 p-5 backdrop-blur-md backdrop-saturate-150 shadow-[0_8px_22px_rgba(0,0,0,0.35)]">
      <div className="w-24 shrink-0" title={game.stadium || undefined}>
        <span
          className={`block tabular-nums text-[20px] leading-none tracking-tight drop-shadow-md ${text}`}
          style={{
            fontWeight: 800,
            textShadow: "0 1px 6px rgba(0,0,0,0.45)",
          }}
        >
          {game.time}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0 flex flex-1 flex-nowrap items-baseline gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <span
              className={`shrink-0 whitespace-nowrap text-[18px] leading-none tracking-tight drop-shadow-md ${awayTeamColor}`}
              style={{
                fontWeight: 900,
                textShadow: "0 1px 6px rgba(0,0,0,0.45)",
              }}
            >
              {away.short}
            </span>

            {result ? (
              <>
                <span
                  className={`shrink-0 tabular-nums text-[16px] leading-none tracking-tight drop-shadow-md ${
                    awayWon ? "text-white" : "text-white/55"
                  }`}
                  style={{
                    fontWeight: 900,
                    textShadow: "0 1px 6px rgba(0,0,0,0.45)",
                  }}
                >
                  {result.awayScore}
                </span>
                <span
                  className="shrink-0 text-[10px] tracking-[0.3em] text-white/45"
                  style={{ fontWeight: 700 }}
                >
                  {draw ? "D" : ":"}
                </span>
                <span
                  className={`shrink-0 tabular-nums text-[16px] leading-none tracking-tight drop-shadow-md ${
                    homeWon ? "text-white" : "text-white/55"
                  }`}
                  style={{
                    fontWeight: 900,
                    textShadow: "0 1px 6px rgba(0,0,0,0.45)",
                  }}
                >
                  {result.homeScore}
                </span>
              </>
            ) : (
              <span
                className="shrink-0 text-[10px] italic tracking-[0.3em] text-white/50"
                style={{ fontWeight: 400 }}
              >
                vs
              </span>
            )}

            <span
              className={`shrink-0 whitespace-nowrap text-[18px] leading-none tracking-tight drop-shadow-md ${homeTeamColor}`}
              style={{
                fontWeight: 900,
                textShadow: "0 1px 6px rgba(0,0,0,0.45)",
              }}
            >
              {home.short}
            </span>
          </div>

          {result && (
            <div className="flex shrink-0 flex-col items-end gap-1.5 self-baseline">
              <ResultBadge
                winnerSide={awayWon ? "away" : homeWon ? "home" : "draw"}
              />
              <HighlightLink url={game.highlightUrl} muted={muted} />
            </div>
          )}
        </div>

        {!(badge === "PAST" && result) && (
          <p
            className={`mt-1.5 truncate text-[12px] leading-tight tracking-wide ${subtext}`}
            style={{ fontWeight: 400 }}
          >
            {result ? (
              draw ? (
                <>
                  무승부 ·{" "}
                  {badge === "TODAY"
                    ? `${starterLabel(game.awayPitcher)} vs ${starterLabel(game.homePitcher)}`
                    : `선발 ${game.awayPitcher} vs ${game.homePitcher}`}
                </>
              ) : (
                <>
                  {result.winningPitcher ?? "—"}
                  <span className="mx-1.5 text-white/20">·</span>
                  {result.losingPitcher ?? "—"}
                </>
              )
            ) : (
              <>
                {badge === "TODAY" ? null : (
                  <>
                    <span className="text-white/40" style={{ fontWeight: 600 }}>
                      선발
                    </span>{" "}
                  </>
                )}
                {starterLabel(game.awayPitcher)}
                <span className="mx-1.5 text-white/20">vs</span>
                {starterLabel(game.homePitcher)}
              </>
            )}
          </p>
        )}

        {venue.primary ? (
          <div
            className={`mt-2.5 space-y-0.5 ${muted ? "text-white/42" : "text-white/55"}`}
          >
            <p
              className="text-[11px] font-semibold leading-snug tracking-[0.08em]"
              style={{ fontWeight: 600 }}
            >
              {venue.primary}
            </p>
            {venue.secondary ? (
              <p
                className={`text-[10px] font-normal leading-snug tracking-wide normal-case ${
                  muted ? "text-white/30" : "text-white/38"
                }`}
                style={{ fontWeight: 400 }}
              >
                {venue.secondary}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {liveStatus === "LIVE" && !result && (
        <span
          className="ml-2 inline-flex items-center gap-1 self-start rounded-full px-2 py-[2px] text-[8.5px] uppercase"
          style={{
            fontWeight: 800,
            letterSpacing: "0.2em",
            color: "#ff4d4d",
            background: "rgba(255,77,77,0.12)",
          }}
        >
          <span
            className="inline-block h-1 w-1 animate-pulse rounded-full"
            style={{ backgroundColor: "#ff4d4d" }}
          />
          LIVE
        </span>
      )}
      {liveStatus === "CANCEL" && !result && (
        <span
          className="ml-2 self-start rounded-full px-2 py-[2px] text-[8.5px] uppercase"
          style={{
            fontWeight: 800,
            letterSpacing: "0.2em",
            color: "rgba(255,255,255,0.4)",
            background: "rgba(255,255,255,0.06)",
          }}
        >
          CXL
        </span>
      )}
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
