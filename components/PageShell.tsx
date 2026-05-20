"use client";

import { useRouter, usePathname } from "next/navigation";
import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import { useEffect, useRef, useState } from "react";

/**
 * Apple Sports 스타일 페이지 전환 셸.
 *
 *  - 라우트 전환을 좌→우/우→좌 슬라이드 + 페이드로 매끄럽게 이어 붙여 네이티브 앱
 *    느낌을 낸다.
 *  - 좌우 드래그(스와이프)로 이전/다음 탭으로 이동. 세로 스크롤은 막지 않도록
 *    `touchAction: "pan-y"` + `dragDirectionLock` 으로 한 축만 잠근다.
 *  - BottomNav 탭 순서와 동일한 ROUTES 배열로 인덱스를 계산해 진행 방향을 정함.
 */
const ROUTES = ["/today", "/schedule", "/rank"] as const;

const SWIPE_DISTANCE_THRESHOLD = 80;
const SWIPE_VELOCITY_THRESHOLD = 480;

const SPRING_TRANSITION = {
  type: "spring" as const,
  stiffness: 300,
  damping: 30,
  mass: 0.85,
};

function resolveRouteIndex(path: string | null | undefined): number {
  if (!path) return -1;
  return ROUTES.findIndex((r) => path.startsWith(r));
}

const variants = {
  enter: (dir: number) => ({
    x: dir > 0 ? "100%" : dir < 0 ? "-100%" : 0,
    opacity: dir === 0 ? 1 : 0.4,
  }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({
    x: dir > 0 ? "-12%" : dir < 0 ? "12%" : 0,
    opacity: 0,
  }),
};

export default function PageShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [direction, setDirection] = useState(0);
  const previousPathRef = useRef<string | null>(null);

  const currentIndex = resolveRouteIndex(pathname);
  const inTabRoute = currentIndex !== -1;

  useEffect(() => {
    if (!pathname) return;
    const prev = previousPathRef.current;
    if (prev != null) {
      const prevIdx = resolveRouteIndex(prev);
      const nextIdx = resolveRouteIndex(pathname);
      if (prevIdx !== -1 && nextIdx !== -1 && prevIdx !== nextIdx) {
        setDirection(nextIdx > prevIdx ? 1 : -1);
      }
    }
    previousPathRef.current = pathname;
  }, [pathname]);

  function handleDragEnd(_: PointerEvent | MouseEvent | TouchEvent, info: PanInfo) {
    if (!inTabRoute) return;
    const offsetX = info.offset.x;
    const velocityX = info.velocity.x;

    const goNext =
      offsetX < -SWIPE_DISTANCE_THRESHOLD || velocityX < -SWIPE_VELOCITY_THRESHOLD;
    const goPrev =
      offsetX > SWIPE_DISTANCE_THRESHOLD || velocityX > SWIPE_VELOCITY_THRESHOLD;

    if (goNext) {
      const nextIdx = Math.min(currentIndex + 1, ROUTES.length - 1);
      if (nextIdx !== currentIndex) {
        setDirection(1);
        router.push(ROUTES[nextIdx]);
        bumpHaptic();
      }
    } else if (goPrev) {
      const prevIdx = Math.max(currentIndex - 1, 0);
      if (prevIdx !== currentIndex) {
        setDirection(-1);
        router.push(ROUTES[prevIdx]);
        bumpHaptic();
      }
    }
  }

  // 탭 라우트가 아닐 때(/my 등)는 전환 효과/스와이프 없이 그대로 노출.
  if (!inTabRoute) {
    return <>{children}</>;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <AnimatePresence mode="wait" custom={direction} initial={false}>
        <motion.div
          key={pathname}
          className="absolute inset-0 flex min-h-0 flex-col"
          style={{ touchAction: "pan-y" }}
          custom={direction}
          variants={variants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={SPRING_TRANSITION}
          drag="x"
          dragDirectionLock
          dragElastic={0.22}
          dragConstraints={{ left: 0, right: 0 }}
          dragMomentum={false}
          onDragEnd={handleDragEnd}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function bumpHaptic() {
  if (typeof navigator === "undefined") return;
  if (typeof navigator.vibrate === "function") navigator.vibrate(10);
}
