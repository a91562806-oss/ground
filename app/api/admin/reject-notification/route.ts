import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(req: Request): boolean {
  const secret = process.env.ADMIN_SECRET ?? process.env.ADMIN_PASSWORD;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  const url = new URL(req.url);
  return url.searchParams.get("key") === secret;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const { id } = body;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ ok: false, error: "missing_id" }, { status: 400 });
  }

  const pending = await prisma.pendingPushNotification.findUnique({ where: { id } });
  if (!pending) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (pending.status !== "PENDING") {
    return NextResponse.json({ ok: false, error: `already_${pending.status.toLowerCase()}` }, { status: 400 });
  }

  await prisma.pendingPushNotification.update({
    where: { id },
    data: { status: "REJECTED", rejectedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
