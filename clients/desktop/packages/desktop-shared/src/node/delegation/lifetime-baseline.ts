import { z } from 'zod';
import {
  PrivateDelegationRecordFile,
  type FileDelegationStorage,
  type PrivateDelegationCommitOutcome,
} from './storage';

export const DELEGATION_LIFETIME_BASELINE_FILE_NAME: string =
  'lifetime-baseline.json';

const lifetimeBaselineDto = z.strictObject({
  version: z.literal(1),
  baseline: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function parseLifetimeBaseline(text: string): number {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid private delegation lifetime baseline');
  }
  return lifetimeBaselineDto.parse(value).baseline;
}

/** Dormant observation never prepares storage or reconciles an uncertain commit. */
export async function readDelegationLifetimeBaselineReadOnly(
  storage: FileDelegationStorage,
): Promise<
  | { readonly kind: 'available'; readonly baseline: number }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'unreadable' | 'uncertain';
    }
> {
  try {
    if (!(await storage.validateDirectoryReadOnly()))
      return { kind: 'available', baseline: 0 };
    const baseline = await storage.read(
      DELEGATION_LIFETIME_BASELINE_FILE_NAME,
      (text) => parseLifetimeBaseline(text),
    );
    return { kind: 'available', baseline: baseline ?? 0 };
  } catch (error) {
    if (isMissingFile(error)) return { kind: 'available', baseline: 0 };
    return { kind: 'unavailable', reason: 'unreadable' };
  }
}

/** A missing baseline starts at zero; existing files must be strict DTOs. */
export async function readDelegationLifetimeBaseline(
  storage: FileDelegationStorage,
): Promise<number> {
  await storage.prepareDirectory();
  try {
    const baseline = await storage.read(
      DELEGATION_LIFETIME_BASELINE_FILE_NAME,
      (text) => parseLifetimeBaseline(text),
    );
    return baseline ?? 0;
  } catch (error) {
    if (isMissingFile(error)) return 0;
    throw error;
  }
}

/** Persist the lifetime count using the same private atomic file path as runs. */
export async function writeDelegationLifetimeBaseline(
  storage: FileDelegationStorage,
  baseline: number,
): Promise<PrivateDelegationCommitOutcome> {
  const value = lifetimeBaselineDto.parse({ version: 1, baseline });
  const record = new PrivateDelegationRecordFile(
    DELEGATION_LIFETIME_BASELINE_FILE_NAME,
    Buffer.from(JSON.stringify(value), 'utf8'),
  );
  return storage.commitWithOutcome(record);
}
