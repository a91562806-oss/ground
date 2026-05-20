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
          <div className="absolute inset-0 bg-black/58 backdrop-blur-[2px]" />
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.96 }}
            transition={{ duration: 0.28, ease }}
            className="absolute inset-x-5 top-1/2 mx-auto w-[min(92vw,680px)] -translate-y-1/2 rounded-2xl border border-white/18 bg-black/64 px-5 py-5 shadow-[0_18px_44px_rgba(0,0,0,0.45)] backdrop-blur-lg"
          >
            <button
              type="button"
              onClick={props.kind != null ? props.onDismiss : undefined}
              className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-black/30 text-white/70 transition hover:bg-white/10 hover:text-white"
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
      <p className="pr-9 text-[12px] font-semibold tracking-[0.03em] text-[#ffb07c]">
        🔥 오늘의 매운맛 관전 포인트
      </p>
      {preview?.status === "READY" && preview.lines.length > 0 ? (
        <>
          {preview.title ? (
            <p className="mt-2 pr-9 text-[18px] font-semibold leading-snug text-white/95">
              {preview.title}
            </p>
          ) : null}
          <div className="mt-3 space-y-2">
            {preview.lines.slice(0, 4).map((line, idx) => (
              <p key={`${idx}-${line}`} className="text-[14px] leading-relaxed text-white/88">
                {line}
              </p>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-3 text-[14px] leading-relaxed text-white/85">
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
      <div className="pr-9">
        <p className="text-[11px] uppercase tracking-[0.2em] text-white/58">Postgame Report</p>
        <p className="mt-1 text-[11px] text-white/46">{visibleUntilLabel ?? "익일 12:00까지"}</p>
      </div>
      {report?.status === "READY" ? (
        <>
          <p className="mt-2 pr-9 text-[18px] font-semibold leading-snug text-white/95">
            {report.headline ?? "🔥 [한줄평] 오늘 경기 매운맛 복기"}
          </p>
          <p className="mt-3 text-[14px] leading-relaxed text-white/88">
            {report.content ?? "경기 내용을 분석 중이야. 곧 매운맛 리포트로 업데이트할게."}
          </p>
        </>
      ) : report?.status === "FAILED" ? (
        <p className="mt-3 text-[14px] leading-relaxed text-white/82">
          리포트 생성에 실패했어요. 다음 갱신 주기에 다시 시도합니다.
        </p>
      ) : (
        <p className="mt-3 text-[14px] leading-relaxed text-white/82">
          경기 종료 분석 리포트 생성 중... 잠시만 기다려줘.
        </p>
      )}
    </>
  );
}
