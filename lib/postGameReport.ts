import { findTeam } from "@/lib/teams";

const NAVER_BASE = "https://api-gw.sports.naver.com";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = process.env.POSTGAME_LLM_MODEL ?? "claude-sonnet-4-6";

type Tone = "win" | "loss" | "draw";

export type PostGameFacts = {
  externalId: string;
  myTeam: string;
  oppTeam: string;
  myScore: number;
  oppScore: number;
  myHits: number | null;
  oppHits: number | null;
  myErrors: number | null;
  oppErrors: number | null;
  myHomeRuns: number | null;
  oppHomeRuns: number | null;
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

function readNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function sanitizeTextValue(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = compact(v);
  if (!t) return null;
  if (/^(확인\s*중|tbd|미정|unknown|null|n\/a|-|없음)$/i.test(t)) return null;
  return t;
}

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickBySeed<T>(seed: string, list: readonly T[]): T {
  return list[hashSeed(seed) % list.length];
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
        const text = sanitizeTextValue(readString(value));
        if (text) return text;
      } else if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }
  return null;
}

type Side = "home" | "away";

type ParsedBoxStats = {
  homeHits: number | null;
  awayHits: number | null;
  homeErrors: number | null;
  awayErrors: number | null;
  homeHomeRuns: number | null;
  awayHomeRuns: number | null;
};

type ParsedPitchingResult = {
  winningPitcher: string | null;
  losingPitcher: string | null;
  savePitcher: string | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function sumTeamHr(list: unknown): number | null {
  if (!Array.isArray(list)) return null;
  let total = 0;
  let found = false;
  for (const row of list) {
    const obj = asRecord(row);
    if (!obj) continue;
    const hr = readNumber(obj.hr);
    if (hr == null || hr < 0) continue;
    found = true;
    total += Math.round(hr);
  }
  return found ? total : null;
}

function parseBoxStats(recordResponse: unknown): ParsedBoxStats {
  const result = asRecord(recordResponse)?.result;
  const recordData = asRecord(result)?.recordData;
  const scoreBoard = asRecord(recordData && asRecord(recordData)?.scoreBoard);
  const rheb = asRecord(scoreBoard && asRecord(scoreBoard)?.rheb);
  const rhebHome = asRecord(rheb && asRecord(rheb)?.home);
  const rhebAway = asRecord(rheb && asRecord(rheb)?.away);
  const battersBoxscore = asRecord(recordData && asRecord(recordData)?.battersBoxscore);

  const homeHits = readNumber(rhebHome?.h) ?? readNumber(asRecord(battersBoxscore?.homeTotal)?.hit);
  const awayHits = readNumber(rhebAway?.h) ?? readNumber(asRecord(battersBoxscore?.awayTotal)?.hit);
  const homeErrors = readNumber(rhebHome?.e);
  const awayErrors = readNumber(rhebAway?.e);
  const homeHomeRuns = sumTeamHr(battersBoxscore?.home);
  const awayHomeRuns = sumTeamHr(battersBoxscore?.away);

  return {
    homeHits,
    awayHits,
    homeErrors,
    awayErrors,
    homeHomeRuns,
    awayHomeRuns,
  };
}

function parsePitchingResult(recordResponse: unknown): ParsedPitchingResult {
  const result = asRecord(recordResponse)?.result;
  const recordData = asRecord(result)?.recordData;
  const rows = asRecord(recordData)?.pitchingResult;
  if (!Array.isArray(rows)) {
    return { winningPitcher: null, losingPitcher: null, savePitcher: null };
  }
  let winningPitcher: string | null = null;
  let losingPitcher: string | null = null;
  let savePitcher: string | null = null;
  for (const item of rows) {
    const row = asRecord(item);
    if (!row) continue;
    const wls = readString(row.wls)?.toUpperCase() ?? "";
    const name = sanitizeTextValue(readString(row.name));
    if (!name) continue;
    if (wls === "W" || wls === "승") winningPitcher = winningPitcher ?? name;
    else if (wls === "L" || wls === "패") losingPitcher = losingPitcher ?? name;
    else if (wls === "S" || wls === "세") savePitcher = savePitcher ?? name;
  }
  return { winningPitcher, losingPitcher, savePitcher };
}

function countTeamKeyword(texts: string[], teamShort: string, regex: RegExp): number | null {
  const safe = teamShort.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = new RegExp(`${safe}[\\s\\S]{0,18}${regex.source}`, "i");
  const around = texts.filter((line) => exact.test(line)).length;
  return around > 0 ? around : null;
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

function buildFallbackReport(input: { facts: PostGameFacts; tone: Tone }): { headline: string; content: string } {
  const { facts, tone } = input;
  const seedBase = `${facts.externalId}:${facts.myTeam}:${facts.myScore}:${facts.oppScore}`;
  const hitDiff =
    facts.myHits != null && facts.oppHits != null ? facts.myHits - facts.oppHits : null;
  const errDiff =
    facts.myErrors != null && facts.oppErrors != null ? facts.oppErrors - facts.myErrors : null;
  const hrDiff =
    facts.myHomeRuns != null && facts.oppHomeRuns != null ? facts.myHomeRuns - facts.oppHomeRuns : null;
  const gap = facts.myScore - facts.oppScore;
  const scoreLine = `${facts.myScore}:${facts.oppScore}`;
  const statLine = `안타 ${facts.myHits ?? "?"}-${facts.oppHits ?? "?"}, 실책 ${facts.myErrors ?? "?"}-${facts.oppErrors ?? "?"}, 홈런 ${facts.myHomeRuns ?? "?"}-${facts.oppHomeRuns ?? "?"}`;

  const winHeads = [
    `🔥 [한줄평] ${facts.myTeam}, 흐름 설계부터 마무리까지 완승.`,
    `🔥 [한줄평] ${facts.myTeam}, 오늘은 약점 없이 이겼다.`,
    `🔥 [한줄평] ${facts.myTeam}, 승부처 운영에서 급이 달랐다.`,
  ] as const;
  const lossHeads = [
    `🔥 [한줄평] ${facts.myTeam}는 오늘 경기 운영이 완전히 무너졌다.`,
    `🔥 [한줄평] ${facts.myTeam}는 디테일에서 밀리며 자멸했다.`,
    `🔥 [한줄평] ${facts.myTeam}는 초반부터 플랜이 꼬였다.`,
  ] as const;
  const drawHeads = [
    `😮‍💨 [한줄평] ${facts.myTeam} 오늘은 이길 경기 놓쳤다.`,
    `😮‍💨 [한줄평] ${facts.myTeam} 무승부지만 내용은 찝찝했다.`,
    `😮‍💨 [한줄평] ${facts.myTeam} 승부처 결정력이 아쉬웠다.`,
  ] as const;

  const hitClause =
    hitDiff == null
      ? "타격 수치가 완전하진 않지만, 흐름 자체는 분명히 갈렸다."
      : hitDiff >= 5
        ? `${facts.myTeam} 타선이 안타 ${Math.abs(hitDiff)}개 우위를 만들면서 경기 템포를 지배했다.`
        : hitDiff <= -5
          ? `안타에서 ${Math.abs(hitDiff)}개 밀린 게 가장 큰 패인이었다.`
          : `안타 격차는 크지 않았지만 득점권 실행력에서 차이가 났다.`;
  const errorClause =
    errDiff == null
      ? "수비 장면 하나하나에서 집중력 차이가 체감됐다."
      : errDiff >= 1
        ? `${facts.oppTeam} 쪽 실수가 더 많아 접전 구간에서 흐름이 끊겼다.`
        : errDiff <= -1
          ? `${facts.myTeam} 실책이 나온 이닝마다 분위기를 내줬다.`
          : "실책 숫자는 같아도 수비 난이도 높은 장면 처리에서 온도차가 있었다.";
  const hrClause =
    hrDiff == null
      ? "장타 지표가 비어 있어도, 승부처에서 더 날카로운 쪽이 이겼다."
      : hrDiff > 0
        ? `홈런 ${facts.myHomeRuns}-${facts.oppHomeRuns}의 장타 우위가 결정타가 됐다.`
        : hrDiff < 0
          ? `홈런 ${facts.myHomeRuns}-${facts.oppHomeRuns} 열세가 그대로 화력 차이로 이어졌다.`
          : "홈런 수는 같았지만 빅이닝을 만든 쪽이 결국 경기를 가져갔다.";

  const closer = facts.clutchHit ?? facts.homeRun ?? facts.error ?? null;
  const closerLine = closer
    ? `키 장면으로는 "${clip(closer, 44)}" 한 줄만 봐도 오늘 흐름이 설명된다.`
    : "결국 디테일에서 버틴 팀이 마지막에 웃은 경기였다.";

  if (tone === "win") {
    const headline = pickBySeed(`${seedBase}:win:head`, winHeads);
    const first = pickBySeed(`${seedBase}:win:first`, [
      `${facts.myTeam}가 ${facts.oppTeam}를 ${scoreLine}로 잡았다.`,
      `${scoreLine}, ${facts.myTeam} 쪽 운영 완성도가 훨씬 높았다.`,
      `${scoreLine} 승리. 경기 설계부터 마무리까지 크게 흔들리지 않았다.`,
    ]);
    return {
      headline,
      content: `${first} 박스스코어만 봐도 ${statLine}로 우위가 분명하다. ${hitClause} ${errorClause} ${hrClause} ${closerLine}`,
    };
  }
  if (tone === "draw") {
    const headline = pickBySeed(`${seedBase}:draw:head`, drawHeads);
    return {
      headline,
      content: `${facts.myTeam}와 ${facts.oppTeam}가 ${scoreLine}으로 비겼지만 내용은 팽팽하지 않았다. ${statLine}. ${hitClause} ${errorClause} ${closerLine}`,
    };
  }
  const headline = pickBySeed(`${seedBase}:loss:head`, lossHeads);
  const first = gap <= -8
    ? `${facts.myTeam}가 ${facts.oppTeam}에 ${scoreLine}으로 크게 무너졌다.`
    : `${facts.myTeam}가 ${facts.oppTeam}에 ${scoreLine}으로 졌고, 추격 흐름을 만들지 못했다.`;
  const pitcherLine = facts.losingPitcher
    ? `${facts.losingPitcher} 한 명만 탓해선 정리가 안 되는 경기였고, 벤치 포함 전체 복기가 필요하다.`
    : "특정 선수 한 명으로 덮을 경기가 아니라 팀 단위 복기가 필요하다.";
  return {
    headline,
    content: `${first} 숫자로 보면 ${statLine}에서 이미 균형이 무너져 있었다. ${hitClause} ${errorClause} ${hrClause} ${pitcherLine}`,
  };
}

function parseJsonBlock(text: string): { headline?: string; content?: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as { headline?: string; content?: string };
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
  mySide: Side;
}): Promise<PostGameFacts> {
  const detail = await fetchJsonWithTimeout(`${NAVER_BASE}/schedule/games/${input.externalId}`, 900);
  const box = await fetchJsonWithTimeout(`${NAVER_BASE}/schedule/games/${input.externalId}/record`, 900);
  const relay = await fetchJsonWithTimeout(`${NAVER_BASE}/schedule/games/${input.externalId}/relayTexts`, 900);
  const texts = [...collectTexts(detail), ...collectTexts(relay)].map((line) => clip(line, 100));
  const side: Side = input.mySide;
  const opposite: Side = side === "home" ? "away" : "home";
  const stats = parseBoxStats(box);
  const pitching = parsePitchingResult(box);

  const myHits = side === "home" ? stats.homeHits : stats.awayHits;
  const oppHits = side === "home" ? stats.awayHits : stats.homeHits;
  const myErrors = side === "home" ? stats.homeErrors : stats.awayErrors;
  const oppErrors = side === "home" ? stats.awayErrors : stats.homeErrors;
  const myHomeRuns =
    (side === "home" ? stats.homeHomeRuns : stats.awayHomeRuns) ??
    countTeamKeyword(texts, findTeam(input.teamId).short, /(홈런|솔로포|투런|스리런)/);
  const oppHomeRuns =
    (side === "home" ? stats.awayHomeRuns : stats.homeHomeRuns) ??
    countTeamKeyword(texts, findTeam(input.opponentTeamId).short, /(홈런|솔로포|투런|스리런)/);

  return {
    externalId: input.externalId,
    myTeam: findTeam(input.teamId).short,
    oppTeam: findTeam(input.opponentTeamId).short,
    myScore: input.myScore,
    oppScore: input.oppScore,
    myHits,
    oppHits,
    myErrors,
    oppErrors,
    myHomeRuns,
    oppHomeRuns,
    winningPitcher:
      pitching.winningPitcher ??
      sanitizeTextValue(extractPitcherName(detail, ["winningpitcher", "winning_pitcher", "winner"])),
    losingPitcher:
      pitching.losingPitcher ??
      sanitizeTextValue(extractPitcherName(detail, ["losingpitcher", "losing_pitcher", "loser"])),
    savePitcher:
      pitching.savePitcher ??
      sanitizeTextValue(extractPitcherName(detail, ["savepitcher", "save_pitcher"])),
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
  strictLlm?: boolean;
}): Promise<{ headline: string; content: string }> {
  const fallback = buildFallbackReport({ facts: input.facts, tone: input.tone });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    if (input.strictLlm) throw new Error("ANTHROPIC_API_KEY is missing (strictLlm mode)");
    return fallback;
  }

  const team = findTeam(input.teamId).short;
  const system = `너는 오늘 경기를 직관하고 온 ${team} 극성팬이다.
기계적인 스포츠 기사 말투 절대 금지. 요약체/브리핑체/불릿체 금지.
점수 차이, 안타 수, 실책 수, 홈런 수를 근거로 칭찬하거나 날카롭게 비판한다.
반드시 JSON만 출력:
{"headline":"🔥 [한줄평] ...","content":"3~4문장 단락"}
규칙:
- headline: 18~56자
- content: 3~4문장 한 단락(줄바꿈 없이, 문장마다 어휘를 다르게)
- 우리 팀 관점 고정
- 상대팀과 똑같은 내용 재사용 금지
- 아래 금칙어 금지: "확인 중", "정보 없음", "탓할 수 없는"
- 데이터가 비어도 추측 금지하고 자연스러운 축약 표현 사용`;
  const prompt = `팀:${input.facts.myTeam}
상대:${input.facts.oppTeam}
결과:${input.tone}
스코어:${input.facts.myScore}:${input.facts.oppScore}
안타:${input.facts.myHits ?? "unknown"}:${input.facts.oppHits ?? "unknown"}
실책:${input.facts.myErrors ?? "unknown"}:${input.facts.oppErrors ?? "unknown"}
홈런:${input.facts.myHomeRuns ?? "unknown"}:${input.facts.oppHomeRuns ?? "unknown"}
승리투수:${input.facts.winningPitcher ?? "정보없음"}
패전투수:${input.facts.losingPitcher ?? "정보없음"}
세이브:${input.facts.savePitcher ?? "unknown"}
결승타:${input.facts.clutchHit ?? "unknown"}
주요 장면:${(input.facts.notable ?? []).join(" | ") || "unknown"}`;

  const callLlm = async (timeoutMs: number) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
          max_tokens: 360,
          temperature: 0.98,
          system,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("[postgame-llm] bad_response", res.status, body.slice(0, 280));
        return null;
      }
      const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
      const text =
        json.content
          ?.filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text ?? "")
          .join("\n") ?? "";
      const parsed = parseJsonBlock(text);
      const headline = clip(parsed?.headline ?? "", 62);
      const content = clip(parsed?.content ?? "", 320);
      if (!headline || !content) return null;
      if (/확인\s*중|정보\s*없음|탓할 수 없는/i.test(`${headline} ${content}`)) return null;
      return { headline, content };
    } catch (error) {
      console.error("[postgame-llm] request_failed", (error as Error).message);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  const first = await callLlm(12000);
  if (first) return first;

  const second = await callLlm(18000);
  if (second) return second;

  if (input.strictLlm) {
    throw new Error("Claude generation failed after retries (strictLlm mode)");
  }

  return fallback;
}
