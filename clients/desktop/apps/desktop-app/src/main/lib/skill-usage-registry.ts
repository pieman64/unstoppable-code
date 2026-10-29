import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  isShareTargetKey,
  isSkillShareNudgeResolution,
  SKILL_SHARE_NUDGE_USE_THRESHOLD,
  type SkillShareNudgeResolution,
} from '@canopy/desktop-shared/lib/skill-share-nudge';
import { getSkillUsageFilePath } from './paths';
import { writeFileAtomically } from './atomic-file';

export interface SkillUsageItem {
  count: number;
  nudge?: SkillShareNudgeResolution;
  resolvedAt?: string;
}
export interface SkillUsageFile {
  version: 1;
  items: Record<string, SkillUsageItem>;
}
function empty(): SkillUsageFile {
  return { version: 1, items: {} };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function readFileState(): Promise<SkillUsageFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(getSkillUsageFilePath(), 'utf8'));
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (isRecord(error) && error.code === 'ENOENT')
    )
      return empty();
    throw error;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.items))
    return empty();
  const result = empty();
  for (const [key, item] of Object.entries(parsed.items)) {
    if (
      !isShareTargetKey(key) ||
      !isRecord(item) ||
      typeof item.count !== 'number' ||
      !Number.isSafeInteger(item.count) ||
      item.count < 0 ||
      (item.nudge !== undefined && !isSkillShareNudgeResolution(item.nudge)) ||
      (item.resolvedAt !== undefined &&
        (typeof item.resolvedAt !== 'string' ||
          !Number.isFinite(Date.parse(item.resolvedAt))))
    )
      continue;
    result.items[key] = {
      count: item.count,
      ...(isSkillShareNudgeResolution(item.nudge) ? { nudge: item.nudge } : {}),
      ...(typeof item.resolvedAt === 'string'
        ? { resolvedAt: item.resolvedAt }
        : {}),
    };
  }
  return result;
}
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const pending = chain.then(operation, operation);
  chain = pending.catch(() => undefined);
  return pending;
}
async function write(state: SkillUsageFile): Promise<void> {
  const path = getSkillUsageFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomically(path, JSON.stringify(state, null, 2), {
    encoding: 'utf8',
  });
}
/** Machine-local main-owned state. Lost/corrupt state can cause suggestions to recur. */
export function readSkillUsage(): Promise<SkillUsageFile> {
  return serialize(readFileState);
}
export function recordSkillUse(
  targetKey: string,
): Promise<{ shouldEvaluateNudge: boolean }> {
  return serialize(async () => {
    if (!isShareTargetKey(targetKey))
      throw new Error('Invalid skill usage identity');
    const state = await readFileState();
    const item = state.items[targetKey] ?? { count: 0 };
    if (item.nudge) return { shouldEvaluateNudge: false };
    item.count = Math.min(Number.MAX_SAFE_INTEGER, item.count + 1);
    state.items[targetKey] = item;
    await write(state);
    return {
      shouldEvaluateNudge: item.count >= SKILL_SHARE_NUDGE_USE_THRESHOLD,
    };
  });
}
export function resolveSkillShareNudge(
  targetKey: string,
  resolution: SkillShareNudgeResolution,
): Promise<void> {
  return serialize(async () => {
    if (
      !isShareTargetKey(targetKey) ||
      !isSkillShareNudgeResolution(resolution)
    )
      throw new Error('Invalid skill usage resolution');
    const state = await readFileState();
    const item = state.items[targetKey] ?? { count: 0 };
    if (
      item.nudge &&
      !(
        item.nudge === 'shown' &&
        (resolution === 'dismissed' || resolution === 'shared')
      )
    )
      return;
    item.nudge = resolution;
    item.resolvedAt = new Date().toISOString();
    state.items[targetKey] = item;
    await write(state);
  });
}
