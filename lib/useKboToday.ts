"use client";

import { useEffect, useState } from "react";
import type { LiveGame } from "@/lib/kbo";
import type { TodayFeedStatus } from "@/lib/kbo";
import type { StandingRow } from "@/config/standings";

export type KboTodayPayload = {
  date: string;
  status: TodayFeedStatus;
  gamePhase?: "NONE" | "PRE" | "LIVE" | "END";
  message: string | null;
  fallback?: boolean;
  games: LiveGame[];
  standings: StandingRow[];
  pregamePreview?: {
    status: "PENDING" | "READY" | "FAILED";
    title: string | null;
    lines: string[];
    active: boolean;
    generatedAt: string | null;
  } | null;
  postGameReport?: {
    status: "PENDING" | "GENERATING" | "READY" | "FAILED";
    headline: string | null;
    content: string | null;
    active: boolean;
    visibleUntil: string | null;
    generatedAt: string | null;
  } | null;
};

type UseKboTodayOptions = {
  withStandings?: boolean;
};

/**
 * /api/kbo/today 를 60초 마다 폴링.
 * 서버에서 실패하면 폴백 데이터가 들어오므로 null 은 첫 로드 직전만 잠깐.
 */
export function useKboToday(
  teamId?: string,
  options?: UseKboTodayOptions
): KboTodayPayload | null {
  const [data, setData] = useState<KboTodayPayload | null>(null);
  const withStandings = options?.withStandings ?? true;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const params = new URLSearchParams();
        if (teamId) params.set("teamId", teamId);
        if (!withStandings) params.set("withStandings", "0");
        const qs = params.toString();
        const r = await fetch(`/api/kbo/today${qs ? `?${qs}` : ""}`, {
          cache: "no-store",
        });
        if (!r.ok) return;
        const j = (await r.json()) as KboTodayPayload;
        if (!cancelled) setData(j);
      } catch {
        // 네트워크 일시 장애는 조용히 다음 주기로 넘김
      }
    };
    void load();
    const t = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [teamId, withStandings]);

  return data;
}
