"use client";

import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";

const ease = [0.22, 1, 0.36, 1] as const;

type PregamePreviewView = {
  status: "PENDING" | "READY" | "FAILED";
  title: string | null;
  lines: string[];
};

type PostGameReportView = {
  status: "PENDING" | "GENERATING" | "READY" | "FAILED";
  headline: string | null;
  content: string | null;
};

type InsightOverlayProps =
  | {
      kind: "pregame";
      pregamePreview: PregamePreviewView | null;
      onDismiss: () => void;
    }
  | {
      kind: "postgame";
      postGameReport: PostGameReportView | null;
      postGameVisibleUntilLabel: string | null;
      onDismiss: () => void;
    }
  | { kind: null };

/**
 * 경기 프리뷰 / 경기 종료 한줄평을 Today 탭 중앙에 띄우는 모달 오버레이.
 * 같은 시점에 두 인사이트가 활성화되면 라우터에서 우선순위(postgame > pregame)를 정한다.
 */
export default function InsightOverlay(props: InsightOverlayProps) {
  const active = props.kind != null;
  return (
    <AnimatePresence>
      {active && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease }}
          className="absolute inset-0 z-[85]"
        >
          <div className="absolute inset-0 bg-black/45 backdrop-blur-[3px]" />
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.96 }}
            transition={{ duration: 0.28, ease }}
            className="absolute inset-x-5 top-1/2 mx-auto w-[min(92vw,680px)] -translate-y-1/2 rounded-3xl border border-white/10 bg-black/40 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.55)] backdrop-blur-2xl backdrop-saturate-150"
          >
            <button
              type="button"
              onClick={props.kind != null ? props.onDismiss : undefined}
              className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/80 backdrop-blur-md transition hover:bg-white/15 hover:text-white"
              aria-label="인사이트 닫기"
            >
              <X size={14} strokeWidth={2} />
            </button>

            {props.kind === "pregame" ? <PregameContent preview={props.pregamePreview} /> : null}
            {props.kind === "postgame" ? (
              <PostGameContent
                report={props.postGameReport}
                visibleUntilLabel={props.postGameVisibleUntilLabel}
              />
            ) : null}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PregameContent({ preview }: { preview: PregamePreviewView | null }) {
  return (
    <>
      <p
        className="pr-12 text-[12px] font-bold tracking-[0.04em] text-[#ffb07c]"
        style={{ textShadow: "0 1px 6px rgba(0,0,0,0.4)" }}
      >
        🔥 오늘의 매운맛 관전 포인트
      </p>
      {preview?.status === "READY" && preview.lines.length > 0 ? (
        <>
          {preview.title ? (
            <p
              className="mt-3 pr-12 text-[19px] font-bold leading-snug text-white drop-shadow-md"
              style={{ textShadow: "0 2px 10px rgba(0,0,0,0.55)" }}
            >
              {preview.title}
            </p>
          ) : null}
          <div className="mt-4 space-y-2.5">
            {preview.lines.slice(0, 4).map((line, idx) => (
              <p
                key={`${idx}-${line}`}
                className="text-[14.5px] font-medium leading-relaxed text-white/95"
                style={{ textShadow: "0 1px 4px rgba(0,0,0,0.35)" }}
              >
                {line}
              </p>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-4 text-[14.5px] font-medium leading-relaxed text-white/90">
          프리뷰 생성 중... 경기 전 매운맛 리포트를 곧 보여줄게.
        </p>
      )}
    </>
  );
}

function PostGameContent({
  report,
  visibleUntilLabel,
}: {
  report: PostGameReportView | null;
  visibleUntilLabel: string | null;
}) {
  return (
    <>
      <div className="pr-12">
        <p
          className="text-[11px] font-bold uppercase tracking-[0.22em] text-white/70"
          style={{ textShadow: "0 1px 4px rgba(0,0,0,0.4)" }}
        >
          Postgame Report
        </p>
        <p className="mt-1 text-[11px] font-medium text-white/55">
          {visibleUntilLabel ?? "익일 12:00까지"}
        </p>
      </div>
      {report?.status === "READY" ? (
        <>
          <p
            className="mt-3 pr-12 text-[19px] font-bold leading-snug text-white drop-shadow-md"
            style={{ textShadow: "0 2px 10px rgba(0,0,0,0.55)" }}
          >
            {report.headline ?? "🔥 [한줄평] 오늘 경기 매운맛 복기"}
          </p>
          <p
            className="mt-4 text-[14.5px] font-medium leading-relaxed text-white/95"
            style={{ textShadow: "0 1px 4px rgba(0,0,0,0.35)" }}
          >
            {report.content ?? "경기 내용을 분석 중이야. 곧 매운맛 리포트로 업데이트할게."}
          </p>
        </>
      ) : report?.status === "FAILED" ? (
        <p className="mt-4 text-[14.5px] font-medium leading-relaxed text-white/85">
          리포트 생성에 실패했어요. 다음 갱신 주기에 다시 시도합니다.
        </p>
      ) : (
        <p className="mt-4 text-[14.5px] font-medium leading-relaxed text-white/85">
          경기 종료 분석 리포트 생성 중... 잠시만 기다려줘.
        </p>
      )}
    </>
  );
}
