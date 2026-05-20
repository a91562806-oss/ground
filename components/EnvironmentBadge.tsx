"use client";

const APP_ENV = (process.env.NEXT_PUBLIC_APP_ENV ?? "").trim().toLowerCase();

export default function EnvironmentBadge() {
  if (APP_ENV !== "alpha") return null;
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-[170] rounded-full border border-amber-300/55 bg-amber-400/18 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-100">
      Alpha
    </div>
  );
}
