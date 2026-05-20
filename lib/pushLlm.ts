import { findTeam } from "@/lib/teams";

type GenerateScorePushInput = {
  favoriteTeam: string;
  opponentTeam: string;
  myScore: number;
  oppScore: number;
  latestPlayText: string;
  fallbackTitle: string;
  fallbackBody: string;
  recentBodies?: string[];
};

type GenerateScorePushOptions = {
  apiKeyOverride?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-3-haiku-20240307";

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clipForPush(text: string): string {
  const compact = compactText(text);
  if (compact.length <= 52) return compact;
  return `${compact.slice(0, 50)}..`;
}

function resolveScoreGap(input: GenerateScorePushInput): number {
  return Math.abs(input.myScore - input.oppScore);
}

function resolveScoreGapTier(input: GenerateScorePushInput): "close" | "danger" | "garbage" {
  const gap = resolveScoreGap(input);
  if (gap <= 2) return "close";
  if (gap <= 5) return "danger";
  return "garbage";
}

function normalizeForSimilarity(text: string): string {
  return compactText(text)
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function calcTokenOverlapRatio(a: string, b: string): number {
  const aSet = new Set(a.split(" ").filter((token) => token.length > 1));
  const bSet = new Set(b.split(" ").filter((token) => token.length > 1));
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let inter = 0;
  for (const token of aSet) {
    if (bSet.has(token)) inter += 1;
  }
  const union = aSet.size + bSet.size - inter;
  return union <= 0 ? 0 : inter / union;
}

function isNearDuplicate(candidate: string, recentBodies: string[]): boolean {
  const normalizedCandidate = normalizeForSimilarity(candidate);
  if (!normalizedCandidate) return false;
  return recentBodies.some((body) => {
    const normalizedBody = normalizeForSimilarity(body);
    if (!normalizedBody) return false;
    if (normalizedBody === normalizedCandidate) return true;
    const overlap = calcTokenOverlapRatio(normalizedCandidate, normalizedBody);
    return overlap >= 0.68;
  });
}

function extractInningTag(latestPlayText: string): string {
  if (/경기\s*종료|경기종료|game\s*over/i.test(latestPlayText)) return "경기종료";
  const m = latestPlayText.match(/(\d{1,2}회(?:초|말)?)/);
  if (m?.[1]) return m[1];
  return "경기중";
}

function parseInningState(latestPlayText: string): { inning: number | null; half: "초" | "말" | null } {
  const m = latestPlayText.match(/(\d{1,2})회(초|말)/);
  if (!m) return { inning: null, half: null };
  const inning = Number.parseInt(m[1], 10);
  if (!Number.isFinite(inning)) return { inning: null, half: null };
  return { inning, half: m[2] as "초" | "말" };
}

function isWalkOffSituation(input: GenerateScorePushInput): boolean {
  const { inning, half } = parseInningState(input.latestPlayText);
  if (inning == null || half == null) return false;
  return half === "말" && inning >= 9 && input.myScore > input.oppScore;
}

function ensureInningPrefix(text: string, inningTag: string): string {
  const compact = compactText(text);
  if (/^\[[^\]]+\]/.test(compact)) return compact;
  if (compact.includes("[경기종료]")) return compact;
  return `[${inningTag}] ${compact}`;
}

function enforceBaseballConsistency(text: string, input: GenerateScorePushInput): string {
  let normalized = compactText(text);
  if (!isWalkOffSituation(input)) return normalized;

  normalized = normalized
    .replace(/끝내기\s*분위기/g, "끝내기")
    .replace(/분위기만|분위기/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!/(끝내기|승리|게임셋|경기\s*종료|끝났다|끝났다)/.test(normalized)) {
    normalized = `${normalized} 끝내기 끝🔥`;
  }
  return normalized;
}

function extractEventHook(latestPlayText: string): string | null {
  const cleaned = compactText(latestPlayText)
    .replace(/\d{1,2}회(?:초|말)?/g, "")
    .replace(/스코어\s*변동[:：]?\s*/g, "")
    .replace(/[()]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!cleaned) return null;
  if (cleaned.length <= 14) return cleaned;
  return cleaned.slice(0, 14).trim();
}

function buildVariedLeadLine(input: GenerateScorePushInput): string {
  const myTeam = findTeam(input.favoriteTeam).short;
  const oppTeam = findTeam(input.opponentTeam).short;
  const gap = input.myScore - input.oppScore;
  const eventHook = extractEventHook(input.latestPlayText);
  if (eventHook) {
    return `${myTeam} ${input.myScore}:${input.oppScore} ${oppTeam} (${eventHook}) 분위기 우리가 먹음🔥`;
  }
  if (gap >= 3) {
    return `${myTeam} ${input.myScore}:${input.oppScore} ${oppTeam}. 점수 더 벌렸다, 쐐기 각이다🚀`;
  }
  return `${myTeam} ${input.myScore}:${input.oppScore} ${oppTeam}. 한 번 더 찌르면 끝이다🔥`;
}

function ensureCopyVariety(text: string, input: GenerateScorePushInput): string {
  const normalized = compactText(text);
  if (!/상대\s*멘탈\s*흔들린다/.test(normalized)) return normalized;
  return buildVariedLeadLine(input);
}

function enforceScoreGapTone(text: string, input: GenerateScorePushInput): string {
  const normalized = compactText(text);
  const tier = resolveScoreGapTier(input);
  const trailing = input.myScore < input.oppScore;
  if (!trailing) return normalized;

  if (tier === "garbage") {
    // 대참사 구간에서 "아직 안 끝났다" 류를 강제 차단한다.
    if (
      /아직|역전|할 수 있다|끝났다\s*아님|쫓아간다|해보자|집중하자/.test(normalized) ||
      normalized.length > 40
    ) {
      const my = findTeam(input.favoriteTeam).short;
      const opp = findTeam(input.opponentTeam).short;
      const candidates = [
        `${my} ${input.myScore}:${input.oppScore} ${opp}... 하.`,
        `${input.myScore}:${input.oppScore} ㅋㅋ 오늘은 여기까지.`,
        `........ 티비 껐다. 내일 보자.`,
        `오늘 야구 안 합니다. 다들 귀가.`,
      ] as const;
      return candidates[(input.myScore + input.oppScore) % candidates.length];
    }
    return normalized;
  }

  if (tier === "danger") {
    // 3~5점 차에서는 분노/짜증 텐션을 우선한다.
    if (/아직|침착|할 수 있다/.test(normalized)) {
      return normalized
        .replace(/아직/g, "")
        .replace(/침착/g, "")
        .replace(/할 수 있다/g, "빨리 정신 차려야 한다")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
  }
  return normalized;
}

function hashSeed(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function pickBySeed(items: readonly string[], seed: string): string {
  return items[hashSeed(seed) % items.length];
}

function buildCreativeFallback(input: GenerateScorePushInput): string {
  const my = findTeam(input.favoriteTeam).short;
  const opp = findTeam(input.opponentTeam).short;
  const hook = extractEventHook(input.latestPlayText);
  const scoreText = `${my} ${input.myScore}:${input.oppScore} ${opp}`;
  const seed = `${input.favoriteTeam}:${input.myScore}:${input.oppScore}:${input.latestPlayText}`;
  const leading = input.myScore > input.oppScore;
  const trailing = input.myScore < input.oppScore;
  if (leading) {
    return pickBySeed(
      [
        `${scoreText}. 오늘 흐름 완전 우리 쪽이다🔥`,
        `${scoreText}. 쐐기 한 방 더 박자, 지금이다🚀`,
        `${scoreText}${hook ? ` (${hook})` : ""} 분위기 먹었다.`,
      ],
      seed
    );
  }
  if (trailing) {
    return pickBySeed(
      [
        `${scoreText}. 아직 안 끝났다, 바로 뒤집는다.`,
        `${scoreText}${hook ? ` (${hook})` : ""} 다음 이닝에 갚자.`,
        `${scoreText}. 흐름 잠깐 뺏겼다, 지금부터 반격.`,
      ],
      seed
    );
  }
  return pickBySeed(
    [
      `${scoreText}. 균형 맞췄다, 이제 역전각 본다.`,
      `${scoreText}${hook ? ` (${hook})` : ""} 이 판 우리가 가져온다.`,
      `${scoreText}. 동점이다, 여기서 끝장 보자.`,
    ],
    seed
  );
}

function ensureNovelBody(input: GenerateScorePushInput, body: string): string {
  const recentBodies = input.recentBodies ?? [];
  if (recentBodies.length === 0) return body;
  if (!isNearDuplicate(body, recentBodies)) return body;
  const creative = buildCreativeFallback(input);
  return isNearDuplicate(creative, recentBodies) ? `${creative} ⚾️` : creative;
}

function buildSystemPrompt(input: GenerateScorePushInput, recentBodies: string[]): string {
  const favoriteTeam = findTeam(input.favoriteTeam).short;
  const gap = resolveScoreGap(input);
  const tier = resolveScoreGapTier(input);
  const trailing = input.myScore < input.oppScore;
  const avoid =
    recentBodies.length > 0
      ? `\n- 최근 문구와 같은 표현 재사용 금지: ${recentBodies
          .slice(0, 4)
          .map((line) => `"${clipForPush(line)}"`)
          .join(", ")}`
      : "";
  return `너는 ${favoriteTeam} 극성팬이다.
- 한 줄만 출력
- 24~48자
- 푸시 본문만 출력(설명/따옴표 금지)
- 현재 스코어와 이벤트를 반영
- 경기종료는 반드시 [경기종료] 톤으로 마무리
- 스코어 갭(점수 차이) 기반 감정선 강제:
  1) 1~2점 차(close): 간절함/긴장감/초조함
  2) 3~5점 차(danger): 짜증/원망/분노
  3) 6점 차 이상(garbage): 해탈/허탈/자조, 짧고 냉소적으로
- 특히 우리 팀이 크게 지는 garbage 구간에서 "아직 안 끝났다" 금지
- 현재 상태: 점수차=${gap}, tier=${tier}, 우리팀=${trailing ? "지고 있음" : "안 지고 있음"}${avoid}`;
}

function buildUserPrompt(input: GenerateScorePushInput): string {
  const favorite = findTeam(input.favoriteTeam);
  const opponent = findTeam(input.opponentTeam);
  const inningTag = extractInningTag(input.latestPlayText);
  const gap = resolveScoreGap(input);
  const tier = resolveScoreGapTier(input);
  return `현재 스코어: ${favorite.short} ${input.myScore} : ${input.oppScore} ${opponent.short}
점수 차이: ${gap} (${tier})

이닝 태그: [${inningTag}]

발생 이벤트: ${input.latestPlayText}

최근 문구(피해야 함): ${(input.recentBodies ?? []).slice(0, 6).join(" | ") || "없음"}`;
}

function extractAnthropicText(payload: unknown): string | null {
  const root = payload as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text =
    root?.content
      ?.filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text ?? "")
      .join(" ")
      .trim() ?? "";
  return text.length > 0 ? text : null;
}

// ─── Live Event (Strikeout / Pitcher Change) ─────────────────────────────────

type GenerateLiveEventInput = {
  kind: "strikeout" | "pitcherChange";
  myTeamShort: string;
  oppTeamShort: string;
  /** true=내 팀 수비(투구), false=내 팀 공격(타석), null=불명 */
  isPitching: boolean | null;
  inningLabel: string | null;
  recentBodies?: string[];
  fallbackBody: string;
};

function buildLiveEventSystemPrompt(input: GenerateLiveEventInput): string {
  const side =
    input.isPitching === true  ? `${input.myTeamShort}이 수비(투구) 중` :
    input.isPitching === false ? `${input.myTeamShort}이 공격(타석) 중` :
    "공수 불명";

  const kindKo = input.kind === "strikeout" ? "탈삼진" : "투수 교체";
  const avoid =
    (input.recentBodies ?? []).length > 0
      ? `\n- 최근 문구 재사용 금지: ${(input.recentBodies ?? []).slice(0, 4).map((l) => `"${l.slice(0, 30)}"`).join(", ")}`
      : "";

  return `너는 ${input.myTeamShort} 극성팬이다.
- 지금 경기 중 '${kindKo}' 이벤트가 발생했다.
- 현재 상황: ${side}
- 내 팀 관점에서 한 줄 리액션을 써라.
- 규칙:
  • 한 줄, 20~40자
  • 푸시 본문만 출력(따옴표/설명 금지)
  • 수비 중 탈삼진 → 투수 응원, 흥분, 자신감 폭발
  • 공격 중 삼진 아웃 → 아쉬움, 짜증, 다음 타자 기대
  • 내 팀 투수 교체 → 위기감, 제발 막아라 간절함
  • 상대 투수 교체 → 기대감, 지금이 찬스다 텐션
  • 이닝 레이블은 절대 다시 쓰지 마(이미 앞에 붙음)${avoid}`;
}

function buildLiveEventUserPrompt(input: GenerateLiveEventInput): string {
  const kindKo = input.kind === "strikeout" ? "탈삼진" : "투수 교체";
  const inning = input.inningLabel ?? "경기 중";
  return `이닝: ${inning}
이벤트: ${kindKo}
팀: ${input.myTeamShort} vs ${input.oppTeamShort}
상황: ${input.isPitching === true ? "내 팀 수비 중" : input.isPitching === false ? "내 팀 공격 중" : "공수 불명"}`;
}

export async function generateLiveEventCopy(
  input: GenerateLiveEventInput
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return input.fallbackBody;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2400);
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
        max_tokens: 64,
        temperature: 0.95,
        system: buildLiveEventSystemPrompt(input),
        messages: [{ role: "user", content: buildLiveEventUserPrompt(input) }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return input.fallbackBody;
    const json = await res.json();
    const text = extractAnthropicText(json);
    return text ? compactText(text).slice(0, 60) : input.fallbackBody;
  } catch {
    return input.fallbackBody;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Score Push ───────────────────────────────────────────────────────────────

export async function generateScorePushCopy(input: GenerateScorePushInput): Promise<{ title: string; body: string }> {
  return generateScorePushCopyWithOptions(input, {});
}

export async function generateScorePushCopyWithOptions(
  input: GenerateScorePushInput,
  options: GenerateScorePushOptions
): Promise<{ title: string; body: string }> {
  const apiKey = options.apiKeyOverride?.trim() || process.env.ANTHROPIC_API_KEY;
  const inningTag = extractInningTag(input.latestPlayText);
  const normalizeAndFinalize = (rawBody: string): string => {
    const variety = ensureCopyVariety(rawBody, input);
    const gapAware = enforceScoreGapTone(variety, input);
    const consistent = enforceBaseballConsistency(gapAware, input);
    const inningPrefixed = ensureInningPrefix(consistent, inningTag);
    return clipForPush(ensureNovelBody(input, inningPrefixed));
  };
  if (!apiKey) {
    return {
      title: input.fallbackTitle,
      body: normalizeAndFinalize(input.fallbackBody),
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2600);
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
        max_tokens: options.maxTokens ?? 72,
        temperature: options.temperature ?? 0.96,
        system: buildSystemPrompt(input, input.recentBodies ?? []),
        messages: [
          {
            role: "user",
            content: buildUserPrompt(input),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const rawError = await res.text().catch(() => "");
      console.error("[Claude API Fail]: ", {
        status: res.status,
        body: rawError.slice(0, 200),
      });
      return {
        title: input.fallbackTitle,
        body: normalizeAndFinalize(input.fallbackBody),
      };
    }
    const json = await res.json();
    const generated = extractAnthropicText(json);
    if (!generated) {
      return {
        title: input.fallbackTitle,
        body: normalizeAndFinalize(input.fallbackBody),
      };
    }
    const team = findTeam(input.favoriteTeam);
    return {
      title: `⚾️ ${team.short} 실시간`,
      body: normalizeAndFinalize(generated),
    };
  } catch (error) {
    console.error("[Claude API Fail]: ", error);
    return {
      title: input.fallbackTitle,
      body: normalizeAndFinalize(input.fallbackBody),
    };
  } finally {
    clearTimeout(timeout);
  }
}
