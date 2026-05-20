"use client";

import Link from "next/link";
import { Cormorant_Garamond } from "next/font/google";
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { CloudRain, User } from "lucide-react";
import { findTeam, heroLeftEpithetLabel, type Team } from "@/lib/teams";
import {
  getKboTeamThemeByTeamId,
  pickSlogan,
  splitSloganForDisplay,
} from "@/config/teams";
import NotificationBell from "@/components/NotificationBell";
import ShareButton from "@/components/ShareButton";
import InsightOverlay from "@/components/today/InsightOverlay";
import LineupSheet from "@/components/today/LineupSheet";
import { useWeather, type WeatherInfo } from "@/lib/useWeather";
import { useKboToday } from "@/lib/useKboToday";
import { getTeamGame, starterLabel, type LineupItem, type LiveGame } from "@/lib/kbo";
import type { TodayStoryImageInput } from "@/lib/buildTodayStoryImage";
import { venueCityOnly, venueDisplayLines } from "@/lib/venue";

const ease = [0.22, 1, 0.36, 1] as const;

/** 영문 슬로건 · VS · 스코어 — 포스터형 세리프 */
const displaySerif = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

/** 한글 슬로건 줄만 Pretendard 유지, 영문 줄은 Cormorant(displaySerif) */
function hasHangul(s: string): boolean {
  return /[\u3131-\u318E\uAC00-\uD7A3]/.test(s);
}

/** 팀명 공통 메트릭 — globals.css 의 Black Han Sans(한글 포함 전체 서브셋) */
const TEAM_SHORT_STYLE = {
  fontSize: "clamp(28px, 7.2vw, 46px)",
  lineHeight: 0.92,
  letterSpacing: "-0.05em",
} as const;

type Props = {
  team: Team;
};

function getTodayMatch(team: Team, liveGames?: LiveGame[] | null) {
  // 라이브 KBO 데이터에 오늘 경기가 있으면 그쪽만 사용.
  // 월요일/휴식일엔 "경기 없음" 상태를 정직하게 보여준다.
  const liveGame =
    liveGames?.find((g) => g.awayId === team.id || g.homeId === team.id) ?? null;
  if (!liveGame) return null;
  const game = liveGame;
  const isHome = game.homeId === team.id;
  const homeTeam = findTeam(game.homeId);
  const awayTeam = findTeam(game.awayId);
  const opponent = isHome ? awayTeam : homeTeam;
  return { game, homeTeam, awayTeam, opponent, isHome, isLive: Boolean(liveGame) };
}

/** OpenWeather condition(영문 main) → 짧은 한글 라벨 */
const KO_WEATHER: Record<string, string> = {
  Clear: "맑음",
  Clouds: "흐림",
  Rain: "비",
  Drizzle: "이슬비",
  Thunderstorm: "뇌우",
  Snow: "눈",
  Mist: "안개",
  Fog: "안개",
  Haze: "안개",
  Smoke: "연무",
  Dust: "황사",
  Sand: "모래",
  Squall: "돌풍",
  Tornado: "토네이도",
};

function formatWeather(w: WeatherInfo): string | null {
  if (w.loading) return null;
  if (!w.condition || w.condition === "Unknown") return null;
  const label = KO_WEATHER[w.condition] ?? w.condition;
  if (typeof w.temp === "number") return `${label} ${Math.round(w.temp)}°`;
  return label;
}

const KO_DOW = ["일", "월", "화", "수", "목", "금", "토"];

/** "2026-04-19" → "4월 19일 · 일" (UTC 기준 — 시간대 영향 X) */
function formatMatchDate(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return "";
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const dow = KO_DOW[d.getUTCDay()];
  return `${month}월 ${day}일 · ${dow}`;
}

/** YYYY-MM-DD + HH:mm → KST 시작 시각(ms, UTC 기준 타임스탬프) */
function gameStartMsKst(date: string, time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!date || !m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (
    !Number.isFinite(hh) ||
    !Number.isFinite(mm) ||
    hh < 0 ||
    hh > 23 ||
    mm < 0 ||
    mm > 59
  ) {
    return null;
  }
  const iso = `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 남은 초 → `HH:MM:SS` (표시 상한 99:59:59) */
function formatCountdownHms(totalSeconds: number): string {
  const cap = 99 * 3600 + 59 * 60 + 59;
  const sec = Math.min(cap, Math.max(0, Math.floor(totalSeconds)));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function formatVisibleUntilKst(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const month = kst.getUTCMonth() + 1;
  const day = kst.getUTCDate();
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mm = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${month}/${day} ${hh}:${mm}까지`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = hex.trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  const value = Number.parseInt(normalized, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function clampColor(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)));
}

function darkenHex(hex: string, ratio: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const factor = Math.min(1, Math.max(0, 1 - ratio));
  return `rgb(${clampColor(rgb[0] * factor)}, ${clampColor(rgb[1] * factor)}, ${clampColor(rgb[2] * factor)})`;
}

function resolveButtonTextColor(bgHex: string): string {
  const rgb = hexToRgb(bgHex);
  if (!rgb) return "#ffffff";
  // YIQ luminance heuristic: high luminance backgrounds get dark text.
  const yiq = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
  return yiq >= 160 ? "#111111" : "#ffffff";
}

const PREVIEW_DISMISS_KEY = "ground-pregame-preview-dismiss-v2";
const POSTGAME_DISMISS_KEY = "ground-postgame-report-dismiss-v2";

export default function HeroCard({ team }: Props) {
  // ── 라이브 KBO 데이터 (60s 폴링, 실패 시 폴백) ──
  const live = useKboToday(team.id, { withStandings: false });
  const match = useMemo(
    () => getTodayMatch(team, live?.games),
    [team, live?.games]
  );
  // 라이브 view — 점수/상태/승리 정보 추출용
  const liveView = useMemo(
    () => (live ? getTeamGame(live.games, team.id) : null),
    [live, team.id]
  );
  // (구) "현재 N위" 배지는 /rank 탭으로 이전되어 HeroCard 에서는 더 이상 표기 X.

  // ── 날씨 — 구장 좌표 기반 ──
  const weather = useWeather(match?.game.stadium);
  const isRainy = weather.isRainy;
  const weatherLabel = formatWeather(weather);

  // today 배경은 생성/로딩 없이 검정 고정.
  const resolvedSrc: string | null = null;

  // ── 슬로건 — 우천이면 sloganRainy 우선, 아니면 sloganReady ──
  const sloganText =
    pickSlogan(team.id, "ready", isRainy) ?? team.manifestoEn;
  const lines = splitSloganForDisplay(sloganText);
  const sloganOneLine =
    lines.length === 0
      ? ""
      : sloganText.includes("\n")
        ? lines.join(" · ")
        : lines.join(" ");

  const dateLabel = formatMatchDate(match?.game.date);
  const feedStatus = live?.status ?? "NORMAL";
  const feedMessage =
    live?.message ??
    (feedStatus === "MONDAY_OFF"
      ? "오늘 월요일이라 야구 없다... 무슨 낙으로 사냐 😭"
      : feedStatus === "RAIN_CANCELLED"
        ? "하... 비 와서 오늘 경기 취소됨 🌧️ 투수 로테이션 개이득인가?"
        : null);

  const gameStartMs = useMemo(() => {
    if (!match?.game.date || !match.game.time) return null;
    return gameStartMsKst(match.game.date, match.game.time);
  }, [match?.game.date, match?.game.time]);

  const showHeroCountdown =
    Boolean(match) &&
    liveView?.game.status !== "LIVE" &&
    liveView?.game.status !== "RESULT" &&
    liveView?.game.status !== "CANCEL" &&
    !liveView?.game.result &&
    !match?.game.result;

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!showHeroCountdown || gameStartMs == null) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [showHeroCountdown, gameStartMs, match?.game.id]);

  const countdownHms =
    showHeroCountdown && gameStartMs != null
      ? formatCountdownHms(Math.floor((gameStartMs - nowMs) / 1000))
      : null;
  const pregamePreview = live?.pregamePreview ?? null;
  const previewDateKey = live?.date ?? "";
  const previewDismissKey = `${team.id}:${previewDateKey}`;
  const [isPregamePreviewDismissed, setIsPregamePreviewDismissed] = useState(false);
  const showPregamePreview =
    Boolean(match) &&
    live?.gamePhase === "PRE" &&
    Boolean(pregamePreview?.active) &&
    !isPregamePreviewDismissed;
  const postGameReport = live?.postGameReport ?? null;
  const postGameDismissKey = `${team.id}:${live?.date ?? ""}`;
  // localStorage 기반 영구 숨김 (다시 보지 않기)
  const [isPostGameReportDismissed, setIsPostGameReportDismissed] = useState(false);
  // 세션 내 임시 닫기 (X 버튼) — 앱 재시작 시 초기화됨
  const [isPostGameReportClosed, setIsPostGameReportClosed] = useState(false);
  const showPostGameReport = Boolean(postGameReport?.active);
  const postGameVisibleUntilLabel = formatVisibleUntilKst(postGameReport?.visibleUntil);

  useEffect(() => {
    if (!previewDateKey) return;
    try {
      const raw = localStorage.getItem(PREVIEW_DISMISS_KEY);
      if (!raw) {
        setIsPregamePreviewDismissed(false);
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      setIsPregamePreviewDismissed(Boolean(parsed[previewDismissKey]));
    } catch {
      setIsPregamePreviewDismissed(false);
    }
  }, [previewDateKey, previewDismissKey]);

  function dismissPregamePreviewForToday() {
    try {
      const raw = localStorage.getItem(PREVIEW_DISMISS_KEY);
      const parsed = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      parsed[previewDismissKey] = true;
      localStorage.setItem(PREVIEW_DISMISS_KEY, JSON.stringify(parsed));
    } catch {
      // ignore
    }
    setIsPregamePreviewDismissed(true);
  }

  useEffect(() => {
    if (!live?.date) return;
    try {
      const raw = localStorage.getItem(POSTGAME_DISMISS_KEY);
      if (!raw) {
        setIsPostGameReportDismissed(false);
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      setIsPostGameReportDismissed(Boolean(parsed[postGameDismissKey]));
    } catch {
      setIsPostGameReportDismissed(false);
    }
  }, [live?.date, postGameDismissKey]);

  function dismissPostGameReportForToday() {
    try {
      const raw = localStorage.getItem(POSTGAME_DISMISS_KEY);
      const parsed = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      parsed[postGameDismissKey] = true;
      localStorage.setItem(POSTGAME_DISMISS_KEY, JSON.stringify(parsed));
    } catch {
      // ignore
    }
    setIsPostGameReportDismissed(true);
  }

  const activeInsightOverlay =
    showPostGameReport && !isPostGameReportDismissed && !isPostGameReportClosed
      ? { kind: "postgame" as const }
      : showPregamePreview
        ? { kind: "pregame" as const }
        : null;

  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const [keyboardInsetPx, setKeyboardInsetPx] = useState(0);
  const [isLineupOpen, setIsLineupOpen] = useState(false);
  const selectedTeamTheme = useMemo(
    () =>
      getKboTeamThemeByTeamId(team.id) ?? {
        name: team.name,
        primary: "#000000",
        secondary: team.accent,
        text: "#FFFFFF",
        pattern: "none" as const,
      },
    [team.id, team.name, team.accent]
  );
  // 테마는 "선택된 팀"에만 묶고, 실시간 스코어 리렌더와 분리한다.
  const [lockedTheme, setLockedTheme] = useState(selectedTeamTheme);
  useEffect(() => {
    setLockedTheme(selectedTeamTheme);
  }, [selectedTeamTheme]);

  const textRgb = hexToRgb(lockedTheme.text) ?? [255, 255, 255];
  const primaryRgb = hexToRgb(lockedTheme.primary) ?? [0, 0, 0];
  const isWhiteBase =
    primaryRgb[0] > 246 && primaryRgb[1] > 246 && primaryRgb[2] > 246;
  const gradientBottom = isWhiteBase ? "#F9FAFB" : darkenHex(lockedTheme.primary, 0.2);
  const themedText = (alpha: number) =>
    `rgba(${textRgb[0]}, ${textRgb[1]}, ${textRgb[2]}, ${alpha})`;
  const accentColor = lockedTheme.secondary;
  const accentButtonText = resolveButtonTextColor(accentColor);
  const isLightThemeText = lockedTheme.text.toUpperCase() === "#000000";
  const isLgSeoulSlogan =
    team.id === "lg" && sloganOneLine.toUpperCase().includes("SEOUL IS OURS");
  const selectedTeamLineup = useMemo<LineupItem[]>(() => {
    if (!liveView) return [];
    const source = liveView.side === "home" ? liveView.game.homeLineup : liveView.game.awayLineup;
    return source ?? [];
  }, [liveView]);
  const hasSelectedTeamLineup = selectedTeamLineup.length > 0;

  useEffect(() => {
    if (!hasSelectedTeamLineup) setIsLineupOpen(false);
  }, [hasSelectedTeamLineup]);

  useEffect(() => {
    document.documentElement.style.setProperty("--app-bg", lockedTheme.primary);
    document.documentElement.style.setProperty("--app-text", lockedTheme.text);
    document.documentElement.style.setProperty("--app-accent", lockedTheme.secondary);
    return () => {
      document.documentElement.style.setProperty("--app-bg", "#000000");
      document.documentElement.style.setProperty("--app-text", "#ffffff");
      document.documentElement.style.setProperty("--app-accent", "#c30452");
    };
  }, [lockedTheme.primary, lockedTheme.secondary, lockedTheme.text]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;

    const setHeightVar = () => {
      const visualHeight = Math.max(
        320,
        Math.min(window.innerHeight, Math.round(vv.height + vv.offsetTop))
      );
      const keyboardGap = Math.max(0, Math.round(window.innerHeight - visualHeight));
      const needsCompensation =
        Math.round(vv.height) >= window.innerHeight - 1 && keyboardGap > 0;
      setIsKeyboardOpen(keyboardGap > 120);
      setKeyboardInsetPx(needsCompensation ? keyboardGap : 0);
      document.documentElement.style.setProperty(
        "--visual-viewport-height",
        `${visualHeight}px`
      );
    };

    setHeightVar();
    vv.addEventListener("resize", setHeightVar);
    return () => {
      vv.removeEventListener("resize", setHeightVar);
      setKeyboardInsetPx(0);
      document.documentElement.style.setProperty(
        "--visual-viewport-height",
        "100dvh"
      );
    };
  }, []);

  /** 응원팀(team) 항상 좌측, 상대 우측 */
  const heroMatch = useMemo(() => {
    if (!match) return null;
    const leftIsAway = team.id === match.awayTeam.id;
    return {
      leftTeam: leftIsAway ? match.awayTeam : match.homeTeam,
      rightTeam: leftIsAway ? match.homeTeam : match.awayTeam,
      leftPitcher: leftIsAway ? match.game.awayPitcher : match.game.homePitcher,
      rightPitcher: leftIsAway ? match.game.homePitcher : match.game.awayPitcher,
      leftIsAway,
      venueCity: venueCityOnly(match.game.stadium),
    };
  }, [match, team.id]);

  const leftHeroEpithet = heroMatch
    ? heroLeftEpithetLabel(heroMatch.leftTeam.id)
    : null;

  /** 날짜 아래 가운데 장소 — 짧은 지역 + (다르면) 풀 구장명 */
  const venueUnderDate = useMemo(() => {
    if (!match) return { primary: "", secondary: "" as string };
    return venueDisplayLines(match.game.stadium);
  }, [match]);

  const todayStoryShare = useMemo((): TodayStoryImageInput | null => {
    const metaLine = match
      ? [
          `${match.awayTeam.short} vs ${match.homeTeam.short}`,
          dateLabel || null,
          match.game.time,
          venueUnderDate.primary || null,
        ]
          .filter(Boolean)
          .join(" · ")
      : undefined;
    const startersLine = match
      ? `선발 ${starterLabel(match.game.awayPitcher)} · ${starterLabel(match.game.homePitcher)}`
      : undefined;
    return {
      posterSrc: resolvedSrc ?? "",
      teamHeadline: `${team.short} · ${team.name}`,
      slogan: sloganOneLine,
      metaLine,
      startersLine,
      accentHex: accentColor,
    };
  }, [
    resolvedSrc,
    team.short,
    team.name,
    accentColor,
    sloganOneLine,
    match,
    dateLabel,
    venueUnderDate.primary,
  ]);

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{
        background: [
          `radial-gradient(120% 70% at 50% 18%, rgba(255,255,255,${
            isLightThemeText ? "0.22" : "0.16"
          }) 0%, rgba(255,255,255,0) 60%)`,
          `linear-gradient(180deg, ${lockedTheme.primary} 0%, ${gradientBottom} 100%)`,
        ].join(", "),
        color: lockedTheme.text,
      }}
    >
      {lockedTheme.pattern === "pinstripe-black" && (
        <div
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            background:
              "repeating-linear-gradient(90deg, transparent 0px, transparent 40px, rgba(0,0,0,0.12) 40px, rgba(0,0,0,0.12) 42px)",
          }}
        />
      )}
      {/*
        하단 웅장한 암부 그라데이션 — 패널 없이 텍스트만 얹어도 대비 확보.
      */}
      <div
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{
          background: [
            isLightThemeText
              ? "linear-gradient(180deg, rgba(255,255,255,0.24) 0%, transparent 24%)"
              : "linear-gradient(180deg, rgba(0,0,0,0.32) 0%, transparent 24%)",
            isLightThemeText
              ? "linear-gradient(0deg, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.78) 12%, rgba(255,255,255,0.48) 28%, rgba(255,255,255,0.18) 45%, transparent 62%)"
              : "linear-gradient(0deg, #000000 0%, rgba(0,0,0,0.94) 12%, rgba(0,0,0,0.72) 28%, rgba(0,0,0,0.35) 45%, transparent 62%)",
          ].join(", "),
        }}
      />

      {/* ── 좌상단: 프로필 (/my) — 공유·알림과 동일 터치 타겟 h-11 w-11 ── */}
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.7, ease, delay: 0.15 }}
        className="absolute left-5 top-5 z-30"
      >
        <motion.div whileTap={{ scale: 0.9 }}>
          <Link
            href="/my"
            aria-label="응원팀 변경"
            className="flex h-11 w-11 items-center justify-center rounded-full"
          >
            <User
              size={21}
              strokeWidth={1.5}
              className="text-white/85"
              style={{
                color: themedText(0.86),
                filter: "drop-shadow(0 1px 4px rgba(0,0,0,0.55))",
              }}
            />
          </Link>
        </motion.div>
      </motion.div>

      {/* ── 우상단: 공유 (벨 옆에 살짝 왼쪽) ── */}
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.7, ease, delay: 0.18 }}
        className="absolute right-[60px] top-5 z-30"
      >
        <ShareButton
          title="KBO TODAY"
          text={
            match
              ? `${match.awayTeam.short} vs ${match.homeTeam.short} — ${formatMatchDate(match.game.date)}`
              : `${team.short} — ${team.nameEn}`
          }
          todayStory={todayStoryShare}
          iconColor={themedText(0.98)}
        />
      </motion.div>

      {/* ── 우상단: 알림 종 ── */}
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.7, ease, delay: 0.2 }}
      >
        <NotificationBell accent={accentColor} iconColor={themedText(0.98)} />
      </motion.div>

      {activeInsightOverlay?.kind === "pregame" ? (
        <InsightOverlay
          kind="pregame"
          pregamePreview={pregamePreview}
          onClose={() => setIsPregamePreviewDismissed(true)}
          onDismiss={dismissPregamePreviewForToday}
        />
      ) : activeInsightOverlay?.kind === "postgame" ? (
        <InsightOverlay
          kind="postgame"
          postGameReport={postGameReport}
          postGameVisibleUntilLabel={postGameVisibleUntilLabel}
          onClose={() => setIsPostGameReportClosed(true)}
          onDismiss={dismissPostGameReportForToday}
        />
      ) : (
        <InsightOverlay kind={null} />
      )}

      {/* ── 경기 없음: 하단 그라데이션 위 중앙 스택 (글래스 없음) ── */}
      {!match && (
        <motion.div
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.85, ease, delay: 0.18 }}
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center px-7 text-center ${
            isKeyboardOpen
              ? "pb-[calc(9rem+env(safe-area-inset-bottom,0px))] pt-[6vh]"
              : "pb-[calc(13rem+env(safe-area-inset-bottom,0px))] pt-[14vh]"
          }`}
        >
          <div className="flex max-w-md flex-col items-center">
            <motion.p
              key={`${team.id}-${sloganText}-1l`}
              initial={{
                opacity: 0,
                letterSpacing: hasHangul(sloganOneLine) ? "-0.02em" : "0.2em",
              }}
              animate={{
                opacity: 1,
                letterSpacing: hasHangul(sloganOneLine) ? "-0.02em" : "0.1em",
              }}
              transition={{ duration: 1.05, ease, delay: 0.12 }}
              className={
                hasHangul(sloganOneLine)
                  ? "text-white"
                  : `text-white ${displaySerif.className}`
              }
              style={{
                color: isLgSeoulSlogan ? accentColor : themedText(0.92),
                fontWeight: hasHangul(sloganOneLine) ? 700 : 600,
                fontSize: hasHangul(sloganOneLine)
                  ? "clamp(18px, 5.07vw, 26px)"
                  : "clamp(21px, 5.98vw, 34px)",
                lineHeight: 1.35,
                textTransform: hasHangul(sloganOneLine) ? "none" : "uppercase",
                filter: isRainy ? "blur(0.2px)" : undefined,
                textShadow: isLgSeoulSlogan
                  ? "0 1px 0 rgba(255,255,255,0.45), 0 0 10px rgba(195,4,82,0.3)"
                  : undefined,
              }}
            >
              {sloganOneLine}
            </motion.p>
            {feedMessage ? (
              <motion.p
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease, delay: 0.2 }}
                className="mt-4 px-2 text-[14px] font-semibold leading-relaxed"
                style={{ color: themedText(0.86) }}
              >
                {feedMessage}
              </motion.p>
            ) : null}
          </div>
        </motion.div>
      )}

      {/*
        경기 있음: 응원팀 좌측 · 팀명·선발 · 슬로건 · 날짜 · 날씨 · 맨 아래 도시만
      */}
      {match && heroMatch && (
        <motion.div
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease, delay: 0.22 }}
          className={`absolute inset-x-0 bottom-0 z-20 flex flex-col items-center px-6 text-center ${
            isKeyboardOpen
              ? "pb-[calc(10.5rem+env(safe-area-inset-bottom,0px))] pt-[3vh]"
              : "pb-[calc(15rem+env(safe-area-inset-bottom,0px))] pt-[8vh]"
          }`}
        >
          <div className="max-w-md shrink-0 px-1">
            <motion.p
              key={`${team.id}-${sloganText}-hero-top`}
              initial={{
                opacity: 0,
                letterSpacing: hasHangul(sloganOneLine) ? "-0.02em" : "0.18em",
              }}
              animate={{
                opacity: 1,
                letterSpacing: hasHangul(sloganOneLine) ? "-0.02em" : "0.08em",
              }}
              transition={{ duration: 0.95, ease, delay: 0.08 }}
              className={
                hasHangul(sloganOneLine)
                  ? "text-white/88"
                  : `text-white/85 ${displaySerif.className}`
              }
              style={{
                color: isLgSeoulSlogan ? accentColor : themedText(0.84),
                fontWeight: hasHangul(sloganOneLine) ? 600 : 550,
                fontSize: hasHangul(sloganOneLine)
                  ? "clamp(16px, 4.16vw, 20px)"
                  : "clamp(16px, 4.29vw, 21px)",
                lineHeight: 1.45,
                textTransform: hasHangul(sloganOneLine) ? "none" : "uppercase",
                textShadow: isLgSeoulSlogan
                  ? "0 1px 0 rgba(255,255,255,0.4), 0 0 8px rgba(195,4,82,0.25)"
                  : undefined,
              }}
            >
              {sloganOneLine}
            </motion.p>
          </div>

          {/*
            max-content 3열 — 1fr 대칭이 아니라 내용 너비만 쓰고 VS 를 가운데에 두어
            팀명 길이가 달라도 "팀 · VS · 팀" 이 한 덩어로 중앙에 모인다.
          */}
          <div className="mx-auto mt-7 w-max max-w-[min(100%,36rem)] shrink-0">
            <div className="grid grid-cols-[max-content_auto_max-content] grid-rows-[auto_auto] items-end gap-x-4 gap-y-2 sm:gap-x-5">
              <div className="min-w-0 justify-self-end text-right">
                <div className="flex flex-col items-end justify-end gap-0 leading-none">
                  {leftHeroEpithet ? (
                    <p
                      className="mb-1.5 w-full text-left text-[clamp(11px,2.6vw,17px)] leading-none tracking-[0.02em] text-white/58"
                      style={{ fontWeight: 200, color: themedText(0.58) }}
                    >
                      {leftHeroEpithet}
                    </p>
                  ) : null}
                  <span
                    className="inline-block origin-bottom font-['Black_Han_Sans',sans-serif] text-white"
                    style={{
                      ...TEAM_SHORT_STYLE,
                      transform: "skewX(-9deg)",
                      color: themedText(0.95),
                      textShadow: "none",
                    }}
                  >
                    {heroMatch.leftTeam.short}
                  </span>
                </div>
              </div>

              <div className="flex min-h-[2.75rem] items-end justify-center self-end px-1 pb-0.5">
                {liveView?.game.result ? (
                  <span
                    className={`tabular-nums text-white/95 ${displaySerif.className}`}
                    style={{
                      color: themedText(0.95),
                      fontWeight: 600,
                      fontSize: "clamp(20px, 5.2vw, 30px)",
                      letterSpacing: "0.04em",
                      lineHeight: 1,
                    }}
                  >
                    {heroMatch.leftIsAway
                      ? liveView.game.result.awayScore
                      : liveView.game.result.homeScore}
                    <span className="mx-2 font-light text-white/28">:</span>
                    {heroMatch.leftIsAway
                      ? liveView.game.result.homeScore
                      : liveView.game.result.awayScore}
                  </span>
                ) : (
                  <span
                    className={`${displaySerif.className} uppercase text-white/36`}
                    style={{
                      color: themedText(0.36),
                      fontWeight: 500,
                      fontSize: "9px",
                      letterSpacing: "0.38em",
                      lineHeight: 1,
                    }}
                  >
                    vs
                  </span>
                )}
              </div>

              <div className="min-w-0 justify-self-start text-left">
                <span
                  className="inline-block origin-bottom font-['Black_Han_Sans',sans-serif] text-white/92"
                  style={{
                    ...TEAM_SHORT_STYLE,
                    transform: "skewX(-9deg)",
                    color: themedText(0.9),
                    textShadow: "none",
                  }}
                >
                  {heroMatch.rightTeam.short}
                </span>
              </div>

              <div className="flex min-h-[1.35rem] items-start justify-end justify-self-end">
                <span
                  className="text-right text-[11px] font-semibold leading-snug tracking-wide text-white/72"
                  style={{ color: themedText(0.72) }}
                >
                  {starterLabel(heroMatch.leftPitcher)}
                </span>
              </div>
              <div aria-hidden className="min-h-[1.35rem]" />
              <div className="flex min-h-[1.35rem] items-start justify-start justify-self-start">
                <span
                  className="text-left text-[11px] font-semibold leading-snug tracking-wide text-white/68"
                  style={{ color: themedText(0.68) }}
                >
                  {starterLabel(heroMatch.rightPitcher)}
                </span>
              </div>
            </div>
          </div>

          {countdownHms ? (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.55, ease, delay: 0.32 }}
              className="mt-6 text-[11px] font-medium tabular-nums tracking-[0.32em] text-white/52"
              style={{ color: themedText(0.52) }}
              aria-label="경기 시작까지 남은 시간"
            >
              {countdownHms}
            </motion.p>
          ) : null}
          {hasSelectedTeamLineup && (
            <motion.button
              type="button"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease, delay: 0.35 }}
              onClick={() => setIsLineupOpen(true)}
              className={`mt-4 inline-flex items-center rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.08em] text-white shadow-[0_8px_24px_rgba(0,0,0,0.35)] ${
                liveView?.game.result ? "" : "animate-pulse"
              }`}
              style={{
                backgroundColor: accentColor,
                color: accentButtonText,
              }}
            >
              🔥 선발 라인업 확인
            </motion.button>
          )}

          <div
            className={`mx-auto w-full max-w-md text-center ${countdownHms ? "mt-8" : "mt-10"}`}
          >
            <p
              className="text-[11px] font-normal uppercase tracking-[0.22em] text-white/58 tabular-nums"
              style={{ fontWeight: 400, color: themedText(0.58) }}
            >
              {dateLabel ? (
                <>
                  <span>{dateLabel}</span>
                  <span className="mx-2 text-white/25">·</span>
                </>
              ) : null}
              <span>{match.game.time}</span>
              {liveView?.game.status === "LIVE" && (
                <>
                  <span className="mx-2 text-white/25">·</span>
                  <span className="inline-flex items-center gap-1.5 font-medium tracking-[0.18em] text-[#ff5c5c]">
                    <span
                      className="inline-block h-1 w-1 animate-pulse rounded-full bg-[#ff5c5c]"
                      aria-hidden
                    />
                    LIVE
                  </span>
                </>
              )}
              {liveView?.game.status === "RESULT" && (
                <>
                  <span className="mx-2 text-white/25">·</span>
                  <span className="text-white/45">종료</span>
                </>
              )}
            </p>
            {feedStatus === "RAIN_CANCELLED" && feedMessage ? (
              <p
                className="mt-3 px-2 text-[13px] font-semibold leading-relaxed"
                style={{ color: themedText(0.8) }}
              >
                {feedMessage}
              </p>
            ) : null}
            {venueUnderDate.primary ? (
              <div className="mt-2.5 space-y-1">
                <p
                  className="text-[12px] font-semibold leading-snug tracking-[0.14em] text-white/55"
                  style={{ fontWeight: 600, color: themedText(0.55) }}
                >
                  {venueUnderDate.primary}
                </p>
                {venueUnderDate.secondary ? (
                  <p
                    className="px-3 text-[10px] font-normal leading-snug tracking-wide text-white/38 normal-case"
                    style={{ fontWeight: 400, color: themedText(0.38) }}
                  >
                    {venueUnderDate.secondary}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div
            className="mt-6 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[10px] font-medium uppercase tracking-[0.2em] text-white/38"
            style={{ color: themedText(0.38) }}
          >
            {weatherLabel && (
              <motion.span
                key={weatherLabel}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.45, ease, delay: 0.4 }}
                title={weather.description || undefined}
              >
                {weatherLabel}
              </motion.span>
            )}
            {isRainy && (
              <motion.span
                initial={{ opacity: 0, x: -3 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.5, ease, delay: 0.5 }}
                className="ml-1 inline-flex items-center"
                aria-label="수중전 진행 중"
                title="수중전 진행 중"
              >
                <motion.span
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{
                    duration: 2.2,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                >
                  <CloudRain
                    size={11}
                    strokeWidth={1.5}
                    className="text-sky-300/70"
                    style={{
                      filter: "drop-shadow(0 0 3px rgba(140,180,220,0.35))",
                    }}
                  />
                </motion.span>
              </motion.span>
            )}
          </div>
        </motion.div>
      )}
      <LineupSheet
        open={isLineupOpen && hasSelectedTeamLineup}
        onClose={() => setIsLineupOpen(false)}
        teamShort={team.short}
        lineup={selectedTeamLineup}
        accentColor={accentColor}
        isLightThemeText={isLightThemeText}
        themedText={themedText}
      />
    </div>
  );
}
