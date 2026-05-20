"use client";

import { useState, useTransition } from "react";

type PendingNotification = {
  id: string;
  teamId: string;
  topicKey: string;
  title: string;
  body: string;
  url: string;
  type: string;
  status: "PENDING" | "SENT" | "REJECTED";
  createdAt: string;
};

type ItemState = "idle" | "approving" | "rejecting" | "done_approved" | "done_rejected" | "error";

function formatDateTimeKst(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export default function PendingNotificationsSection({
  initialItems,
  adminKey,
}: {
  initialItems: PendingNotification[];
  adminKey: string;
}) {
  const [items, setItems] = useState<PendingNotification[]>(initialItems);
  const [itemStates, setItemStates] = useState<Record<string, ItemState>>({});
  const [errorMessages, setErrorMessages] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();

  const pendingCount = items.filter((i) => i.status === "PENDING").length;

  async function handleApprove(id: string) {
    setItemStates((prev) => ({ ...prev, [id]: "approving" }));
    try {
      const res = await fetch("/api/admin/approve-notification", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminKey}`,
        },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setItemStates((prev) => ({ ...prev, [id]: "error" }));
        setErrorMessages((prev) => ({ ...prev, [id]: data.error ?? "unknown error" }));
        return;
      }
      startTransition(() => {
        setItemStates((prev) => ({ ...prev, [id]: "done_approved" }));
        setItems((prev) =>
          prev.map((item) => (item.id === id ? { ...item, status: "SENT" as const } : item))
        );
      });
    } catch {
      setItemStates((prev) => ({ ...prev, [id]: "error" }));
      setErrorMessages((prev) => ({ ...prev, [id]: "네트워크 오류" }));
    }
  }

  async function handleReject(id: string) {
    setItemStates((prev) => ({ ...prev, [id]: "rejecting" }));
    try {
      const res = await fetch("/api/admin/reject-notification", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminKey}`,
        },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setItemStates((prev) => ({ ...prev, [id]: "error" }));
        setErrorMessages((prev) => ({ ...prev, [id]: data.error ?? "unknown error" }));
        return;
      }
      startTransition(() => {
        setItemStates((prev) => ({ ...prev, [id]: "done_rejected" }));
        setItems((prev) =>
          prev.map((item) => (item.id === id ? { ...item, status: "REJECTED" as const } : item))
        );
      });
    } catch {
      setItemStates((prev) => ({ ...prev, [id]: "error" }));
      setErrorMessages((prev) => ({ ...prev, [id]: "네트워크 오류" }));
    }
  }

  return (
    <div className="mt-8 rounded-2xl border border-amber-500/30 bg-amber-950/20 p-5">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">
          승인 대기 중인 알림
        </h2>
        {pendingCount > 0 && (
          <span className="rounded-full bg-amber-500 px-2.5 py-0.5 text-xs font-bold text-black">
            {pendingCount}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-400">
        AUTO_CONFIRM_PUSH=false 일 때 크론잡이 생성한 알림. 승인 시 즉시 FCM 발송됩니다.
      </p>

      {items.length === 0 ? (
        <p className="mt-6 text-sm text-slate-400">대기 중인 알림이 없습니다.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map((item) => {
            const state: ItemState = itemStates[item.id] ?? "idle";
            const isBusy = state === "approving" || state === "rejecting";
            const isPending = item.status === "PENDING" && state !== "done_approved" && state !== "done_rejected";

            return (
              <li
                key={item.id}
                className={[
                  "rounded-xl border p-4 transition-opacity",
                  isPending
                    ? "border-amber-500/20 bg-slate-950/60"
                    : "border-white/5 bg-slate-950/30 opacity-50",
                ].join(" ")}
              >
                {/* 헤더 행 */}
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-semibold text-white">{item.title}</p>
                    <p className="mt-1 text-sm text-slate-300">{item.body}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {isPending ? (
                      <>
                        <button
                          disabled={isBusy}
                          onClick={() => handleApprove(item.id)}
                          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
                        >
                          {state === "approving" ? "발송 중…" : "✓ 발송 승인"}
                        </button>
                        <button
                          disabled={isBusy}
                          onClick={() => handleReject(item.id)}
                          className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-600 disabled:opacity-40"
                        >
                          {state === "rejecting" ? "처리 중…" : "✕ 반려"}
                        </button>
                      </>
                    ) : (
                      <span
                        className={[
                          "rounded-lg px-3 py-1.5 text-xs font-semibold",
                          item.status === "SENT" || state === "done_approved"
                            ? "bg-emerald-900/60 text-emerald-300"
                            : "bg-slate-700/60 text-slate-400",
                        ].join(" ")}
                      >
                        {item.status === "SENT" || state === "done_approved" ? "✓ 발송됨" : "✕ 반려됨"}
                      </span>
                    )}
                  </div>
                </div>

                {/* 메타 정보 */}
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                  <span>팀: {item.teamId.toUpperCase()}</span>
                  <span>토픽: {item.topicKey}</span>
                  <span>타입: {item.type}</span>
                  <span>생성: {formatDateTimeKst(item.createdAt)} KST</span>
                </div>

                {/* 에러 메시지 */}
                {state === "error" && (
                  <p className="mt-2 text-xs text-red-400">
                    오류: {errorMessages[item.id] ?? "알 수 없는 오류"}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
