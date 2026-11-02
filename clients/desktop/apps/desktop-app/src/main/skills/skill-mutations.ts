/**
 * Serialize application-managed custom edits, scoped imports and package writes.
 * Synchronous uninstall/raw writers refuse while asynchronous work is pending.
 * This protects application writers, not arbitrary external filesystem editors.
 */
let pending = 0;
let tail = Promise.resolve();

export function skillMutationPending(): boolean {
  return pending > 0;
}

export async function runSkillMutation<T>(work: () => Promise<T>): Promise<T> {
  pending += 1;
  const previous = tail;
  let release = (): void => {};
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    pending -= 1;
    release();
  }
}
