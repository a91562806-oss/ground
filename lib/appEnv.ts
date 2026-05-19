export type AppEnv = "production" | "alpha" | "development";

function normalizeEnv(raw: string | undefined): AppEnv {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "alpha" || value === "staging") return "alpha";
  if (value === "prod" || value === "production") return "production";
  return "development";
}

export function resolveServerAppEnv(): AppEnv {
  return normalizeEnv(process.env.APP_ENV ?? process.env.NEXT_PUBLIC_APP_ENV);
}

export function isAlphaServerEnv(): boolean {
  return resolveServerAppEnv() === "alpha";
}

export function shouldSkipCronInAlpha(url: URL): boolean {
  if (!isAlphaServerEnv()) return false;
  const force = (url.searchParams.get("force") ?? "").toLowerCase();
  return !(force === "1" || force === "true" || force === "yes");
}
