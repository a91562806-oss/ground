"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, Crosshair, Play, Trophy, Check, Share2, PlusSquare, X } from "lucide-react";
import {
  getOrCreateNotifyUserId,
  persistSubscription,
  registerServiceWorker,
  subscribeBrowserPush,
  unsubscribeBrowserPush,
  type PushTopics,
} from "@/lib/webPushClient";
import { usePwaInstallGate } from "@/lib/usePwaInstallGate";
import { ONBOARDING_DONE_KEY } from "@/lib/useMyTeam";

/**
 * NotificationBell — 우상단 알림 종.
 *
 *  - 좌상단 LogoImage(48px)와 시각적 균형: 44px 터치 타겟, 22px 얇은 stroke.
 *  - 클릭 시 글래스모피즘 패널이 펼쳐지며 3단계 구독 토글 노출.
 *      1) 선발 투수 확정/업데이트
 *      2) 경기 시작 직전
 *      3) 경기 종료 후 최종 스코어/하이라이트
 *  - 첫 토글 ON 시 Notification 권한 요청 (이미 granted/denied면 스킵).
 *  - 구독 상태는 localStorage에 영속, 패널 닫혀도 우상단 dot으로 표시.
 *  - 외부 클릭/ESC로 닫힘.
 *
 * 실제 푸시 송신은 별도 서버 인프라(Web Push / FCM 등)에서 처리. 본 컴포넌트는
 * "유저 의향 수집 + 브라우저 권한 게이트" 역할만 담당한다.
 */

const STORAGE_KEY = "ground-notif-prefs";
const EXPLICIT_OFF_KEY = "ground-notif-explicit-off";
type NotifPrefs = PushTopics;

type InboxItem = {
  id: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
};

type PushHealth = "checking" | "subscribed" | "unsubscribed" | "error";

const TOPIC_KEYS: Array<keyof NotifPrefs> = [
  "pitcher",
  "preGame",
  "postGame",
  "score",
  "livePitcherChange",
  "liveStrikeout",
];

const DEFAULT_PREFS: NotifPrefs = {
  pitcher: true,
  preGame: true,
  postGame: true,
  score: true,
  livePitcherChange: true,
  liveStrikeout: true,
} as const;
const OFF_PREFS: NotifPrefs = {
  pitcher: false,
  preGame: false,
  postGame: false,
  score: false,
  livePitcherChange: false,
  liveStrikeout: false,
} as const;

const ITEMS: Array<{
  key: keyof NotifPrefs;
  label: string;
  hint: string;
  Icon: typeof Bell;
}> = [
  {
    key: "pitcher",
    label: "선발 투수 업데이트",
    hint: "라인업이 확정되면 바로 알려드릴게요.",
    Icon: Crosshair,
  },
  {
    key: "preGame",
    label: "경기 시작 직전",
    hint: "플레이볼 15분 전 푸시.",
    Icon: Play,
  },
  {
    key: "postGame",
    label: "경기 종료 · 하이라이트",
    hint: "최종 스코어와 주요 장면 요약.",
    Icon: Trophy,
  },
  {
    key: "score",
    label: "경기중 · 스코어",
    hint: "득점/실점이 발생할 때마다 바로 푸시.",
    Icon: Bell,
  },
  {
    key: "livePitcherChange",
    label: "경기중 · 투수 교체",
    hint: "우리팀/상대팀 투수 교체 상황을 즉시 푸시.",
    Icon: Crosshair,
  },
  {
    key: "liveStrikeout",
    label: "경기중 · 탈삼진",
    hint: "투수 삼진 상황을 실시간으로 푸시.",
    Icon: Trophy,
  },
];

const ease = [0.22, 1, 0.36, 1] as const;

type Props = {
  /** 활성 dot / 토글 ON 색상 (응원 팀 accent) */
  accent: string;
  /** 종 아이콘 컬러 (밝은 배경 가독성 보정) */
  iconColor?: string;
};

function hasAnyTopicEnabled(prefs: NotifPrefs): boolean {
  return TOPIC_KEYS.some((key) => prefs[key]);
}

function setExplicitOptOut(flag: boolean) {
  try {
    localStorage.setItem(EXPLICIT_OFF_KEY, flag ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function isExplicitOptOut(): boolean {
  try {
    return localStorage.getItem(EXPLICIT_OFF_KEY) === "1";
  } catch {
    return false;
  }
}

export default function NotificationBell({
  accent,
  iconColor = "rgba(255,255,255,0.85)",
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const lastLoggedEndpointRef = useRef<string | null>(null);
  const silentRepairInFlightRef = useRef(false);
  const recoverPrefsRef = useRef<NotifPrefs>(DEFAULT_PREFS);
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<NotifPrefs>(DEFAULT_PREFS);
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pushHealth, setPushHealth] = useState<PushHealth>("checking");
  const [pushHealthMsg, setPushHealthMsg] = useState<string>("");
  const [permission, setPermission] =
    useState<NotificationPermission>("default");
  const [installGuide, setInstallGuide] = useState<"none" | "ios" | "android">("none");
  const { isStandalone, os, canPromptInstall, promptInstall } = usePwaInstallGate();

  // ── 초기 로드: prefs + 현재 권한 상태 ──
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<NotifPrefs>;
        const hydrated = { ...DEFAULT_PREFS, ...parsed };
        setPrefs(hydrated);
        if (localStorage.getItem(EXPLICIT_OFF_KEY) == null) {
          setExplicitOptOut(!hasAnyTopicEnabled(hydrated));
        }
      } else if (localStorage.getItem(ONBOARDING_DONE_KEY) === "1") {
        // 온보딩에서 푸시 동의를 마친 유저는 기본 토픽 ON 상태로 즉시 반영.
        const hydratedPrefs: NotifPrefs = {
          pitcher: true,
          preGame: true,
          postGame: true,
          score: true,
          livePitcherChange: true,
          liveStrikeout: true,
        };
        setPrefs(hydratedPrefs);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(hydratedPrefs));
        setExplicitOptOut(false);
      }
    } catch {
      /* ignore */
    }
    if (typeof window !== "undefined" && "Notification" in window) {
      setPermission(Notification.permission);
    }
    void fetch("/api/notifications/subscribe")
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.vapidPublicKey === "string") setVapidPublicKey(d.vapidPublicKey);
      })
      .catch(() => {
        /* ignore */
      });
  }, []);

  // ── prefs 영속 ──
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  }, [prefs]);

  useEffect(() => {
    if (hasAnyTopicEnabled(prefs)) {
      recoverPrefsRef.current = prefs;
    }
  }, [prefs]);

  // ── 외부 클릭 / ESC 로 닫기 ──
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const anyOn = hasAnyTopicEnabled(prefs);

  async function syncInbox() {
    const uid = getOrCreateNotifyUserId();
    const res = await fetch("/api/notifications?take=20", {
      headers: { "x-ground-user-id": uid },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { items?: InboxItem[] };
    setInbox(Array.isArray(data.items) ? data.items : []);
  }

  useEffect(() => {
    if (!open) return;
    void syncInbox();
  }, [open]);

  async function ensureBrowserPermission(): Promise<
    NotificationPermission | "unsupported"
  > {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return "unsupported";
    }
    if (Notification.permission === "granted") return "granted";
    if (Notification.permission === "denied") return "denied";
    const result = await Notification.requestPermission();
    setPermission(result);
    return result;
  }

  async function pushSubscribe(nextPrefs: NotifPrefs) {
    setErrorMsg(null);
    if (!isStandalone) {
      setErrorMsg("알림은 홈 화면에 설치된 앱에서만 설정할 수 있어요.");
      return;
    }
    const granted = await ensureBrowserPermission();
    if (granted === "unsupported") {
      setErrorMsg("이 브라우저에서는 웹 푸시를 지원하지 않아요.");
      return;
    }
    if (granted !== "granted") {
      setErrorMsg("브라우저 알림 권한이 필요해요.");
      return;
    }
    if (!vapidPublicKey) {
      setErrorMsg("VAPID public key가 설정되지 않았어요.");
      return;
    }
    const reg = await registerServiceWorker();
    if (!reg) {
      setErrorMsg("서비스 워커를 지원하지 않는 브라우저예요.");
      return;
    }
    const sub = await subscribeBrowserPush(reg, vapidPublicKey);
    const subJson = sub.toJSON();
    if (lastLoggedEndpointRef.current !== subJson.endpoint) {
      lastLoggedEndpointRef.current = subJson.endpoint ?? null;
      console.log("[pushSubscription]", subJson);
    }
    const uid = getOrCreateNotifyUserId();
    await persistSubscription(sub, nextPrefs, uid);
    setExplicitOptOut(false);
    setSubscribed(true);
    setPushHealth("subscribed");
    setPushHealthMsg("구독됨");
  }

  async function attemptSilentResubscribe(targetPrefs: NotifPrefs): Promise<boolean> {
    if (silentRepairInFlightRef.current) return false;
    if (!isStandalone || !vapidPublicKey) return false;
    if (typeof window === "undefined" || !("Notification" in window)) return false;
    if (Notification.permission !== "granted" || isExplicitOptOut()) return false;
    silentRepairInFlightRef.current = true;
    try {
      const reg = await registerServiceWorker();
      if (!reg) return false;
      const sub = await subscribeBrowserPush(reg, vapidPublicKey);
      const uid = getOrCreateNotifyUserId();
      await persistSubscription(sub, targetPrefs, uid);
      setPrefs(targetPrefs);
      setSubscribed(true);
      setPushHealth("subscribed");
      setPushHealthMsg("구독됨");
      setExplicitOptOut(false);
      return true;
    } catch {
      return false;
    } finally {
      silentRepairInFlightRef.current = false;
    }
  }

  async function refreshPushHealth(options?: { allowSilentResubscribe?: boolean }) {
    try {
      setPushHealth("checking");
      setPushHealthMsg("확인 중");
      if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
        setPrefs(OFF_PREFS);
        setSubscribed(false);
        setPushHealth("error");
        setPushHealthMsg("미지원 브라우저");
        return;
      }
      const desiredPrefs = prefs;
      const recoverPrefs = hasAnyTopicEnabled(desiredPrefs) ? desiredPrefs : recoverPrefsRef.current;
      const reg =
        (await navigator.serviceWorker.getRegistration("/sw.js")) ??
        (await navigator.serviceWorker.ready.catch(() => null));
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) {
        setPrefs(OFF_PREFS);
        setSubscribed(false);
        setPushHealth("unsubscribed");
        setPushHealthMsg("미구독");
        if (
          options?.allowSilentResubscribe !== false &&
          hasAnyTopicEnabled(recoverPrefs) &&
          !isExplicitOptOut()
        ) {
          const recovered = await attemptSilentResubscribe(recoverPrefs);
          if (recovered) return;
        }
        return;
      }
      const subJson = sub.toJSON();
      if (lastLoggedEndpointRef.current !== subJson.endpoint) {
        lastLoggedEndpointRef.current = subJson.endpoint ?? null;
        console.log("[pushSubscription]", subJson);
      }

      const uid = getOrCreateNotifyUserId();
      const res = await fetch("/api/notifications/subscribe/status", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ground-user-id": uid,
        },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      if (!res.ok) {
        setPushHealth("error");
        setPushHealthMsg(`상태 조회 실패 (${res.status})`);
        return;
      }
      const data = (await res.json()) as { status?: string };
      if (data.status === "subscribed") {
        setSubscribed(true);
        setPushHealth("subscribed");
        setPushHealthMsg("구독됨");
      } else {
        setSubscribed(false);
        setPushHealth("unsubscribed");
        setPushHealthMsg("미구독");
        if (
          options?.allowSilentResubscribe !== false &&
          hasAnyTopicEnabled(desiredPrefs) &&
          !isExplicitOptOut()
        ) {
          const uid = getOrCreateNotifyUserId();
          try {
            await persistSubscription(sub, desiredPrefs, uid);
            setSubscribed(true);
            setPushHealth("subscribed");
            setPushHealthMsg("구독됨");
            setExplicitOptOut(false);
          } catch {
            // ignore and keep unsubscribed state
          }
        }
      }
    } catch {
      setPushHealth("error");
      setPushHealthMsg("상태 조회 에러");
    }
  }

  async function toggle(key: keyof NotifPrefs) {
    if (!isStandalone) {
      setErrorMsg("홈 화면에 설치한 앱에서만 알림 구독이 가능해요.");
      return;
    }
    const turningOn = !prefs[key];
    const nextPrefs = { ...prefs, [key]: turningOn };
    setPrefs(nextPrefs);
    setLoading(true);
    try {
      if (turningOn) {
        setExplicitOptOut(false);
        await pushSubscribe(nextPrefs);
      } else if (!hasAnyTopicEnabled(nextPrefs) && subscribed) {
        setExplicitOptOut(true);
        const uid = getOrCreateNotifyUserId();
        await unsubscribeBrowserPush(uid);
        setSubscribed(false);
        setPushHealth("unsubscribed");
        setPushHealthMsg("미구독");
      } else if (!hasAnyTopicEnabled(nextPrefs)) {
        setExplicitOptOut(true);
      } else if (subscribed) {
        setExplicitOptOut(false);
        await pushSubscribe(nextPrefs);
      }
    } catch {
      setErrorMsg("알림 설정 저장에 실패했어요.");
      setPushHealth("error");
      setPushHealthMsg("구독 처리 에러");
    } finally {
      setLoading(false);
      void refreshPushHealth({ allowSilentResubscribe: true });
    }
  }

  useEffect(() => {
    if (!open) return;
    void refreshPushHealth({ allowSilentResubscribe: true });
    const id = window.setInterval(() => {
      void refreshPushHealth({ allowSilentResubscribe: true });
    }, 5000);
    return () => window.clearInterval(id);
  }, [open, vapidPublicKey, isStandalone]);

  useEffect(() => {
    if (!vapidPublicKey) return;
    void refreshPushHealth({ allowSilentResubscribe: true });
  }, [vapidPublicKey, isStandalone]);

  async function onBellClick() {
    setErrorMsg(null);
    if (isStandalone) {
      setOpen((o) => !o);
      return;
    }

    setOpen(false);
    if (os === "android") {
      const result = await promptInstall();
      if (result === "accepted" || result === "dismissed") return;
      setInstallGuide("android");
      return;
    }
    if (os === "ios") {
      setInstallGuide("ios");
      return;
    }
    setInstallGuide("android");
  }

  return (
    <div ref={wrapRef} className="absolute right-5 top-5 z-[120]">
      {/* ── 종 트리거 ── */}
      <motion.button
        type="button"
        whileTap={{ scale: 0.9 }}
        onClick={() => void onBellClick()}
        className="relative flex h-11 w-11 items-center justify-center rounded-full"
        aria-label="알림 설정"
        aria-expanded={open}
      >
        <Bell
          size={21}
          strokeWidth={1.5}
          className="text-current"
          style={{
            color: iconColor,
            filter: "drop-shadow(0 1px 4px rgba(0,0,0,0.55))",
          }}
        />
        {(anyOn || subscribed) && (
          <motion.span
            layoutId="notif-dot"
            className="absolute"
            style={{
              top: 8,
              right: 8,
              width: 7,
              height: 7,
              borderRadius: 9999,
              backgroundColor: accent,
              boxShadow: `0 0 8px ${accent}aa, 0 0 0 1.5px rgba(0,0,0,0.55)`,
            }}
          />
        )}
      </motion.button>

      {/* ── 패널 ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ duration: 0.22, ease }}
            className="absolute right-0 top-12 z-[130] w-[284px] overflow-hidden rounded-2xl"
            style={{
              backgroundColor: "rgba(15,15,18,0.78)",
              backdropFilter: "blur(24px) saturate(160%)",
              WebkitBackdropFilter: "blur(24px) saturate(160%)",
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow: "0 12px 36px rgba(0,0,0,0.55)",
            }}
            role="dialog"
            aria-label="알림 구독 설정"
          >
            {/* 헤더 */}
            <div className="flex items-start justify-between px-4 pb-1.5 pt-3.5">
              <div>
                <p
                  className="text-[9.5px] uppercase tracking-[0.32em] text-white/40"
                  style={{ fontWeight: 600 }}
                >
                  Notifications
                </p>
                <p className="mt-1 text-[12px] leading-snug text-white/60">
                  {permission === "denied"
                    ? "브라우저 알림이 차단돼 있어요. 설정에서 허용해주세요."
                    : "받아볼 알림을 골라주세요. (웹 푸시 + 인앱)"}
                </p>
                <div className="mt-2 flex items-center gap-2 text-[10px] text-white/70">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      pushHealth === "subscribed"
                        ? "bg-emerald-400"
                        : pushHealth === "checking"
                          ? "bg-amber-300"
                          : pushHealth === "error"
                            ? "bg-rose-400"
                            : "bg-white/40"
                    }`}
                  />
                  <span className="tracking-wide">
                    웹 푸시 상태: {pushHealthMsg || "확인 중"}
                  </span>
                </div>
                {permission !== "granted" && (
                  <div className="mt-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-2 text-[10.5px] leading-relaxed text-white/58">
                    <p>1) 홈 화면 앱에서 벨 버튼 열기</p>
                    <p>2) 권한 팝업에서 허용 선택</p>
                    <p>3) 원하는 알림 토글 ON</p>
                  </div>
                )}
                {errorMsg ? (
                  <p className="mt-1 text-[11px] text-[#ff8f8f]">{errorMsg}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="-mr-1 -mt-1 flex h-7 w-7 items-center justify-center rounded-full text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/80"
                aria-label="닫기"
              >
                <X size={14} strokeWidth={1.8} />
              </button>
            </div>

            {/* 항목 */}
            <div className="px-2 pb-2 pt-1">
              {ITEMS.map(({ key, label, hint, Icon }) => {
                const on = prefs[key];
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggle(key)}
                    disabled={loading}
                    className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
                    aria-pressed={on}
                  >
                    <span
                      className="mt-[2px] flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors"
                      style={{
                        backgroundColor: on
                          ? `${accent}24`
                          : "rgba(255,255,255,0.05)",
                        color: on ? accent : "rgba(255,255,255,0.55)",
                      }}
                    >
                      <Icon size={14} strokeWidth={1.8} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className="block text-[13px] leading-tight text-white/92"
                        style={{ fontWeight: 600 }}
                      >
                        {label}
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-white/45">
                        {hint}
                      </span>
                    </span>
                    {/* iOS-style toggle */}
                    <span
                      className="mt-1 inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-full px-[2px] transition-colors"
                      style={{
                        backgroundColor: on
                          ? accent
                          : "rgba(255,255,255,0.16)",
                      }}
                    >
                      <motion.span
                        animate={{ x: on ? 14 : 0 }}
                        transition={{
                          type: "spring",
                          stiffness: 480,
                          damping: 32,
                        }}
                        className="block h-[16px] w-[16px] rounded-full bg-white"
                        style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.35)" }}
                      />
                    </span>
                  </button>
                );
              })}
            </div>

            {/* 인앱 알림 인박스 */}
            <div
              className="max-h-[160px] overflow-y-auto border-t border-white/[0.06] px-3 pb-2 pt-2"
              aria-label="최근 알림"
            >
              {inbox.length === 0 ? (
                <p className="px-1 py-1 text-[11px] text-white/35">아직 알림이 없어요.</p>
              ) : (
                inbox.map((n) => (
                  <div
                    key={n.id}
                    className={`rounded-lg px-2 py-1.5 ${n.isRead ? "bg-white/[0.03]" : "bg-white/[0.07]"}`}
                  >
                    <p className="text-[11.5px] font-semibold text-white/90">{n.title}</p>
                    <p className="mt-0.5 text-[10.5px] leading-snug text-white/55">{n.body}</p>
                  </div>
                ))
              )}
            </div>

            {/* 풋터 상태 */}
            <div
              className="border-t px-4 py-2.5 text-[10px] uppercase tracking-[0.22em]"
              style={{
                fontWeight: 500,
                borderColor: "rgba(255,255,255,0.06)",
                color: anyOn ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.3)",
              }}
            >
              {anyOn || subscribed ? (
                <span className="flex items-center gap-1.5">
                  <Check size={11} strokeWidth={2.2} style={{ color: accent }} />
                  구독 중 {loading ? "· 저장중" : ""}
                </span>
              ) : (
                "Off"
              )}
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
            className="fixed inset-0 z-[180] bg-black/60 backdrop-blur-sm"
          >
            <button
              type="button"
              className="absolute inset-0"
              aria-label="설치 안내 닫기"
              onClick={() => setInstallGuide("none")}
            />
            <motion.div
              initial={{ y: 28, opacity: 0.96 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 28, opacity: 0.96 }}
              transition={{ duration: 0.22, ease }}
              className="absolute inset-x-4 bottom-6 mx-auto max-w-md rounded-2xl border border-white/10 bg-[#111218]/90 p-5 text-white shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="PWA 설치 안내"
            >
              <p className="text-[16px] font-semibold leading-snug">
                가장 빠른 라인업 알림을 받으려면 앱을 설치해 주세요! ⚾️
              </p>

              {installGuide === "ios" ? (
                <div className="mt-4 space-y-2.5 text-[13px] leading-relaxed text-white/85">
                  <p className="flex items-center gap-2">
                    <Share2 size={15} />
                    사파리 하단의 <span className="font-semibold">[공유하기]</span>를 눌러주세요.
                  </p>
                  <p className="flex items-center gap-2">
                    <PlusSquare size={15} />
                    <span className="font-semibold">[홈 화면에 추가]</span>를 선택하면 설치가 완료됩니다.
                  </p>
                </div>
              ) : (
                <div className="mt-4 space-y-2.5 text-[13px] leading-relaxed text-white/85">
                  <p>
                    {canPromptInstall
                      ? "설치 팝업이 보이지 않으면 우측 상단 메뉴에서 다시 설치를 진행해 주세요."
                      : "우측 상단 메뉴(⋮)를 열고 [홈 화면에 추가]를 선택해 주세요."}
                  </p>
                  <p className="flex items-center gap-2">
                    <PlusSquare size={15} />
                    설치 후 홈 화면 앱으로 열면 알림 구독이 가능합니다.
                  </p>
                </div>
              )}

              <button
                type="button"
                onClick={() => setInstallGuide("none")}
                className="mt-5 w-full rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-[13px] font-medium text-white/88 transition hover:bg-white/10"
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
