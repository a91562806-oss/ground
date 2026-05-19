import { findTeam } from "@/lib/teams";

const NAVER_BASE = "https://api-gw.sports.naver.com";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = process.env.PUSH_LLM_MODEL ?? "claude-sonnet-4-6";

type Tone = "win" | "loss" | "draw";

export type PostGameFacts = {
  externalId: string;
  myTeam: string;
  oppTeam: string;
  myScore: number;
  oppScore: number;
  winningPitcher?: string | null;
  losingPitcher?: string | null;
  savePitcher?: string | null;
  clutchHit?: string | null;
  homeRun?: string | null;
  error?: string | null;
  notable?: string[];
};

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, limit = 86): string {
  const normalized = compact(text);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 2)}..`;
}

function readString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = compact(v);
  return t.length > 0 ? t : null;
}

function collectTexts(root: unknown): string[] {
  const out: string[] = [];
  const queue: unknown[] = [root];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }
    if (typeof current !== "object") continue;
    const obj = current as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") {
        const lower = key.toLowerCase();
        if (
          lower.includes("text") ||
          lower.includes("relay") ||
          lower.includes("comment") ||
          lower.includes("summary") ||
          lower.includes("record") ||
          lower.includes("play")
        ) {
          const text = readString(value);
          if (text) out.push(text);
        }
      } else if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }
  return out;
}

function firstByKeyword(texts: string[], regex: RegExp): string | null {
  const found = texts.find((line) => regex.test(line));
  return found ? clip(found) : null;
}

function extractPitcherName(detail: unknown, keys: string[]): string | null {
  const queue: unknown[] = [detail];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }
    if (typeof current !== "object") continue;
    const obj = current as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string" && keys.some((candidate) => key.toLowerCase().includes(candidate))) {
        const text = readString(value);
        if (text) return text;
      } else if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }
  return null;
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 GroundBot/1.0",
        accept: "application/json",
        referer: "https://m.sports.naver.com/",
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildFallbackReport(input: { facts: PostGameFacts; tone: Tone }): { title: string; lines: string[] } {
  const { facts, tone } = input;
  const scoreLine = `${facts.myTeam} ${facts.myScore}:${facts.oppScore} ${facts.oppTeam}`;
  if (tone === "win") {
    return {
      title: `🔥 [한줄평] ${facts.myTeam} 오늘 경기 찢었다.`,
      lines: [
        `[리뷰] 최종 스코어 ${scoreLine}. 오늘은 그냥 우리 날이었다.`,
        `[리뷰] 승리투수 ${facts.winningPitcher ?? "확인 중"} 중심으로 마운드 운영이 깔끔했다.`,
        `[리뷰] ${facts.clutchHit ?? facts.homeRun ?? "결정적 한 방"}이 승부를 갈랐다.`,
      ],
    };
  }
  if (tone === "draw") {
    return {
      title: `😮‍💨 [한줄평] 비겼지만 찝찝하다.`,
      lines: [
        `[리뷰] 최종 스코어 ${scoreLine}. 잡을 경기였는지 복기 필요.`,
        `[리뷰] 투수 운용과 타순 대응이 매 이닝 흔들렸다.`,
        `[리뷰] ${facts.error ?? "작은 실수들"}이 경기 흐름을 계속 끊었다.`,
      ],
    };
  }
  return {
    title: `🌶️ [한줄평] ${facts.myTeam} 오늘 경기 반성문 써라.`,
    lines: [
      `[리뷰] 최종 스코어 ${scoreLine}. 이길 의지가 안 보였다.`,
      `[리뷰] 패전투수 ${facts.losingPitcher ?? "확인 중"}만 탓할 수 없는 경기 운영이었다.`,
      `[리뷰] ${facts.error ?? facts.clutchHit ?? "승부처 대응 실패"}이 그대로 패인으로 남았다.`,
    ],
  };
}

function parseJsonBlock(text: string): { headline?: string; lines?: string[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as { headline?: string; lines?: string[] };
  } catch {
    return null;
  }
}

export async function fetchPostGameFacts(input: {
  externalId: string;
  teamId: string;
  opponentTeamId: string;
  myScore: number;
  oppScore: number;
}): Promise<PostGameFacts> {
  const detail = await fetchJsonWithTimeout(`${NAVER_BASE}/schedule/games/${input.externalId}`, 900);
  const relay = await fetchJsonWithTimeout(`${NAVER_BASE}/schedule/games/${input.externalId}/relayTexts`, 900);
  const texts = [...collectTexts(detail), ...collectTexts(relay)].map((line) => clip(line, 100));

  return {
    externalId: input.externalId,
    myTeam: findTeam(input.teamId).short,
    oppTeam: findTeam(input.opponentTeamId).short,
    myScore: input.myScore,
    oppScore: input.oppScore,
    winningPitcher: extractPitcherName(detail, ["winningpitcher", "winning_pitcher", "winner"]),
    losingPitcher: extractPitcherName(detail, ["losingpitcher", "losing_pitcher", "loser"]),
    savePitcher: extractPitcherName(detail, ["savepitcher", "save_pitcher"]),
    clutchHit: firstByKeyword(texts, /(결승타|역전타|적시타|결정타)/),
    homeRun: firstByKeyword(texts, /(홈런|솔로포|투런|스리런)/),
    error: firstByKeyword(texts, /(실책|에러|E\d)/i),
    notable: texts.slice(0, 5),
  };
}

export async function generatePostGameReport(input: {
  teamId: string;
  tone: Tone;
  facts: PostGameFacts;
}): Promise<{ title: string; lines: string[] }> {
  const fallback = buildFallbackReport({ facts: input.facts, tone: input.tone });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallback;

  const team = findTeam(input.teamId).short;
  const system = `너는 ${team}에 인생을 바친 극성팬이다. 이기면 과하게 찬양하고, 지면 매섭게 비판한다.
반드시 JSON만 출력:
{"headline":"한 줄 평","lines":["리뷰1","리뷰2","리뷰3","리뷰4"]}
규칙:
- headline은 16~34자
- lines는 3~4개
- 각 line 18~72자
- 욕설은 과격하지 않게, 팬 커뮤니티 톤 유지`;
  const prompt = `팀:${input.facts.myTeam}
상대:${input.facts.oppTeam}
결과:${input.tone}
스코어:${input.facts.myScore}:${input.facts.oppScore}
승리투수:${input.facts.winningPitcher ?? "unknown"}
패전투수:${input.facts.losingPitcher ?? "unknown"}
세이브:${input.facts.savePitcher ?? "unknown"}
결승타:${input.facts.clutchHit ?? "unknown"}
홈런:${input.facts.homeRun ?? "unknown"}
실책:${input.facts.error ?? "unknown"}
주요 장면:${(input.facts.notable ?? []).join(" | ") || "unknown"}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1700);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 320,
        temperature: 0.92,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return fallback;
    const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text =
      json.content
        ?.filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text ?? "")
        .join("\n") ?? "";
    const parsed = parseJsonBlock(text);
    const headline = clip(parsed?.headline ?? "", 52);
    const lines = (parsed?.lines ?? [])
      .map((line) => clip(line, 88))
      .filter((line) => line.length > 0)
      .slice(0, 4);
    if (!headline || lines.length < 3) return fallback;
    return { title: headline, lines };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
