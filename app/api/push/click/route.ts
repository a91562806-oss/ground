import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/push/click?n=MARKETING_PUSH_ID&u=ENCODED_REDIRECT_URL
 *
 * 1) MarketingPush.clickCount += 1
 * 2) 301 redirect → 원래 URL
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const notificationId = searchParams.get("n");
  const redirectUrl = searchParams.get("u");

  if (notificationId) {
    prisma.marketingPush
      .update({ where: { id: notificationId }, data: { clickCount: { increment: 1 } } })
      .catch(() => {});
  }

  const destination = redirectUrl ? decodeURIComponent(redirectUrl) : "/today";
  return NextResponse.redirect(destination, 301);
}
