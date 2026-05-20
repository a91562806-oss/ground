"use client";

const USER_ID_KEY = "ground-notify-user-id";
const FAVORITE_TEAM_KEY = "kbo-my-team";

export type PushTopics = {
  pitcher: boolean;
  preGame: boolean;
  postGame: boolean;
  highlight: boolean;
  score: boolean;
  livePitcherChange: boolean;
  liveStrikeout: boolean;
};

export function getOrCreateNotifyUserId(): string {
  if (typeof window === "undefined") return "anonymous-web";
  const saved = localStorage.getItem(USER_ID_KEY);
  if (saved) return saved;
  const next =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `web-${crypto.randomUUID()}`
      : `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  localStorage.setItem(USER_ID_KEY, next);
  return next;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.register("/sw.js");
  try {
    await reg.update();
  } catch {
    // ignore update failures; registration can still be usable
  }
  return reg;
}

function urlBase64ToUint8Array(base64String: string): BufferSource {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray as unknown as BufferSource;
}

export async function subscribeBrowserPush(
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string
): Promise<PushSubscription> {
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
}

export async function persistSubscription(
  subscription: PushSubscription,
  topics: PushTopics,
  userId: string
) {
  const favoriteTeam =
    typeof window !== "undefined"
      ? localStorage.getItem(FAVORITE_TEAM_KEY)?.trim().toLowerCase() ?? null
      : null;
  const res = await fetch("/api/notifications/subscribe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ground-user-id": userId,
    },
    body: JSON.stringify({ subscription: subscription.toJSON(), topics, favoriteTeam }),
  });
  if (!res.ok) {
    throw new Error(`subscribe api failed (${res.status})`);
  }
}

export async function unsubscribeBrowserPush(userId: string): Promise<void> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) return;

  await fetch("/api/notifications/unsubscribe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ground-user-id": userId,
    },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}
