type Row = {
  id: string;
  title: string;
  body: string;
  targetTeamId: string | null;
  targetLabel: string;
  sentCount: number;
  clickCount: number;
  ctr: string;
  sentAt: string;
  testOnly: boolean;
};

export default function MarketingPushStats({ rows }: { rows: Row[] }) {
  return (
    <div className="mt-8 rounded-2xl border border-white/10 bg-slate-900/60 p-5">
      <h2 className="text-lg font-semibold tracking-tight text-white">마케팅 푸시 성과</h2>
      <p className="mt-1 text-xs text-slate-400">최근 발송된 수동 푸시 · 발송 수 · 클릭 수 · CTR</p>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-slate-400">발송된 마케팅 푸시가 없습니다.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-[0.14em] text-slate-400">
                <th className="pb-2 pr-4 font-semibold">제목</th>
                <th className="pb-2 pr-4 font-semibold">대상</th>
                <th className="pb-2 pr-4 text-right font-semibold">발송</th>
                <th className="pb-2 pr-4 text-right font-semibold">클릭</th>
                <th className="pb-2 pr-4 text-right font-semibold">CTR</th>
                <th className="pb-2 text-right font-semibold">발송일시</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-white/5 last:border-0">
                  <td className="py-3 pr-4">
                    <p className="max-w-[220px] truncate font-medium text-white">{row.title}</p>
                    <p className="mt-0.5 max-w-[220px] truncate text-xs text-slate-400">{row.body}</p>
                  </td>
                  <td className="py-3 pr-4">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] ${
                        row.testOnly
                          ? "bg-amber-900/40 text-amber-300"
                          : "bg-slate-700 text-slate-200"
                      }`}
                    >
                      {row.testOnly ? "TEST" : row.targetLabel}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums text-white">
                    {row.sentCount.toLocaleString("ko-KR")}
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums text-white">
                    {row.clickCount.toLocaleString("ko-KR")}
                  </td>
                  <td className="py-3 pr-4 text-right">
                    <span
                      className={`font-bold tabular-nums ${
                        parseFloat(row.ctr) >= 10
                          ? "text-emerald-400"
                          : parseFloat(row.ctr) >= 5
                            ? "text-amber-400"
                            : "text-slate-300"
                      }`}
                    >
                      {row.ctr}%
                    </span>
                  </td>
                  <td className="py-3 text-right text-xs text-slate-400">{row.sentAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
