/**
 * 가벼운 동시성 제한 헬퍼. 모든 cron / 서비스 모듈이 공유한다.
 *
 * - `concurrency` 만큼의 워커를 띄우고 큐에서 작업을 꺼내 처리한다.
 * - `Promise.all` 의 결과 순서를 유지하며 안전하게 동작.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) break;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}
