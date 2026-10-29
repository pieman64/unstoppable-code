export interface DagTierJob {
  readonly needs: readonly string[];
}

export function computeDagTiers(jobs: Record<string, DagTierJob>): string[][] {
  const jobIds = Object.keys(jobs);
  if (jobIds.length === 0) return [];

  const jobLevelMap = new Map<string, number>();

  function getLevel(jobId: string, visiting: Set<string>): number {
    const cached = jobLevelMap.get(jobId);
    if (cached !== undefined) return cached;
    if (visiting.has(jobId)) {
      jobLevelMap.set(jobId, 0);
      return 0;
    }
    const job = jobs[jobId];
    if (!job || job.needs.length === 0) {
      jobLevelMap.set(jobId, 0);
      return 0;
    }
    visiting.add(jobId);
    let maxDep = 0;
    for (const dep of job.needs) {
      maxDep = Math.max(maxDep, getLevel(dep, visiting) + 1);
    }
    jobLevelMap.set(jobId, maxDep);
    return maxDep;
  }

  for (const jid of jobIds) {
    getLevel(jid, new Set<string>());
  }

  const levels: string[][] = [];
  jobLevelMap.forEach((lvl, jid) => {
    while (levels.length <= lvl) levels.push([]);
    levels[lvl].push(jid);
  });

  return levels;
}
