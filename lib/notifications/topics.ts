import { isAlphaServerEnv, resolveServerAppEnv, type AppEnv } from "@/lib/appEnv";

/**
 * 푸시 알림 토픽 / 알림 종류에 대한 단일 진실 모듈.
 * 라우트, 서비스, 컴포넌트가 모두 여기서 타입을 임포트한다.
 */

export type TopicKey =
  | "pitcher"
  | "preGame"
  | "postGame"
  | "highlight"
  | "score"
  | "livePitcherChange"
  | "liveStrikeout";

export const TOPIC_KEYS: readonly TopicKey[] = [
  "pitcher",
  "preGame",
  "postGame",
  "highlight",
  "score",
  "livePitcherChange",
  "liveStrikeout",
] as const;

export type AlertKind =
  | "preview"
  | "game-start"
  | "score"
  | "live-event"
  | "postgame"
  | "highlight"
  | "cancel";

export type SubscriptionTopics = Partial<Record<TopicKey, boolean>> & {
  /** 구독을 만든 클라이언트 환경. 알파 서버는 알파 구독에만 푸시한다. */
  appEnv?: AppEnv;
  /** 레거시 호환: 옛 클라이언트가 보내던 키 — 더 이상 사용하지 않음. */
  gameEnd?: boolean;
};

/**
 * 토픽이 활성화된 상태인지 판정.
 *
 * - 명시적으로 boolean이 박힌 경우 그 값을 사용.
 * - `livePitcherChange` / `liveStrikeout` 은 구버전 클라이언트 호환을 위해
 *   값이 없으면 ON 으로 간주 (default true).
 * - `highlight` 는 옛 `postGame` 토글 ON 만 켜져 있어도 같이 허용.
 */
export function isTopicEnabled(topics: unknown, key: TopicKey): boolean {
  if (!topics || typeof topics !== "object") return false;
  const parsed = topics as SubscriptionTopics;
  const value = parsed[key];
  if (typeof value === "boolean") return value;
  if (key === "highlight") return Boolean(parsed.postGame);
  if (key === "livePitcherChange" || key === "liveStrikeout") return true;
  return false;
}

/**
 * 현재 서버 환경(alpha/prod/dev)이 구독자의 환경과 일치하는지 검사.
 * alpha 서버는 alpha 구독자에게만 발송 — 실 서비스 사용자에게 절대 보내지 않는다.
 */
export function matchesCurrentPushEnv(topics: unknown): boolean {
  if (!isAlphaServerEnv()) return true;
  if (!topics || typeof topics !== "object") return false;
  const parsed = topics as SubscriptionTopics;
  return parsed.appEnv === "alpha";
}

/**
 * 클라이언트에서 구독을 만들 때, 현재 빌드 환경을 토픽에 박아준다.
 * 서버는 이 값을 보고 알파 ↔ 프로덕션 푸시를 격리한다.
 */
export function currentClientAppEnv(): AppEnv {
  return resolveServerAppEnv();
}
