import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendWebPush } from "@/lib/webPushServer";
import { mapWithConcurrency } from "@/lib/concurrency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(req: Request): boolean {
  const secret = process.env.ADMIN_SECRET ?? process.env.ADMIN_PASSWORD;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  return new URL(req.url).searchParams.get("key") === secret;
}

/**
 * POST /api/admin/send-push
 * Auth: Authorization: Bearer <ADMIN_SECRET>
 * Body: { title, body, url, targetTeamId?, testOnly? }
 */
export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const { title, body: msgBody, url, targetTeamId = null, testOnly = false } = body as {
    title: string;
    body: string;
    url: string;
    targetTeamId?: string | null;
    testOnly?: boolean;
  };
  if (!title?.trim() || !msgBody?.trim() || !url?.trim()) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  // MarketingPush 레코드 먼저 생성 → ID 확보 (클릭 URL에 삽입)
  const record = await prisma.marketingPush.create({
    data: { title, body: msgBody, url, targetTeamId: targetTeamId || null, testOnly, sentCount: 0, clickCount: 0 },
  });

  const origin = new URL(req.url).origin;
  const clickUrl = `${origin}/api/push/click?n=${record.id}&u=${encodeURIComponent(url)}`;

  // 구독자 조회
  let subs: Array<{ endpoint: string; p256dh: string; auth: string; userId: string }> = [];

  if (testOnly) {
    const adminEmail = process.env.ADMIN_TEST_EMAIL;
    if (!adminEmail) {
      return NextResponse.json({ error: "ADMIN_TEST_EMAIL not set" }, { status: 500 });
    }
    subs = await prisma.pushSubscription.findMany({
      where: { enabled: true, user: { email: adminEmail } },
      select: { endpoint: true, p256dh: true, auth: true, userId: true },
    });
  } else {
    subs = await prisma.pushSubscription.findMany({
      where: {
        enabled: true,
        ...(targetTeamId ? { user: { favoriteTeam: targetTeamId } } : {}),
      },
      select: { endpoint: true, p256dh: true, auth: true, userId: true },
    });
  }

  if (subs.length === 0) {
    await prisma.marketingPush.delete({ where: { id: record.id } });
    return NextResponse.json({ error: "no_subscribers" }, { status: 404 });
  }

  const results = await mapWithConcurrency(subs, 12, (sub) =>
    sendWebPush(
      { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      { title, body: msgBody, url: clickUrl, teamId: targetTeamId ?? "all" },
      { favoriteTeam: targetTeamId ?? undefined, origin }
    )
  );

  const sentCount = results.filter((r) => r.ok).length;

  await prisma.marketingPush.update({
    where: { id: record.id },
    data: { sentCount },
  });

  return NextResponse.json({ ok: true, id: record.id, sentCount, total: subs.length });
}
