import { z } from 'zod';
import { MEMORY_SYNC_LIMITS } from './constants';
import { MemoryChangeSeqSchema, MemoryScopeIdSchema } from './identifiers';

const CURSOR_PREFIX = 'mc1';

/**
 * A position in one scope's change feed. `generation` changes only when the
 * server rebuilds the feed (a purge and re-upload, or a database restore);
 * positions from different generations are not comparable and the replica
 * must take a fresh snapshot.
 */
export interface MemoryChangeCursor {
  scopeId: string;
  generation: number;
  seq: string;
}

export function formatMemoryChangeCursor(cursor: MemoryChangeCursor): string {
  return `${CURSOR_PREFIX}.${cursor.scopeId}.${cursor.generation}.${cursor.seq}`;
}

export function parseMemoryChangeCursor(
  value: string,
): MemoryChangeCursor | null {
  if (value.length > MEMORY_SYNC_LIMITS.cursorMaxLength) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== CURSOR_PREFIX) return null;
  const [, scopeId = '', generationText = '', seq = ''] = parts;
  if (!/^[1-9][0-9]{0,8}$/.test(generationText)) return null;
  if (
    !MemoryScopeIdSchema.safeParse(scopeId).success ||
    !MemoryChangeSeqSchema.safeParse(seq).success
  ) {
    return null;
  }
  return { scopeId, generation: Number(generationText), seq };
}

export const MemoryChangeCursorSchema = z
  .string()
  .refine(
    (value: string): boolean => parseMemoryChangeCursor(value) !== null,
    'Expected a memory change cursor',
  );

export function initialMemoryChangeCursor(
  scopeId: string,
  generation: number,
): string {
  return formatMemoryChangeCursor({ scopeId, generation, seq: '0' });
}

/** Orders two canonical decimal sequences without converting to numbers. */
export function compareMemoryChangeSeq(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Null when the cursors are from different scopes or feed generations. */
export function compareMemoryChangeCursors(
  left: string,
  right: string,
): number | null {
  const a = parseMemoryChangeCursor(left);
  const b = parseMemoryChangeCursor(right);
  if (
    a === null ||
    b === null ||
    a.scopeId !== b.scopeId ||
    a.generation !== b.generation
  ) {
    return null;
  }
  return compareMemoryChangeSeq(a.seq, b.seq);
}
