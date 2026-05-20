"use client";

import { useRouter, usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";

/**
 * Apple Sports 스타일 탭 전환 셸.
 *
 *  - 좌우 스와이프로 오직 탭 순서대로만 이동 (브라우저 히스토리 back/forward 아님).
 *  - router.replace() → 히스토리 누적 없음 → iOS 엣지 스와이프 back 제스처 간섭 X.
 *  - 수동 touch 핸들러로 수평 이동 감지 시 즉시 preventDefault() — OS 레벨 제스처 차단.
 *  - 세로 스크롤은 절대 막지 않음 (axis 판별 후 수직이면 즉시 위임).
 *
 *  탭 순서: TODAY(0) → SCHEDULE(1) → RANK(2)
 *  오른쪽 스와이프(→) = 다음 탭, 왼쪽 스와이프(←) = 이전 탭.
 */
const ROUTES = ["/today", "/schedule", "/rank"] as const;
type Route = (typeof ROUTES)[number];

const SWIPE_PX = 72;      // 이 거리 이상 이동하면 탭 전환
const SWIPE_VX = 400;     // 또는 이 이상의 속도면 전환
const AXIS_LOCK_PX = 6;   // 이 거리 이후 축 확정

const FADE = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1] as const,
};

const variants = {
  enter: { opacity: 0 },
  center: { opacity: 1 },
  exit: {
    opacity: 0,
    transition: { duration: 0.15, ease: [0.32, 0, 0.67, 0] },
  },
};

function resolveIndex(path: string | null | undefined): number {
  if (!path) return -1;
  return ROUTES.findIndex((r) => path.startsWith(r));
}

export default function PageShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const prevPathRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const currentIndex = resolveIndex(pathname);
  const inTabRoute = currentIndex !== -1;

  useEffect(() => {
    prevPathRef.current = pathname;
  }, [pathname]);

  // 수동 touch 핸들러 — iOS 엣지 제스처보다 먼저 수평 축 잡기
  useEffect(() => {
    if (!inTabRoute) return;
    const el = containerRef.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let axis: "x" | "y" | null = null;

    function onTouchStart(e: TouchEvent) {
      const t = e.touches[0];
      if (!t) return;
      startX = t.clientX;
      startY = t.clientY;
      startTime = Date.now();
      axis = null;
    }

    function onTouchMove(e: TouchEvent) {
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      // 축 미확정 — 이동 거리가 임계치 이상이 되면 한 번만 결정
      if (axis == null && Math.hypot(dx, dy) > AXIS_LOCK_PX) {
        axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      }

      if (axis === "x") {
        // 가로 스와이프 중 — iOS 기본 제스처(back/forward) 차단
        e.preventDefault();
      }
      // axis === "y" 이면 세로 스크롤 그대로 위임 (preventDefault 미호출)
    }

    function onTouchEnd(e: TouchEvent) {
      if (axis !== "x") return;

      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dt = Math.max(1, Date.now() - startTime);
      const vx = dx / dt * 1000; // px/s

      const goRight = dx > SWIPE_PX || vx > SWIPE_VX;   // →  다음 탭
      const goLeft  = dx < -SWIPE_PX || vx < -SWIPE_VX; // ←  이전 탭

      if (goRight) {
        const nextIdx = Math.min(currentIndex + 1, ROUTES.length - 1);
        if (nextIdx !== currentIndex) {
          router.replace(ROUTES[nextIdx] as Route);
          bumpHaptic();
        }
      } else if (goLeft) {
        const prevIdx = Math.max(currentIndex - 1, 0);
        if (prevIdx !== currentIndex) {
          router.replace(ROUTES[prevIdx] as Route);
          bumpHaptic();
        }
      }
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove",  onTouchMove,  { passive: false }); // preventDefault 필요
    el.addEventListener("touchend",   onTouchEnd,   { passive: true });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove",  onTouchMove);
      el.removeEventListener("touchend",   onTouchEnd);
    };
  }, [inTabRoute, currentIndex, router]);

  // 탭 라우트 밖(/my 등)은 전환 없이 렌더
  if (!inTabRoute) {
    return <>{children}</>;
  }

  return (
    <div
      ref={containerRef}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <AnimatePresence mode="sync" initial={false}>
        <motion.div
          key={pathname}
          className="absolute inset-0 flex min-h-0 flex-col"
          variants={variants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={FADE}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function bumpHaptic() {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate(10);
  }
}
