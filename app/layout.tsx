import type { Metadata, Viewport } from "next";
import "./globals.css";
import BottomNav from "@/components/BottomNav";
import OnboardingGate from "@/components/OnboardingGate";
import EnvironmentBadge from "@/components/EnvironmentBadge";
import PageShell from "@/components/PageShell";

export const metadata: Metadata = {
  title: "내 팀을 위한 극단적 편파 알림 GROUND",
  description:
    "라인업부터 실시간 편파 중계, 하이라이트까지, 내 팀의 결정적 순간을 전해드릴게요.",
  openGraph: {
    title: "내 팀을 위한 극단적 편파 알림 GROUND",
    description:
      "라인업부터 실시간 편파 중계, 하이라이트까지, 내 팀의 결정적 순간을 전해드릴게요.",
    siteName: "GROUND",
  },
  twitter: {
    title: "내 팀을 위한 극단적 편파 알림 GROUND",
    description:
      "라인업부터 실시간 편파 중계, 하이라이트까지, 내 팀의 결정적 순간을 전해드릴게요.",
  },
  applicationName: "GROUND",
  appleWebApp: {
    capable: true,
    title: "GROUND",
    statusBarStyle: "black-translucent",
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  interactiveWidget: "resizes-content",
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body
        className="bg-black text-white"
        style={{
          backgroundColor: "var(--app-bg, #000000)",
          color: "var(--app-text, #ffffff)",
        }}
      >
        {/*
          OnboardingGate 가 최상단에서 응원팀 미선택 사용자를 가로챈다.
          팀이 선택되어 있지 않으면 children(전체 라우트 + BottomNav)이 렌더되지 않고
          풀스크린 팀 선택 화면이 우선된다.
        */}
        <OnboardingGate>
          <div
            className="app-shell fixed inset-0 mx-auto flex min-h-0 w-full max-w-md flex-col overflow-hidden bg-black"
            style={{
              height: "var(--visual-viewport-height, 100dvh)",
              maxHeight: "var(--visual-viewport-height, 100dvh)",
              backgroundColor: "var(--app-bg, #000000)",
              color: "var(--app-text, #ffffff)",
            }}
          >
            <EnvironmentBadge />
            <main className="flex min-h-0 flex-1 flex-col overflow-hidden pb-24">
              <PageShell>{children}</PageShell>
            </main>
            <BottomNav />
          </div>
        </OnboardingGate>
      </body>
    </html>
  );
}
