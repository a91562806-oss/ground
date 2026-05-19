import { findTeam } from "@/lib/teams";
import type { LiveGame } from "@/lib/kbo";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = process.env.PUSH_LLM_MODEL ?? "claude-3-haiku-20240307";
const NAVER_BASE = "https://api-gw.sports.naver.com";
const NAVER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 GroundBot/1.0";

export type PregamePreviewInput = {
  date: string;
  game: LiveGame;
  teamId: string;
  opponentTeamId: string;
  recentGames: LiveGame[];
  newsContext: string[];
};

export type PregamePreviewOutput = {
  title: string;
  lines: string[];
  context: {
    recentForm: string;
    recentScores: string[];
    newsSnippets: string[];
  };
  source: "llm" | "fallback";
};

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max = 88): string {
  const normalized = compact(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 2)}..`;
}

function resultMark(game: LiveGame, teamId: string): "W" | "L" | "D" | null {
  if (!game.result) return null;
  if (game.result.winnerId == null) return "D";
  return game.result.winnerId === teamId ? "W" : "L";
}

function buildRecentFormSummary(recentGames: LiveGame[], teamId: string): { form: string; scores: string[] } {
  const ordered = [...recentGames]
    .filter((g) => g.result)
    .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)))
    .slice(-5);
  const formTokens: string[] = [];
  const scoreLines: string[] = [];
  for (const game of ordered) {
    const myIsHome = game.homeId === teamId;
    const myTeam = findTeam(teamId).short;
    const oppId = myIsHome ? game.awayId : game.homeId;
    const oppTeam = findTeam(oppId).short;
    const myScore = myIsHome ? game.result?.homeScore ?? 0 : game.result?.awayScore ?? 0;
    const oppScore = myIsHome ? game.result?.awayScore ?? 0 : game.result?.homeScore ?? 0;
    const mark = resultMark(game, teamId);
    if (mark) formTokens.push(mark);
    scoreLines.push(`${myTeam} ${myScore}:${oppScore} ${oppTeam}`);
  }
  return {
    form: formTokens.length > 0 ? formTokens.join("") : "기록 없음",
    scores: scoreLines.slice(-5),
  };
}

function collectTexts(root: unknown): string[] {
  const queue: unknown[] = [root];
  const out: string[] = [];
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
          lower.includes("title") ||
          lower.includes("summary") ||
          lower.includes("text") ||
          lower.includes("content") ||
          lower.includes("news")
        ) {
          const t = compact(value);
          if (t.length >= 12) out.push(t);
        }
      } else if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }
  return out;
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": NAVER_UA,
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

export async function fetchPregameNewsContext(input: {
  gameId: string;
  teamId: string;
  opponentTeamId: string;
}): Promise<string[]> {
  const endpoints = [
    `${NAVER_BASE}/schedule/games/${input.gameId}`,
    `${NAVER_BASE}/schedule/games/${input.gameId}/relayTexts`,
    `${NAVER_BASE}/news?upperCategoryId=kbaseball&categoryId=kbo&size=10`,
  ];
  const merged: string[] = [];
  for (const endpoint of endpoints) {
    const json = await fetchJsonWithTimeout(endpoint, 900);
    if (!json) continue;
    merged.push(...collectTexts(json));
  }
  const dedup = [...new Set(merged.map((line) => clip(line, 110)))];
  return dedup.slice(0, 8);
}

function buildFallback(input: PregamePreviewInput): PregamePreviewOutput {
  const team = findTeam(input.teamId).short;
  const opp = findTeam(input.opponentTeamId).short;
  const recent = buildRecentFormSummary(input.recentGames, input.teamId);
  return {
    title: "🔥 오늘의 매운맛 관전 포인트",
    lines: [
      `${team} 최근 5경기 흐름 ${recent.form}. 초반 이닝부터 승부 걸어야 산다.`,
      `오늘 선발 ${input.game.homeId === input.teamId ? input.game.homePitcher : input.game.awayPitcher}, 최소 6이닝 먹어줘야 한다.`,
      `${opp} 상대로 ${input.game.time} ${input.game.stadium || "원정"}에서 시작. 초반에 점수 못 내면 답답해진다.`,
      `한 줄 결론: 오늘은 불펜 가기 전에 타선이 먼저 터뜨려야 한다.`,
    ].map((line) => clip(line)),
    context: {
      recentForm: recent.form,
      recentScores: recent.scores,
      newsSnippets: input.newsContext.slice(0, 4),
    },
    source: "fallback",
  };
}

function parseStructuredResponse(text: string): { title?: string; lines?: string[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as { title?: string; lines?: string[] };
  } catch {
    return null;
  }
}

export async function generatePregamePreview(input: PregamePreviewInput): Promise<PregamePreviewOutput> {
  const fallback = buildFallback(input);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallback;

  const team = findTeam(input.teamId).short;
  const opp = findTeam(input.opponentTeamId).short;
  const recent = buildRecentFormSummary(input.recentGames, input.teamId);
  const newsBlock = input.newsContext.slice(0, 5).join(" | ") || "없음";
  const starter = input.game.homeId === input.teamId ? input.game.homePitcher : input.game.awayPitcher;

  const system = `너는 ${team} 극성팬이자 냉철한 전력 분석관이다.
최근 흐름과 결장/이슈 컨텍스트를 짚고 오늘 이기려면 뭘 해야 하는지 매운맛으로 요약한다.
반드시 JSON만 출력:
{"title":"🔥 오늘의 매운맛 관전 포인트","lines":["문장1","문장2","문장3","문장4"]}
규칙:
- lines는 3~4개
- 각 line 24~82자
- 유치한 반복 표현 금지`;

  const user = `팀:${team}
상대:${opp}
경기:${input.date} ${input.game.time} ${input.game.stadium}
우리 선발:${starter}
최근 5경기 흐름:${recent.form}
최근 스코어:${recent.scores.join(" / ") || "없음"}
프리뷰/뉴스 컨텍스트:${newsBlock}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
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
        max_tokens: 340,
        temperature: 0.94,
        system,
        messages: [{ role: "user", content: user }],
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
    const parsed = parseStructuredResponse(text);
    const title = clip(parsed?.title ?? "", 42);
    const lines = (parsed?.lines ?? []).map((line) => clip(line)).filter((line) => line.length > 0).slice(0, 4);
    if (!title || lines.length < 3) return fallback;
    return {
      title,
      lines,
      context: {
        recentForm: recent.form,
        recentScores: recent.scores,
        newsSnippets: input.newsContext.slice(0, 4),
      },
      source: "llm",
    };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
