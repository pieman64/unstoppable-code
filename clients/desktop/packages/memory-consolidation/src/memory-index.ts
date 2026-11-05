import {
  clipAtBoundaries,
  countMemoryLines,
  type BoundaryClip,
} from './boundary-truncation';
import { MEMORY_INDEX_MAX_BYTES, MEMORY_INDEX_MAX_LINES } from './limits';
import { utf8ByteLength } from './text';

export function isMemoryIndexWithinLimits(value: string): boolean {
  return (
    countMemoryLines(value) <= MEMORY_INDEX_MAX_LINES &&
    utf8ByteLength(value) <= MEMORY_INDEX_MAX_BYTES
  );
}

/**
 * An index fitted to its line and byte limits, and whether those limits cut
 * it, so recall can say more is saved even when the clipped text is small.
 */
export function fitMemoryIndex(content: string): BoundaryClip {
  return clipAtBoundaries(content, {
    maxLines: MEMORY_INDEX_MAX_LINES,
    maxBytes: MEMORY_INDEX_MAX_BYTES,
  });
}

/** Fits an index to its line and byte limits, cutting only at boundaries. */
export function clipMemoryIndex(content: string): string {
  return fitMemoryIndex(content).text;
}

export function indexSizeLabel(memoryMd: string): string {
  return `${countMemoryLines(memoryMd)} lines and ${utf8ByteLength(memoryMd)} UTF-8 bytes`;
}
