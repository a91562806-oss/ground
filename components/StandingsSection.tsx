"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { findTeam } from "@/lib/teams";
import {
  STANDINGS,
  formatWinRate,
  formatGamesBehind,
  type StandingRow,
} from "@/config/standings";
const ease = [0.22, 1, 0.36, 1] as const;

/**
 * 그리드 컬럼: 순위(20) · 팀명(1fr) · 승(28) · 패(28) · 무(24) · 승률(46) · 게임차(40)
 *  - 로고 없이 팀 약칭(한글/영문)만 표기.
 */
const STANDINGS_GRID = "20px 1fr 28px 28px 24px 46px 40px";

type Props = {
  /** 응원팀 id — 행 하이라이트 (acccent tint + bold) */
  myTeamId: string;
  /** 외부에서 데이터 주입할 때 사용 (없으면 STANDINGS mock 사용) */
  rows?: StandingRow[];
  /** 데이터 로딩 중 표시 강제 — true 면 스켈레톤 */
  loading?: boolean;
};

/**
 * StandingsSection — 메인 페이지 HeroCard 아래에 깔리는 KBO 순위표.
 *
 *  ── 디자인 ──
 *   - 애플 표 스타일: 선 최소화, 12~13px 본문, 헤더는 9~10px tracking-wide
 *   - 응원팀 행만 살짝 accent 틴트 + bold + 좌측 컬러 바
 *   - 화이트 8% 인터리브? → 노이즈 → 사용 안 함. 행간만 충분히.
 *
 *  ── 데이터 ──
 *   - 기본 소스: config/standings.ts (mock, 정적). 추후 API fetch 시 props.rows 주입.
 *   - 비어있으면 자동으로 스켈레톤 노출 (10행).
 */
export default function StandingsSection({ myTeamId, rows, loading }: Props) {
  const data = rows ?? STANDINGS;
  const showSkeleton = loading || data.length === 0;

  return (
    <section aria-label="KBO 순위표" className="px-5 pt-7 pb-12">
      {/* ── 글래스 카드 컨테이너 ── */}
      <div className="rounded-3xl border border-white/10 bg-black/40 p-5 shadow-[0_18px_44px_rgba(0,0,0,0.4)] backdrop-blur-xl backdrop-saturate-150">
        {/* ── 헤더 ── */}
        <div className="mb-5 flex items-baseline justify-between">
          <h2
            className="text-[11px] uppercase tracking-[0.36em] text-white drop-shadow-md"
            style={{
              fontWeight: 800,
              textShadow: "0 1px 4px rgba(0,0,0,0.4)",
            }}
          >
            Standings
          </h2>
          <span
            className="text-[9.5px] uppercase tracking-[0.32em] text-white/55"
            style={{ fontWeight: 600 }}
          >
            2026 Regular Season
          </span>
        </div>

        {/* ── 컬럼 가이드 (한글 약식) ── */}
        <div
          className="mb-2 grid items-baseline gap-3 px-3 text-[10px] tracking-[0.05em] text-white/55"
          style={{
            fontWeight: 700,
            gridTemplateColumns: STANDINGS_GRID,
          }}
        >
          <span className="text-center">순위</span>
          <span>팀</span>
          <span className="text-right">승</span>
          <span className="text-right">패</span>
          <span className="text-right">무</span>
          <span className="text-right">승률</span>
          <span className="text-right">게임차</span>
        </div>

        {/* ── 본문 ── */}
        {showSkeleton ? (
          <SkeletonList />
        ) : (
          <ul role="list" className="flex flex-col">
            {data.map((row, i) => (
              <Row
                key={row.teamId}
                row={row}
                isMe={row.teamId === myTeamId}
                index={i}
              />
            ))}
          </ul>
        )}

        {/* ── 풋터 ── */}
        <p
          className="mt-6 text-center text-[9.5px] uppercase tracking-[0.32em] text-white/40"
          style={{ fontWeight: 700 }}
        >
          Source · Naver Sports
        </p>
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────

function Row({
  row,
  isMe,
  index,
}: {
  row: StandingRow;
  isMe: boolean;
  index: number;
}) {
  const t = findTeam(row.teamId);

  // 진입 애니메이션은 가벼운 페이드만 — 1회성, 스크롤 인뷰 없음 (스케줄 탭 케이스 학습)
  const enter = useMemo(
    () => ({
      initial: { opacity: 0, y: 6 },
      animate: { opacity: 1, y: 0 },
      transition: { duration: 0.32, ease, delay: Math.min(index * 0.025, 0.2) },
    }),
    [index]
  );

  const NUM_FONT =
    '"Pretendard Variable", "Helvetica Neue", Inter, sans-serif';
  const numColor = isMe ? "rgba(255,255,255,1)" : "rgba(255,255,255,0.78)";
  const subNumColor = isMe ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.42)";

  return (
    <li>
      <motion.div
        {...enter}
        className="relative grid items-center gap-3 rounded-2xl px-3 py-3"
        style={{
          gridTemplateColumns: STANDINGS_GRID,
          backgroundColor: isMe ? `${t.accent}26` : "transparent",
          border: isMe ? `1px solid ${t.accent}55` : "1px solid transparent",
        }}
      >
        {/* 응원팀: 좌측 얇은 컬러 바 + 안쪽 글로우 */}
        {isMe && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-1 left-1 w-[2px] rounded-full"
            style={{
              backgroundColor: t.accent,
              boxShadow: `0 0 12px ${t.accent}cc`,
            }}
          />
        )}

        {/* 순위 */}
        <span
          className="text-center tabular-nums"
          style={{
            fontFamily: NUM_FONT,
            fontWeight: isMe ? 900 : 700,
            fontSize: 14,
            color: isMe ? "#ffffff" : "rgba(255,255,255,0.75)",
            textShadow: isMe
              ? `0 0 10px ${t.accent}aa, 0 1px 4px rgba(0,0,0,0.5)`
              : "0 1px 3px rgba(0,0,0,0.35)",
            letterSpacing: "-0.01em",
          }}
        >
          {row.rank}
        </span>

        {/* 팀명 (로고 대신 텍스트만) */}
        <span
          className="min-w-0 truncate"
          style={{
            fontFamily: NUM_FONT,
            fontWeight: isMe ? 900 : 700,
            fontSize: 14,
            letterSpacing: "-0.02em",
            color: isMe ? "#ffffff" : "rgba(255,255,255,0.95)",
            textShadow: isMe
              ? `0 1px 6px rgba(0,0,0,0.5)`
              : "0 1px 3px rgba(0,0,0,0.35)",
          }}
        >
          {t.short}
        </span>

        {/* 승 */}
        <NumCell value={row.wins} color={numColor} bold={isMe} />
        {/* 패 */}
        <NumCell value={row.losses} color={numColor} bold={isMe} />
        {/* 무 — 0 이면 한 단계 더 흐리게 */}
        <NumCell
          value={row.draws}
          color={row.draws === 0 ? subNumColor : numColor}
          bold={isMe}
        />

        {/* 승률 */}
        <span
          className="text-right tabular-nums"
          style={{
            fontFamily: NUM_FONT,
            fontSize: 12.5,
            fontWeight: isMe ? 700 : 600,
            color: isMe ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.78)",
            letterSpacing: "0.005em",
          }}
        >
          {formatWinRate(row.winRate)}
        </span>

        {/* 게임차 */}
        <span
          className="text-right tabular-nums"
          style={{
            fontFamily: NUM_FONT,
            fontSize: 12,
            fontWeight: 500,
            color: isMe ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.42)",
          }}
        >
          {formatGamesBehind(row.gamesBehind)}
        </span>
      </motion.div>
    </li>
  );
}

function NumCell({
  value,
  color,
  bold,
}: {
  value: number;
  color: string;
  bold?: boolean;
}) {
  return (
    <span
      className="text-right tabular-nums"
      style={{
        fontFamily: '"Pretendard Variable", "Helvetica Neue", Inter, sans-serif',
        fontSize: 12.5,
        fontWeight: bold ? 700 : 500,
        color,
        letterSpacing: "-0.005em",
      }}
    >
      {value}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────

function SkeletonList() {
  return (
    <ul role="list" className="flex flex-col" aria-label="순위표 로딩 중">
      {Array.from({ length: 10 }).map((_, i) => (
        <li key={i}>
          <div
            className="relative grid items-center gap-3 rounded-2xl px-3 py-3"
            style={{ gridTemplateColumns: STANDINGS_GRID }}
          >
            <ShimmerBar w={10} h={10} className="mx-auto rounded-sm" />
            <ShimmerBar w={`${48 + ((i * 7) % 28)}%`} h={12} className="rounded" />
            <ShimmerBar w={18} h={10} className="ml-auto rounded" />
            <ShimmerBar w={18} h={10} className="ml-auto rounded" />
            <ShimmerBar w={14} h={10} className="ml-auto rounded" />
            <ShimmerBar w={32} h={10} className="ml-auto rounded" />
            <ShimmerBar w={24} h={10} className="ml-auto rounded" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function ShimmerBar({
  w,
  h,
  className = "",
}: {
  w: number | string;
  h: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`block ${className}`}
      style={{
        width: typeof w === "number" ? `${w}px` : w,
        height: h,
        background:
          "linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.10) 50%, rgba(255,255,255,0.04) 100%)",
        backgroundSize: "200% 100%",
        animation: "ground-shimmer 1.6s linear infinite",
      }}
    />
  );
}
