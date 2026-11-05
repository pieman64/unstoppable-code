import { isRecord } from '../w5/commit-log/is-record';
import { isMissingDocumentError, type PreferencesDocument } from './document';
import type { LastGoodRefresher } from './last-good-refresh';
import {
  PreferencesGenerationUnknownError,
  PreferencesGenerationExhaustedError,
} from './errors';

export type PreferencesGenerationRead =
  | { status: 'ok'; generation: number }
  | { status: 'absent' }
  | { status: 'unreadable' };

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 0 without a `generation` (before CAN-5154). Null when one is present but
 * invalid or unsafe: it may hide a newer generation, so it never counts as 0.
 */
export function documentGeneration(
  parsed: Record<string, unknown>,
): number | null {
  if (parsed.generation === undefined) return 0;
  return isGeneration(parsed.generation) ? parsed.generation : null;
}

/** Only `ENOENT` is absent: any other failure may hide a newer generation. */
export async function readPreferencesGeneration(
  document: PreferencesDocument,
): Promise<PreferencesGenerationRead> {
  let raw: string;
  try {
    raw = await document.readText('generation');
  } catch (error) {
    return isMissingDocumentError(error)
      ? { status: 'absent' }
      : { status: 'unreadable' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      isGeneration(parsed.generation)
    )
      return { status: 'ok', generation: parsed.generation };
  } catch {
    // A torn record proves nothing about last-good.
  }
  return { status: 'unreadable' };
}

/**
 * Records `generation` durably before main is replaced. Main never holds a
 * generation the record lacks, so a last-good behind the record is stale.
 */
export async function writePreferencesGeneration(
  document: PreferencesDocument,
  generation: number,
): Promise<void> {
  await document.install(
    'generation',
    JSON.stringify({ version: 1, generation }),
  );
}

/**
 * The floor last-good sets for a save: its generation, or 0 when it is
 * missing or is not a JSON object (no reader can restore those bytes, and
 * only a later write replaces them). Null, refusing the save, when a read
 * fails other than `ENOENT` or its generation is invalid: either may hide a
 * newer generation.
 */
async function readLastGoodFloor(
  document: PreferencesDocument,
  refresher: LastGoodRefresher,
): Promise<number | null> {
  await refresher.wait(document);
  let raw: string;
  try {
    raw = await document.readText('lastGood');
  } catch (error) {
    return isMissingDocumentError(error) ? 0 : null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  return isRecord(parsed) ? documentGeneration(parsed) : 0;
}

/**
 * Above main's and the record's: after a downgrade, main may lag the record.
 * Without a readable record, last-good may be ahead of main too, and a record
 * below it would make it look current. A generation that cannot be known
 * refuses the save.
 */
export async function nextPreferencesGeneration(
  document: PreferencesDocument,
  refresher: LastGoodRefresher,
  mainGeneration: number | null,
): Promise<number> {
  if (mainGeneration === null) throw new PreferencesGenerationUnknownError();
  const recorded = await readPreferencesGeneration(document);
  const floor =
    recorded.status === 'ok'
      ? recorded.generation
      : await readLastGoodFloor(document, refresher);
  if (floor === null) throw new PreferencesGenerationUnknownError();
  const next = Math.max(mainGeneration, floor) + 1;
  // Reads reject an unsafe generation, so writing one would lose the record.
  if (!Number.isSafeInteger(next))
    throw new PreferencesGenerationExhaustedError();
  return next;
}
