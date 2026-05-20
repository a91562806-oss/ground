/**
 * KST 기준 경기 시간대 가드.
 * 주중(월~금): 18:00 ~ 22:30
 * 주말(토~일): 14:00 ~ 21:00
 *
 * 경기 시간 외에는 live-events / check-score 크론을 즉시 스킵시켜
 * 불필요한 API 호출과 Claude 비용을 차단.
 */

export function isKboGameHour(now?: Date): boolean {
  const kst = toKst(now ?? new Date());
  const day  = kst.getDay();   // 0=일, 1=월 ... 6=토
  const hour = kst.getHours();
  const min  = kst.getMinutes();
  const totalMin = hour * 60 + min;

  const isWeekend = day === 0 || day === 6;
  const isMonday  = day === 1;

  // 월요일은 KBO 정기 휴식일
  if (isMonday) return false;

  if (isWeekend) {
    // 14:00 ~ 21:00
    return totalMin >= 14 * 60 && totalMin < 21 * 60;
  } else {
    // 주중: 18:00 ~ 22:30
    return totalMin >= 18 * 60 && totalMin < 22 * 60 + 30;
  }
}

function toKst(date: Date): Date {
  // KST = UTC+9
  return new Date(date.getTime() + 9 * 60 * 60 * 1000);
}
