"use client";

import { useEffect, useState } from "react";

/**
 * 디렉터 모드 (10구단 검수용 퀵 네비) 노출 여부.
 *
 * 노출 규칙:
 *  - dev (NODE_ENV !== "production"): 기본 ON
 *  - alpha (NEXT_PUBLIC_APP_ENV=alpha): 기본 ON
 *  - prod: OFF가 기본. 다음 중 하나로 ON 가능:
 *      · URL 쿼리 ?director=1   (이후 localStorage에 영속)
 *      · localStorage["ground-director"] === "1"
 *  - 임의로 끄려면 ?director=0
 */
const KEY = "ground-director";

export function useDirectorMode(): boolean {
  // SSR/하이드레이션 깜빡임 방지를 위해 첫 페인트는 false → 클라에서 결정
  const [enabled, setEnabled] = useState<boolean>(false);

  useEffect(() => {
    const isDev = process.env.NODE_ENV !== "production";
    const isAlpha = (process.env.NEXT_PUBLIC_APP_ENV ?? "").toLowerCase() === "alpha";
    let on = isDev || isAlpha;

    try {
      const v = window.localStorage.getItem(KEY);
      if (v === "1") on = true;
      if (v === "0") on = false;

      const params = new URLSearchParams(window.location.search);
      const q = params.get("director");
      if (q === "1") {
        on = true;
        window.localStorage.setItem(KEY, "1");
      } else if (q === "0") {
        on = false;
        window.localStorage.setItem(KEY, "0");
      }
    } catch {
      /* ignore */
    }

    setEnabled(on);
  }, []);

  return enabled;
}
