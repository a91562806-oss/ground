export type PushPulseState = "lead" | "trail" | "tie" | "comeback";
export type ScoreTone = "for" | "against";

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function computePulseState(
  previousMyScore: number | null,
  previousOppScore: number | null,
  myScore: number,
  oppScore: number
): PushPulseState {
  if (
    previousMyScore != null &&
    previousOppScore != null &&
    previousMyScore < previousOppScore &&
    myScore > oppScore
  ) {
    return "comeback";
  }
  if (myScore > oppScore) return "lead";
  if (myScore < oppScore) return "trail";
  return "tie";
}

export function buildBiasedScoreCopy(input: {
  teamShort: string;
  oppShort: string;
  myScore: number;
  oppScore: number;
  tone: ScoreTone;
  state: PushPulseState;
}): { title: string; body: string } {
  const { teamShort, oppShort, myScore, oppScore, tone, state } = input;
  const scoreText = `${teamShort} ${myScore}:${oppScore} ${oppShort}`;

  if (tone === "for") {
    const title = pickRandom([
      `🔥 ${teamShort} 득점`,
      `🚨 ${teamShort} 점수 뽑았다`,
      `💥 ${teamShort} 한 방 터졌다`,
    ]);
    const byState: Record<PushPulseState, string[]> = {
      lead: [
        `미쳤다 ㅋㅋ ${scoreText}. 이대로 박살내자.`,
        `${scoreText} 리드 지켰다. 지금부터 쐐기 박자.`,
        `${scoreText} 분위기 넘어왔다. 한 점 더 달아나자.`,
      ],
      trail: [
        `${scoreText}! 한 점 따라붙었다, 분위기 바뀐다.`,
        `좋아 시작이다. ${scoreText}, 이제 진짜 추격 간다.`,
      ],
      tie: [
        `동점 만들었다! ${scoreText}. 지금부터가 진짜다.`,
        `${scoreText} 균형 맞췄다. 흐름 완전 우리 쪽.`,
      ],
      comeback: [
        `[긴급] 미쳤다!!! ${teamShort} 역전! ${scoreText}`,
        `역전 성공 ㅋㅋ ${scoreText}. 이대로 끝내자.`,
      ],
    };
    return { title, body: pickRandom(byState[state]) };
  }

  const title = pickRandom([
    `🚨 ${teamShort} 실점`,
    `⚠️ ${teamShort} 위기`,
    `아... ${teamShort} 실점`,
  ]);
  const byState: Record<PushPulseState, string[]> = {
    lead: [
      `${scoreText}. 아직 리드다, 정신줄 꽉 잡자.`,
      `실점했지만 ${scoreText}. 바로 다시 벌리자.`,
    ],
    trail: [
      `아 ㅅㅂ ${scoreText}... 그래도 아직 안 끝났다.`,
      `${scoreText}. 빡치지만 바로 되갚자.`,
    ],
    tie: [
      `${scoreText} 다시 원점. 지금부터 다시 찍어누르자.`,
      `동점 허용 ${scoreText}... 다시 리드 가져오자.`,
    ],
    comeback: [
      `${scoreText}. 역전은 했는데 더 벌려야 산다.`,
      `역전 직후 실점... ${scoreText}. 멘탈 잡고 다시 간다.`,
    ],
  };
  return { title, body: pickRandom(byState[state]) };
}

export function buildBiasedLineupCopy(input: {
  teamShort: string;
  starter: string;
  state: PushPulseState;
}): { title: string; body: string } {
  const { teamShort, starter, state } = input;
  const title = pickRandom([
    `${teamShort} 오늘 선발 라인업 확정! ⚾️`,
    `🚨 ${teamShort} 라인업 떴다`,
    `🔥 ${teamShort} 선발 공개`,
  ]);
  const byState: Record<PushPulseState, string[]> = {
    lead: [
      `오늘 선발투수는 ${starter}. 기세 이어서 끝까지 밀어붙이자.`,
      `${starter} 출격. 지금 분위기면 그냥 찢는다.`,
    ],
    trail: [
      `오늘 선발투수는 ${starter}. 지금부터 반격 시나리오 쓴다.`,
      `${starter} 나온다. 오늘 판 뒤집자.`,
    ],
    tie: [
      `오늘 선발투수는 ${starter}. 라인업 보러 가자 🔥`,
      `${starter} 확정. 편파 중계 시작한다.`,
    ],
    comeback: [
      `${starter} 출격. 역전각 제대로 잡혔다.`,
      `오늘은 ${starter}. 역전 드라마 찍으러 간다.`,
    ],
  };
  return { title, body: pickRandom(byState[state]) };
}
