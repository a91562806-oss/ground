"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, CalendarDays, BarChart3 } from "lucide-react";
import { motion } from "framer-motion";
import { useMyTeam } from "@/lib/useMyTeam";
import { getKboTeamThemeByTeamId } from "@/config/teams";

/**
 * 하단 탭 — TODAY · SCHEDULE · RANK 3종.
 *  ※ 응원팀 변경(/my) 은 HeroCard 좌상단 MY CTA 로 진입한다.
 *    BottomNav 의 MY 자리는 RANK(순위표) 가 가져갔다.
 */
const TABS = [
  { href: "/today", label: "TODAY", Icon: Home },
  { href: "/schedule", label: "SCHEDULE", Icon: CalendarDays },
  { href: "/rank", label: "RANK", Icon: BarChart3 },
];

export default function BottomNav() {
  const pathname = usePathname();
  const team = useMyTeam();
  const visualTheme = getKboTeamThemeByTeamId(team.id);
  const accent = visualTheme?.secondary ?? team.accent;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50">
      {/* 위쪽으로 자연스럽게 사라지는 그라데이션 (라인 대신) */}
      <div
        className="pointer-events-none absolute inset-x-0 -top-6 h-6"
        style={{
          background:
            "linear-gradient(to top, color-mix(in srgb, var(--app-bg, #000000) 88%, transparent), transparent)",
        }}
      />
      <div
        className="backdrop-blur-xl backdrop-saturate-150"
        style={{
          backgroundColor: "rgba(0, 0, 0, 0.4)",
          color: "var(--app-text, #ffffff)",
          borderTop: "1px solid rgba(255, 255, 255, 0.1)",
        }}
      >
        <ul className="mx-auto flex max-w-md items-stretch justify-around px-6 pb-6 pt-3 safe-pb">
          {TABS.map(({ href, label, Icon }) => {
            const active = pathname?.startsWith(href);
            return (
              <li key={href} className="flex-1">
                <Link
                  href={href}
                  className="relative flex flex-col items-center justify-center py-2"
                >
                  <motion.div
                    animate={{
                      scale: active ? 1 : 0.95,
                      opacity: active ? 1 : 0.5,
                    }}
                    transition={{ type: "spring", stiffness: 360, damping: 26 }}
                    className="flex flex-col items-center gap-1.5"
                  >
                    <Icon
                      size={22}
                      strokeWidth={active ? 2.4 : 1.8}
                      className="text-white"
                      style={
                        active
                          ? {
                              color: "#ffffff",
                              filter: `drop-shadow(0 0 10px ${accent}88) drop-shadow(0 1px 4px rgba(0,0,0,0.5))`,
                            }
                          : {
                              color: "#ffffff",
                              filter: "drop-shadow(0 1px 4px rgba(0,0,0,0.45))",
                            }
                      }
                    />
                    <span
                      className="text-[9.5px] tracking-[0.22em] text-white drop-shadow-md"
                      style={{
                        color: "#ffffff",
                        opacity: active ? 1 : 0.7,
                        fontWeight: active ? 800 : 600,
                        textShadow: "0 1px 4px rgba(0,0,0,0.5)",
                      }}
                    >
                      {label}
                    </span>
                  </motion.div>
                  {active && (
                    <motion.span
                      layoutId="tab-pill"
                      transition={{
                        type: "spring",
                        stiffness: 380,
                        damping: 30,
                      }}
                      className="absolute -top-1 h-[3px] w-7 rounded-full"
                      style={{
                        backgroundColor: accent,
                        boxShadow: `0 0 10px ${accent}99, 0 0 18px ${accent}55`,
                      }}
                    />
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
