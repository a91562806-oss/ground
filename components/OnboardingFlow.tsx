"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Smartphone } from "lucide-react";
import { TEAMS } from "@/lib/teams";
import LogoImage from "@/components/LogoImage";
import { setMyTeam, ONBOARDING_DONE_KEY } from "@/lib/useMyTeam";
import { getKboTeamThemeByTeamId } from "@/config/teams";
import { usePwaInstallGate } from "@/lib/usePwaInstallGate";
import {
  getOrCreateNotifyUserId,
  persistSubscription,
  registerServiceWorker,
  subscribeBrowserPush,
  type PushTopics,
} from "@/lib/webPushClient";

const ease = [0.22, 1, 0.36, 1] as const;

const DEFAULT_TOPICS: PushTopics = {
  pitcher: true,
  preGame: true,
  postGame: true,
  highlight: true,
  score: true,
  livePitcherChange: true,
  liveStrikeout: true,
};
const NOTIF_PREFS_STORAGE_KEY = "ground-notif-prefs";

const TEAM_SLOGANS: Record<string, string> = {
  lg: "무적 LG! 서울의 자존심",
  kia: "최강 KIA! 타이거즈여 포효하라",
  samsung: "사자 군단 전진! 푸른 피의 자부심",
  doosan: "허슬두! 두산의 투혼은 멈추지 않는다",
  lotte: "마! 승리의 롯데 아이가!",
  ssg: "랜더스여 돌격! 인천은 우리가 지킨다",
  nc: "공룡 군단 집결! 창원의 자부심",
  hanwha: "나는 행복합니다! 이글스여 날아라",
  kt: "마법같은 승리! 위즈 파워 ON",
  kiwoom: "영웅 출격! 고척의 심장을 울려라",
};

type Props = {
  onComplete: () => void;
};

function ShareGuideIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mx-0.5 inline-block align-[-2px]"
      aria-hidden
    >
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

function AddHomeGuideIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mx-0.5 inline-block align-[-2px]"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="5" ry="5" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = hex.trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  const value = Number.parseInt(normalized, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function darkenHex(hex: string, ratio: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const factor = Math.min(1, Math.max(0, 1 - ratio));
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  return `rgb(${clamp(rgb[0] * factor)}, ${clamp(rgb[1] * factor)}, ${clamp(rgb[2] * factor)})`;
}

/** YIQ 기반 대비 — 밝은 배경이면 어두운 텍스트, 어두운 배경이면 흰 텍스트 */
function resolveTextOnBg(bgHex: string): string {
  const rgb = hexToRgb(bgHex);
  if (!rgb) return "#ffffff";
  const yiq = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
  return yiq >= 160 ? "#111111" : "#ffffff";
}

/**
 * 흰 카드 위에 쓸 강조색 선택.
 * accent(secondary)가 흰색/밝은 색이면 primary 를 대신 사용해 가독성 확보.
 * (예: SSG secondary=#FFFFFF → primary #CE0E2D 로 폴백)
 */
function resolveCardAccent(primary: string, accent: string): string {
  const rgb = hexToRgb(accent);
  if (!rgb) return primary;
  const yiq = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
  return yiq > 230 ? primary : accent;
}

export default function OnboardingFlow({ onComplete }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPledgeChecked, setIsPledgeChecked] = useState(false);
  const [installGuide, setInstallGuide] = useState<"none" | "ios" | "android">("none");
  const { isStandalone, os, canPromptInstall, promptInstall } = usePwaInstallGate();

  async function fetchVapidKey(): Promise<string | null> {
    try {
      const res = await fetch("/api/notifications/subscribe", { cache: "no-store" });
      if (!res.ok) return null;
      const data = (await res.json()) as { vapidPublicKey?: unknown };
      return typeof data.vapidPublicKey === "string" && data.vapidPublicKey.trim().length > 0
        ? data.vapidPublicKey
        : null;
    } catch {
      return null;
    }
  }

  const selectedTeam = useMemo(
    () => (selectedTeamId ? TEAMS.find((t) => t.id === selectedTeamId) ?? null : null),
    [selectedTeamId]
  );
  const visualTheme = useMemo(
    () => (selectedTeamId ? getKboTeamThemeByTeamId(selectedTeamId) : null),
    [selectedTeamId]
  );

  useEffect(() => {
    void fetchVapidKey().then((key) => {
      if (key) setVapidPublicKey(key);
    });
  }, []);

  useEffect(() => {
    if (!visualTheme) return;
    document.documentElement.style.setProperty("--app-bg", visualTheme.primary);
    document.documentElement.style.setProperty("--app-text", visualTheme.text);
    document.documentElement.style.setProperty("--app-accent", visualTheme.secondary);
  }, [visualTheme]);

  function chooseTeam(teamId: string) {
    setMyTeam(teamId);
    setSelectedTeamId(teamId);
    setIsPledgeChecked(false);
    setStep(2);
    setErrorMsg(null);
  }

  function goBackToTeamSelect() {
    setStep(1);
    setIsPledgeChecked(false);
    setErrorMsg(null);
  }

  function togglePledge() {
    setIsPledgeChecked((prev) => {
      const next = !prev;
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate(12);
      }
      return next;
    });
  }

  async function completeOnboarding() {
    if (!selectedTeamId) {
      setErrorMsg("먼저 응원팀을 선택해 주세요.");
      return;
    }
    setErrorMsg(null);
    setLoading(true);
    try {
      if (!isStandalone) {
        if (os === "android") {
          const result = await promptInstall();
          if (result === "unavailable") setInstallGuide("android");
          return;
        }
        if (os === "ios") {
          setInstallGuide("ios");
          return;
        }
        setInstallGuide("android");
        return;
      }

      if (!("Notification" in window)) {
        setErrorMsg("이 환경에서는 알림 권한을 지원하지 않아요.");
        return;
      }
      const permission =
        Notification.permission === "default"
          ? await Notification.requestPermission()
          : Notification.permission;
      if (permission !== "granted") {
        setErrorMsg("푸시 알림 권한을 허용해야 시작할 수 있어요.");
        return;
      }
      const resolvedVapidKey = vapidPublicKey ?? (await fetchVapidKey());
      if (!resolvedVapidKey) {
        setErrorMsg("알림 설정 정보를 가져오지 못했어요. 잠시 후 다시 시도해 주세요.");
        return;
      }
      if (!vapidPublicKey) setVapidPublicKey(resolvedVapidKey);

      const reg = await registerServiceWorker();
      if (!reg) {
        setErrorMsg("서비스 워커를 지원하지 않는 브라우저예요.");
        return;
      }
      const sub = await subscribeBrowserPush(reg, resolvedVapidKey);
      const uid = getOrCreateNotifyUserId();
      await persistSubscription(sub, DEFAULT_TOPICS, uid);
      localStorage.setItem(NOTIF_PREFS_STORAGE_KEY, JSON.stringify(DEFAULT_TOPICS));
      localStorage.setItem(ONBOARDING_DONE_KEY, "1");
      onComplete();
    } catch (error) {
      console.error("[onboarding] push setup failed", error);
      setErrorMsg("알림 설정 중 오류가 발생했어요. 다시 시도해 주세요.");
    } finally {
      setLoading(false);
    }
  }

  const themeBg = visualTheme?.primary ?? "#000000";
  const themeText = visualTheme?.text ?? "#ffffff";
  const themeAccent = visualTheme?.secondary ?? "#c30452";
  // 흰 카드 위에서 사용할 안전한 강조색 (SSG처럼 secondary=white인 경우 primary로 폴백)
  const cardAccent = resolveCardAccent(themeBg, themeAccent);
  const cardAccentText = resolveTextOnBg(cardAccent);
  const slogan = selectedTeamId ? TEAM_SLOGANS[selectedTeamId] : null;
  const pinstripe =
    visualTheme?.pattern === "pinstripe-black"
      ? "repeating-linear-gradient(90deg, transparent 0px, transparent 40px, rgba(0,0,0,0.12) 40px, rgba(0,0,0,0.12) 42px)"
      : "none";

  return (
    <div
      className="relative h-dvh overflow-hidden"
      style={{
        backgroundColor: themeBg,
        color: themeText,
        backgroundImage: [pinstripe, `linear-gradient(180deg, ${themeBg} 0%, ${darkenHex(themeBg, 0.16)} 100%)`].join(", "),
      }}
    >
      <AnimatePresence mode="wait">
        {step === 1 ? (
          <motion.div
            key="onboarding-step-1"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease }}
            className="flex h-full flex-col px-5 pb-10 pt-12"
          >
            <p className="text-[11px] uppercase tracking-[0.32em] text-white/50">
              WELCOME TO THE <span className="font-semibold text-white/68">GROUND</span>
            </p>
            <h1 className="mt-3 text-[30px] font-semibold tracking-tight">응원팀을 선택해 주세요</h1>
            <p className="mt-2 text-[13px] text-white/60">선택 즉시 팀 전용 편파 중계 모드로 넘어갑니다.</p>

            <div className="mt-7 min-h-0 flex-1 overflow-y-auto pr-1">
              <ul className="space-y-2">
                {TEAMS.map((team) => (
                  <li key={team.id}>
                    <button
                      type="button"
                      onClick={() => chooseTeam(team.id)}
                      className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-black/20 px-3 py-3 text-left backdrop-blur-sm transition hover:bg-black/30"
                    >
                      <LogoImage teamId={team.id} alt={team.nameEn} size={42} className="h-10 w-10 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[15px] font-semibold">{team.name}</span>
                        <span className="block text-[11px] text-white/60">{team.city}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="onboarding-step-2"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.38, ease }}
            className="flex h-full items-center justify-center px-5"
          >
            <div className="relative w-full max-w-md rounded-3xl border border-black/5 bg-white/95 p-6 shadow-[0_18px_54px_rgba(0,0,0,0.25)] backdrop-blur-lg">
              <button
                type="button"
                onClick={goBackToTeamSelect}
                className="absolute left-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-full border border-gray-200 bg-white/90 text-gray-700 transition hover:bg-gray-50"
                aria-label="팀 다시 선택"
              >
                <ArrowLeft size={16} />
              </button>

              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100">
                {selectedTeam ? (
                  <LogoImage
                    teamId={selectedTeam.id}
                    alt={selectedTeam.name}
                    size={34}
                    className="h-[34px] w-[34px]"
                  />
                ) : null}
              </div>

              {slogan ? (
                <div
                  className="mx-auto mb-3 w-fit rounded-full px-3 py-1 text-sm font-bold"
                  style={{
                    color: cardAccent,
                    backgroundColor: `${cardAccent}22`,
                  }}
                >
                  {slogan}
                </div>
              ) : null}

              <p className="break-keep text-2xl font-bold tracking-tight text-gray-900 md:text-3xl">
                오직 {selectedTeam?.name ?? "선택한 팀"} 팬을 위한 알림을 보내드려요!
              </p>
              <p className="mt-3 break-keep text-base font-medium leading-relaxed text-gray-500">
                야구장 밖에서도 경기는 계속됩니다. 라인업 발표부터 실시간 스코어, 경기 후
                하이라이트까지, 모든 순간을 가장 먼저 전해드립니다.
              </p>

              {errorMsg ? <p className="mt-3 text-[12px] text-rose-500">{errorMsg}</p> : null}

              <motion.button
                type="button"
                onClick={togglePledge}
                whileTap={{ scale: 0.98 }}
                className="mt-5 flex w-full items-start gap-3 rounded-2xl border border-gray-200 bg-gray-50/90 px-3 py-3 text-left"
                aria-pressed={isPledgeChecked}
              >
                <motion.span
                  animate={{
                    scale: isPledgeChecked ? 1.06 : 1,
                    backgroundColor: isPledgeChecked ? cardAccent : "rgba(255,255,255,0)",
                    borderColor: isPledgeChecked ? cardAccent : "rgba(107,114,128,0.45)",
                  }}
                  transition={{ duration: 0.18 }}
                  className="mt-[1px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border"
                >
                  <motion.span
                    initial={false}
                    animate={{ opacity: isPledgeChecked ? 1 : 0, scale: isPledgeChecked ? 1 : 0.7 }}
                    className="text-[12px] font-bold text-white"
                  >
                    ✓
                  </motion.span>
                </motion.span>
                <span className="break-keep text-[13px] font-medium leading-relaxed text-gray-700">
                  나는 타 팀 스파이가 아니며, 오직 {selectedTeam?.name ?? "선택한 팀"}의 우승만을
                  염원합니다. ⚾️
                </span>
              </motion.button>

              <button
                type="button"
                onClick={() => void completeOnboarding()}
                disabled={loading || !isPledgeChecked}
                className="mt-6 w-full rounded-2xl px-4 py-4 text-[14px] font-semibold tracking-wide transition disabled:cursor-not-allowed disabled:opacity-55"
                style={{
                  backgroundColor: cardAccent,
                  color: cardAccentText,
                  boxShadow: `0 10px 30px ${cardAccent}55`,
                }}
              >
                {loading ? "설정 중..." : "편파 알림 켜고 시작하기"}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {installGuide !== "none" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[250] bg-black/60 backdrop-blur-sm"
          >
            <motion.div
              initial={{ y: 30, opacity: 0.96 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 30, opacity: 0.96 }}
              transition={{ duration: 0.24, ease }}
              className="absolute inset-x-4 bottom-6 mx-auto max-w-md rounded-2xl border border-white/12 bg-[#111218]/92 p-5 text-white"
            >
              <p className="text-[16px] font-semibold leading-snug">
                GROUND를 사용하려면 홈화면에 추가가 필요해요 ⚾️
              </p>
              {installGuide === "ios" ? (
                <div
                  className="mt-4 space-y-2 text-[13px] leading-relaxed text-white/85"
                  style={{
                    fontFamily:
                      "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
                  }}
                >
                  <p>
                    #1. 사파리 하단 <ShareGuideIcon />
                    <span className="font-semibold">공유</span> 버튼(사각형 + 위 화살표)을 선택하세요.
                  </p>
                  <p className="text-white/70">
                    (공유 버튼이 안 보인다면, 주소창 옆 ... 버튼을 선택하면 나와요!)
                  </p>
                  <p>
                    #2. 메뉴를 스크롤하여 <AddHomeGuideIcon />
                    <span className="font-semibold">홈 화면에 추가</span>를 선택하세요.
                  </p>
                </div>
              ) : (
                <div className="mt-4 space-y-2 text-[13px] text-white/85">
                  <p className="flex items-center gap-2">
                    <Smartphone size={15} />
                    {canPromptInstall
                      ? "설치 팝업이 닫혔다면 다시 설치를 진행해 주세요."
                      : "우측 상단 메뉴(⋮)에서 [홈 화면에 추가]를 눌러 설치해 주세요."}
                  </p>
                </div>
              )}
              <button
                type="button"
                onClick={() => setInstallGuide("none")}
                className="mt-5 w-full rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-[13px] font-medium text-white/88 hover:bg-white/10"
              >
                다음에 할게요
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
