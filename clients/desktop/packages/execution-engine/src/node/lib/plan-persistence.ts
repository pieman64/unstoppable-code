import { randomUUID } from 'node:crypto';

export interface TrackedPlanRecord {
  id: string;
}

export async function createTrackedPlan(
  options?: unknown,
): Promise<TrackedPlanRecord> {
  void options;
  await Promise.resolve();
  return { id: randomUUID() };
}

export async function updateTrackedPlan(options?: unknown): Promise<void> {
  void options;
  await Promise.resolve();
}
