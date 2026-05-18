"use client";

import { useEffect, useState } from "react";
import type { LiveGame } from "@/lib/kbo";
import type { TodayFeedStatus } from "@/lib/kbo";
import type { StandingRow } from "@/config/standings";

export type KboTodayPayload = {
  date: string;
  status: TodayFeedStatus;
  message: string | null;
  games: LiveGame[];
  standings: StandingRow[];
};

/**
 * /api/kbo/today 를 60초 마다 폴링.
 * 서버에서 실패하면 폴백 데이터가 들어오므로 null 은 첫 로드 직전만 잠깐.
 */
export function useKboToday(): KboTodayPayload | null {
  const [data, setData] = useState<KboTodayPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/kbo/today", { cache: "no-store" });
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
  }, []);

  return data;
}
