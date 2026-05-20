import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveNotifyUserId } from "@/lib/notifyIdentity";
import { resolveServerAppEnv } from "@/lib/appEnv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StatusBody = {
  endpoint?: string;
};

/**
 * 알파 ↔ 프로덕션 격리장치 자가회복.
 * 옛 클라이언트로 만들어진 구독은 `topics.appEnv` 가 비어있어서
 * 알파 서버 발송 필터(`matchesCurrentPushEnv`)에 다 떨어진다.
 * status 호출은 현재 서버에 가입된 endpoint 로만 들어오므로,
 * 매치된 구독의 topics.appEnv 를 현재 서버 환경으로 한 번 강제 갱신해서
 * 사용자가 알파 PWA 를 열기만 해도 다시 푸시 받을 수 있게 한다.
 */
async function ensureSubscriptionEnvTag(subscriptionId: string): Promise<void> {
  const sub = await prisma.pushSubscription.findUnique({
    where: { id: subscriptionId },
    select: { topics: true },
  });
  if (!sub) return;
  const topics = (sub.topics ?? {}) as Record<string, unknown>;
  const currentEnv = resolveServerAppEnv();
  if (topics.appEnv === currentEnv) return;
  await prisma.pushSubscription.update({
    where: { id: subscriptionId },
    data: { topics: { ...topics, appEnv: currentEnv } },
  });
}

export async function POST(req: Request) {
  const userId = resolveNotifyUserId(req.headers.get("x-ground-user-id"));
  let body: StatusBody;
  try {
    body = (await req.json()) as StatusBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const endpoint = body.endpoint?.trim();
  if (!endpoint) {
    return NextResponse.json({ ok: true, status: "unsubscribed" as const });
  }

  const exactMatch = await prisma.pushSubscription.findFirst({
    where: {
      userId,
      endpoint,
      enabled: true,
    },
    select: { id: true },
  });

  if (exactMatch) {
    await ensureSubscriptionEnvTag(exactMatch.id);
    return NextResponse.json({
      ok: true,
      status: "subscribed" as const,
      staleIdentity: false,
    });
  }

  // 브라우저 localStorage 초기화 등으로 userId가 바뀌어도
  // 같은 endpoint 구독이 살아있으면 "구독됨"으로 간주한다.
  const endpointOnlyMatch = await prisma.pushSubscription.findFirst({
    where: {
      endpoint,
      enabled: true,
    },
    select: { id: true },
  });

  if (endpointOnlyMatch) {
    await ensureSubscriptionEnvTag(endpointOnlyMatch.id);
  }

  return NextResponse.json({
    ok: true,
    status: endpointOnlyMatch ? ("subscribed" as const) : ("unsubscribed" as const),
    staleIdentity: Boolean(endpointOnlyMatch),
  });
}
