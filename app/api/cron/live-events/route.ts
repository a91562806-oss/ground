import { NextResponse } from "next/server";
import { fetchKboSchedule, todayKstDate } from "@/lib/kbo";
import { findTeam } from "@/lib/teams";
import { shouldSkipCronInAlpha } from "@/lib/appEnv";
import { authorizeCron, markDispatchOnce, sendTeamTopicNotification } from "@/services/notificationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const NAVER_BASE = "https://api-gw.sports.naver.com";

/**
 * 이닝 초/말 + 감지된 이벤트 정보.
 * inningSub: "1" = 초(top) = 원정팀 공격 / 홈팀 수비
 *            "2" = 말(bottom) = 홈팀 공격 / 원정팀 수비
 *            null = 판별 불가
 */
type RelayInfo = {
  eventKinds: Array<"pitcherChange" | "strikeout">;
  /** 현재 공격 중인 팀 측 ("home" | "away" | null) */
  battingSide: "home" | "away" | null;
  /** 현재 이닝 번호 (null=불명) */
  inning: number | null;
  /** 이닝 초/말 레이블 (예: "7회 초") */
  inningLabel: string | null;
  eventKey: string;
};

type RelayEntry = {
  text: string;
  seqNo?: number | string;
  inning?: number;
  inningSub?: string | number;
};

/**
 * relay JSON 에서 중계 텍스트 배열을 추출.
 * Naver API 응답 구조가 버전마다 다르므로 여러 경로를 시도.
 */
function extractRelayEntries(json: Record<string, unknown>): RelayEntry[] {
  // 가능한 배열 경로들
  const candidates = [
    json["relayTexts"],
    (json["result"] as Record<string, unknown> | undefined)?.["relayTexts"],
    (json["relay"]  as Record<string, unknown> | undefined)?.["relayTexts"],
    (json["result"] as Record<string, unknown> | undefined)
      ?.["relay"] &&
      ((json["result"] as Record<string, unknown>)["relay"] as Record<string, unknown>)?.["relayTexts"],
    json["texts"],
    (json["result"] as Record<string, unknown> | undefined)?.["texts"],
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c as RelayEntry[];
  }
  return [];
}

async function fetchRelayInfo(gameId: string): Promise<RelayInfo | null> {
  const endpoints = [
    `${NAVER_BASE}/schedule/games/${gameId}/relay`,
    `${NAVER_BASE}/schedule/games/${gameId}/relayTexts`,
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        headers: {
          "user-agent": "Mozilla/5.0 GroundBot/1.0",
          accept: "application/json",
          referer: "https://m.sports.naver.com/",
        },
        cache: "no-store",
      });
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, unknown>;

      const entries = extractRelayEntries(json);

      if (entries.length > 0) {
        // ★ 가장 최신 엔트리 1개만 검사 — 과거 히스토리 false positive 완전 차단
        const lastEntry = entries[entries.length - 1];
        const lastText = lastEntry.text ?? "";

        const eventKinds: Array<"pitcherChange" | "strikeout"> = [];
        if (/투수\s*교체|투수교체/.test(lastText)) eventKinds.push("pitcherChange");
        if (/삼진|탈삼진/.test(lastText)) eventKinds.push("strikeout");
        if (eventKinds.length === 0) return null;

        // 이벤트 키: seqNo 기반 (없으면 텍스트 앞 60자)
        const seqId = lastEntry.seqNo != null ? String(lastEntry.seqNo) : lastText.slice(0, 60);
        const eventKey = `seq:${seqId}`;

        // 이닝 정보
        const inning = typeof lastEntry.inning === "number" ? lastEntry.inning : null;
        const inningSub = lastEntry.inningSub ?? null;
        let battingSide: "home" | "away" | null = null;
        if (inningSub === "1" || inningSub === 1) battingSide = "away";
        else if (inningSub === "2" || inningSub === 2) battingSide = "home";
        else battingSide = resolveInningSide(json);

        const halfLabel = battingSide === "away" ? "초" : battingSide === "home" ? "말" : null;
        const inningLabel = inning != null && halfLabel ? `${inning}회 ${halfLabel}` : null;

        return { eventKinds, battingSide, inning, inningLabel, eventKey };
      }

      // entries 배열 파싱 실패 — 이 endpoint 포기, false positive 방지를 위해 skip
      continue;
    } catch {
      // ignore, try next endpoint
    }
  }
  return null;
}

/**
 * Naver relay JSON 에서 현재 공격 중인 팀 측을 추출.
 * inningSub "1"(초) = 원정팀 공격, "2"(말) = 홈팀 공격.
 */
function resolveInningSide(json: Record<string, unknown>): "home" | "away" | null {
  // 가능한 필드 경로들을 순서대로 시도
  const candidates: unknown[] = [
    json["inningSub"],
    (json["result"] as Record<string, unknown> | undefined)?.["inningSub"],
    (json["relay"]  as Record<string, unknown> | undefined)?.["inningSub"],
    (json["result"] as Record<string, unknown> | undefined)
      ?.["relay"] &&
      ((json["result"] as Record<string, unknown>)["relay"] as Record<string, unknown>)?.["inningSub"],
  ];
  for (const val of candidates) {
    if (val === "1" || val === 1) return "away";   // 초 = 원정 공격
    if (val === "2" || val === 2) return "home";   // 말 = 홈 공격
  }
  // 텍스트에서 "초" 또는 "말"로 판단 (last resort)
  const text = JSON.stringify(json);
  const m = text.match(/"inning"\s*:\s*\d+[^}]*"inningSub"\s*:\s*"?(\d+)"?/);
  if (m) {
    if (m[1] === "1") return "away";
    if (m[1] === "2") return "home";
  }
  return null;
}

/**
 * 공수(攻守) 관점에 맞는 알림 문구 생성.
 * 모든 body 앞에 "[X회 초/말]" 이닝 레이블을 포함.
 */
function buildLiveEventCopy(
  kind: "pitcherChange" | "strikeout",
  myTeamShort: string,
  oppTeamShort: string,
  isPitching: boolean | null,
  inningLabel: string | null,
): { title: string; body: string } {
  const inning = inningLabel ? `[${inningLabel}] ` : "";

  if (kind === "strikeout") {
    if (isPitching === true) {
      return {
        title: "⚡ 탈삼진!",
        body: `${inning}${myTeamShort} 투수 방금 삼진 잡았다! 이 기세 그대로 가자.`,
      };
    }
    if (isPitching === false) {
      return {
        title: "⚡ 삼진 아웃",
        body: `${inning}${myTeamShort} 타자 삼진 아웃... 다음 타자가 살려줘.`,
      };
    }
    return {
      title: "⚡ 라이브 경기 상황",
      body: `${inning}${myTeamShort}-${oppTeamShort}전 탈삼진 발생.`,
    };
  }

  // pitcherChange
  if (isPitching === true) {
    return {
      title: "🎯 투수 교체",
      body: `${inning}${myTeamShort} 투수 교체. 이 위기 막아야 한다.`,
    };
  }
  if (isPitching === false) {
    return {
      title: "🎯 상대 투수 교체",
      body: `${inning}상대가 투수 교체했다. ${myTeamShort}, 지금이 찬스다!`,
    };
  }
  return {
    title: "🎯 라이브 경기 상황",
    body: `${inning}${myTeamShort}-${oppTeamShort}전 투수 교체 발생.`,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const auth = authorizeCron(req, url);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (shouldSkipCronInAlpha(url)) return NextResponse.json({ ok: true, skipped: "ALPHA_ENV_CRON_DISABLED" });

  const date = todayKstDate();
  const schedule = await fetchKboSchedule(date);
  const liveGames = schedule.today.filter((game) => game.status === "LIVE");
  let sent = 0;
  let skipped = 0;

  for (const game of liveGames) {
    const relay = await fetchRelayInfo(game.id);
    if (!relay || relay.eventKinds.length === 0) continue;

    for (const kind of relay.eventKinds) {
      for (const teamId of [game.homeId, game.awayId]) {
        const lock = await markDispatchOnce({
          alertKind: "live-event",
          teamScope: teamId,
          eventKey: `${game.id}:${kind}:${relay.eventKey}`,
          gameExternalId: game.id,
        });
        if (!lock) {
          skipped += 1;
          continue;
        }

        const opponentTeamId = teamId === game.homeId ? game.awayId : game.homeId;
        const teamSide: "home" | "away" = teamId === game.homeId ? "home" : "away";

        // isPitching: 현재 수비 중인 팀인지 판단
        // battingSide = 공격 중인 쪽 → 반대 쪽이 수비(투구)
        let isPitching: boolean | null = null;
        if (relay.battingSide !== null) {
          // 내 팀이 공격 중이면 isPitching=false, 수비 중이면 isPitching=true
          isPitching = relay.battingSide !== teamSide;
        }

        const copy = buildLiveEventCopy(
          kind,
          findTeam(teamId).short,
          findTeam(opponentTeamId).short,
          isPitching,
          relay.inningLabel,
        );

        const result = await sendTeamTopicNotification({
          teamId,
          topicKey: kind === "pitcherChange" ? "livePitcherChange" : "liveStrikeout",
          title: copy.title,
          body: copy.body,
          url: "/today",
          payload: {
            kind: "live-event",
            eventKind: kind,
            gameId: game.id,
            teamId,
            opponentTeamId,
            battingSide: relay.battingSide,
            isPitching,
          },
          type: "SYSTEM",
          origin: url.origin,
        });
        sent += result.sent;
      }
    }
  }
  return NextResponse.json({ ok: true, date, sent, skipped, liveGames: liveGames.length });
}
