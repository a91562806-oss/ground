"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { LineupItem } from "@/lib/kbo";

const ease = [0.22, 1, 0.36, 1] as const;

type LineupSheetProps = {
  open: boolean;
  onClose: () => void;
  teamShort: string;
  lineup: LineupItem[];
  accentColor: string;
  isLightThemeText: boolean;
  themedText: (alpha: number) => string;
};

/**
 * 화면 하단에서 올라오는 선발 라인업 시트.
 * 응원 팀의 라인업이 비어있으면 `open=false` 로 두어 마운트되지 않도록 한다.
 */
export default function LineupSheet({
  open,
  onClose,
  teamShort,
  lineup,
  accentColor,
  isLightThemeText,
  themedText,
}: LineupSheetProps) {
  return (
    <AnimatePresence>
      {open && lineup.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease }}
          className="absolute inset-0 z-[90]"
        >
          <button
            type="button"
            aria-label="라인업 모달 닫기"
            onClick={onClose}
            className="absolute inset-0 bg-black/45"
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ duration: 0.28, ease }}
            className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-md rounded-t-3xl border border-white/15 p-4 pb-6 shadow-[0_-14px_44px_rgba(0,0,0,0.45)] backdrop-blur-lg"
            style={{
              height: "68%",
              backgroundColor: isLightThemeText ? "rgba(255,255,255,0.8)" : "rgba(0,0,0,0.8)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-gray-400/70" />
            <div className="flex items-center justify-between">
              <p
                className="text-[14px] font-semibold tracking-wide"
                style={{ color: themedText(0.95) }}
              >
                {teamShort} 선발 라인업
              </p>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-white/15 px-2.5 py-1 text-[11px]"
                style={{ color: themedText(0.75) }}
              >
                닫기
              </button>
            </div>
            <div className="mt-3 h-[calc(100%-3.5rem)] overflow-y-auto overscroll-contain pr-1 [-webkit-overflow-scrolling:touch]">
              <ul className="space-y-2.5">
                {lineup.map((player) => (
                  <li
                    key={`${player.order}-${player.name}`}
                    className="flex items-center justify-between rounded-xl border border-white/10 px-3 py-2.5"
                    style={{
                      backgroundColor: isLightThemeText
                        ? "rgba(255,255,255,0.62)"
                        : "rgba(255,255,255,0.06)",
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold"
                        style={{
                          backgroundColor: `${accentColor}26`,
                          color: accentColor,
                          border: `1px solid ${accentColor}66`,
                        }}
                      >
                        {player.order}
                      </span>
                      <span
                        className="text-[13px] font-semibold tracking-wide"
                        style={{ color: themedText(0.92) }}
                      >
                        {player.name}
                      </span>
                    </div>
                    <span className="text-[11px] tracking-wide" style={{ color: themedText(0.62) }}>
                      {player.position}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
