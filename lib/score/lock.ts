import { prisma } from "@/lib/prisma";

/**
 * `check-score` cron 의 PostgreSQL advisory 락.
 * 외부 스케줄러가 1분마다 여러 번 호출해도 동시에 하나만 통과시키기 위함.
 */
const CHECK_SCORE_LOCK_KEY = 2026051901;

export async function tryAcquireCheckScoreLock(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ locked: boolean }>>(
      `SELECT pg_try_advisory_lock(${CHECK_SCORE_LOCK_KEY}) AS locked`
    );
    return Boolean(rows?.[0]?.locked);
  } catch (error) {
    console.error("[check-score] failed to acquire advisory lock", error);
    return false;
  }
}

export async function releaseCheckScoreLock(): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `SELECT pg_advisory_unlock(${CHECK_SCORE_LOCK_KEY})`
    );
  } catch (error) {
    console.error("[check-score] failed to release advisory lock", error);
  }
}
