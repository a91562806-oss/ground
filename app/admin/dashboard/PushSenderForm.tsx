"use client";

import { useState } from "react";

type Team = { id: string; name: string; short: string };

type Props = {
  adminKey: string;
  teams: Team[];
};

type SendState = "idle" | "sending" | "done" | "error";

export default function PushSenderForm({ adminKey, teams }: Props) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("/today");
  const [targetTeamId, setTargetTeamId] = useState<string>("");
  const [state, setState] = useState<SendState>("idle");
  const [testState, setTestState] = useState<SendState>("idle");
  const [result, setResult] = useState<{ sentCount?: number; error?: string } | null>(null);

  const send = async (testOnly: boolean) => {
    const setter = testOnly ? setTestState : setState;
    setter("sending");
    setResult(null);
    try {
      const res = await fetch("/api/admin/send-push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adminKey,
          title: title.trim(),
          body: body.trim(),
          url: url.trim() || "/today",
          targetTeamId: targetTeamId || null,
          testOnly,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setter("error");
        setResult({ error: json.error ?? "unknown error" });
      } else {
        setter("done");
        setResult({ sentCount: json.sentCount });
      }
    } catch {
      setter("error");
      setResult({ error: "network error" });
    }
    setTimeout(() => setter("idle"), 4000);
  };

  const isValid = title.trim().length > 0 && body.trim().length > 0;

  const targetLabel = targetTeamId
    ? (teams.find((t) => t.id === targetTeamId)?.name ?? targetTeamId)
    : "전체 유저";

  return (
    <div className="mt-8 rounded-2xl border border-white/10 bg-slate-900/60 p-5">
      <h2 className="text-lg font-semibold tracking-tight text-white">수동 푸시 발송기</h2>
      <p className="mt-1 text-xs text-slate-400">
        타겟을 선택해 직접 푸시를 발송합니다. 클릭 트래킹 URL이 자동으로 삽입됩니다.
      </p>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* 제목 */}
        <div className="md:col-span-2">
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
            알림 제목
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="예: ⚾ LG 오늘도 잡자!"
            maxLength={80}
            className="w-full rounded-lg border border-white/10 bg-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-white/25 focus:ring-1 focus:ring-white/15"
          />
        </div>

        {/* 본문 */}
        <div className="md:col-span-2">
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
            알림 본문
          </label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="예: 오늘 18:30 롯데전. 한 줄로 끝내자."
            rows={2}
            maxLength={200}
            className="w-full resize-none rounded-lg border border-white/10 bg-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-white/25 focus:ring-1 focus:ring-white/15"
          />
        </div>

        {/* URL */}
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
            이동 URL
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="/today"
            className="w-full rounded-lg border border-white/10 bg-slate-800 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-white/25 focus:ring-1 focus:ring-white/15"
          />
        </div>

        {/* 타겟 */}
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
            발송 대상
          </label>
          <select
            value={targetTeamId}
            onChange={(e) => setTargetTeamId(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-slate-800 px-3.5 py-2.5 text-sm text-white outline-none focus:border-white/25 focus:ring-1 focus:ring-white/15"
          >
            <option value="">전체 유저</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 결과 메시지 */}
      {result && (
        <div
          className={`mt-4 rounded-lg px-4 py-2.5 text-sm font-medium ${
            result.error
              ? "border border-red-500/20 bg-red-950/40 text-red-300"
              : "border border-emerald-500/20 bg-emerald-950/40 text-emerald-300"
          }`}
        >
          {result.error
            ? `오류: ${result.error}`
            : `✓ ${result.sentCount?.toLocaleString("ko-KR")}명에게 발송 완료`}
        </div>
      )}

      {/* 버튼 */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          onClick={() => send(true)}
          disabled={!isValid || testState === "sending"}
          className="flex-1 rounded-lg border border-white/15 bg-slate-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {testState === "sending" ? "발송 중…" : testState === "done" ? "✓ 전송됨" : "📱 내 폰으로 테스트"}
        </button>
        <button
          onClick={() => send(false)}
          disabled={!isValid || state === "sending"}
          className="flex-1 rounded-lg bg-white px-4 py-2.5 text-sm font-bold text-slate-900 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state === "sending"
            ? "발송 중…"
            : state === "done"
              ? "✓ 발송 완료"
              : `🚀 ${targetLabel}에게 발송`}
        </button>
      </div>
    </div>
  );
}
