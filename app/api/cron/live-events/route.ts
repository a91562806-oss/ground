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
        // ★ 핵심 수정: 전체 히스토리 대신 최근 5개 엔트리만 검사
        // 크론이 5분마다 돌므로 최근 5개면 충분히 커버됨
        const recentEntries = entries.slice(-5);
        const recentText = recentEntries.map((e) => e.text ?? "").join(" ");

        const eventKinds: Array<"pitcherChange" | "strikeout"> = [];
        if (/투수\s*교체|투수교체/.test(recentText)) eventKinds.push("pitcherChange");
        if (/삼진|탈삼진/.test(recentText)) eventKinds.push("strikeout");
        if (eventKinds.length === 0) return null;

        // 이벤트 키: 마지막 엔트리의 seqNo + 텍스트 앞 60자 (중복 방지)
        const lastEntry = recentEntries[recentEntries.length - 1];
        const seqId = lastEntry.seqNo != null ? String(lastEntry.seqNo) : recentText.slice(0, 60);
        const eventKey = `seq:${seqId}`;

        // 이닝 초/말은 최신 엔트리 기준
        const battingSide = resolveInningSideFromEntries(recentEntries, json);

        return { eventKinds, battingSide, eventKey };
      }

      // entries 배열 추출 실패 시 — 전체 JSON fallback (legacy)
      // 이 경우 dedup key를 충분히 촘촘하게 잡아 과거 중복 방지
      const fullText = JSON.stringify(json);
      const eventKinds: Array<"pitcherChange" | "strikeout"> = [];

      // 최근 중계 텍스트만 추출 시도 (last 200 chars of json may include recent text)
      // 이 경로에선 false positive 가능성이 있으므로 이벤트 감지를 건너뜀
      if (eventKinds.length === 0) {
        // entries 파싱 실패 + 배열 없음 = 이 endpoint는 포기
        continue;
      }

      const battingSide = resolveInningSide(json);
      return { eventKinds, battingSide, eventKey: fullText.slice(0, 160) };
    } catch {
      // ignore, try next endpoint
    }
  }
  return null;
}

/**
 * 최신 릴레이 엔트리 배열과 루트 JSON 에서 이닝 초/말을 추출.
 */
function resolveInningSideFromEntries(
  recentEntries: RelayEntry[],
  rootJson: Record<string, unknown>,
): "home" | "away" | null {
  // 1) 최신 엔트리의 inningSub 우선
  for (const entry of [...recentEntries].reverse()) {
    if (entry.inningSub === "1" || entry.inningSub === 1) return "away";
    if (entry.inningSub === "2" || entry.inningSub === 2) return "home";
  }
  // 2) 루트 JSON fallback
  return resolveInningSide(rootJson);
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
 *
 * @param kind       이벤트 종류
 * @param myTeamShort   수신자 응원팀 약칭
 * @param oppTeamShort  상대팀 약칭
 * @param isPitching    수신자 팀이 현재 수비(투구) 중이면 true
 */
function buildLiveEventCopy(
  kind: "pitcherChange" | "strikeout",
  myTeamShort: string,
  oppTeamShort: string,
  isPitching: boolean | null,
): { title: string; body: string } {
  if (kind === "strikeout") {
    if (isPitching === true) {
      // 내 팀 투수가 삼진 잡음 🎉
      return {
        title: "⚡ 탈삼진!",
        body: `${myTeamShort} 투수 방금 삼진 잡았다! 이 기세 그대로 가자.`,
      };
    }
    if (isPitching === false) {
      // 내 팀 타자가 삼진 당함 😤
      return {
        title: "⚡ 삼진 아웃",
        body: `${myTeamShort} 타자 삼진 아웃... 다음 타자가 살려줘.`,
      };
    }
    // 공수 불명 — 중립
    return {
      title: "⚡ 라이브 경기 상황",
      body: `${myTeamShort}-${oppTeamShort}전, 방금 탈삼진 발생.`,
    };
  }

  // pitcherChange
  if (isPitching === true) {
    // 내 팀이 투수 교체 단행
    return {
      title: "🎯 투수 교체",
      body: `${myTeamShort} 투수 교체. 이 위기 막아야 한다.`,
    };
  }
  if (isPitching === false) {
    // 상대 팀이 투수 교체
    return {
      title: "🎯 상대 투수 교체",
      body: `상대가 투수 교체했다. ${myTeamShort}, 지금이 찬스다!`,
    };
  }
  return {
    title: "🎯 라이브 경기 상황",
    body: `${myTeamShort}-${oppTeamShort}전, 투수 교체 발생.`,
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
