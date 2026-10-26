// Spreads matches across companies: every company's best job comes before any company's second best,
// so one big board can't fill the whole top of the list. Within a round, higher scores come first.
export function spreadByCompany<T extends { company: string; score: number }>(jobs: T[]): T[] {
  const seen = new Map<string, number>();
  const ranked = [...jobs]
    .sort((a, b) => b.score - a.score)
    .map((job, index) => {
      const key = job.company.trim().toLowerCase();
      const round = seen.get(key) ?? 0;
      seen.set(key, round + 1);
      return { job, round, index };
    });
  return ranked.sort((a, b) => a.round - b.round || a.index - b.index).map((item) => item.job);
}
