import { randomBytes } from 'node:crypto';
import { DiscoveryError } from '../errors';

export const READ_CURSOR_TTL_MS = 15 * 60 * 1000;
const MAX_HANDLES = 128;

/** Offset is measured newest-first within the raw page at `before`. */
export interface ReadLocator {
  before?: number;
  offset: number;
}
export interface ReadCursor {
  binding: string;
  transcriptRevision: number;
  locator: ReadLocator;
  expiresAt: number;
}

/** Replay-safe locator handles; never retains transcript text or all-row IDs. */
export class ReadCursorStore {
  private readonly handles = new Map<string, ReadCursor>();

  get(handle: string, binding?: string): ReadCursor {
    const entry = this.handles.get(handle);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.handles.delete(handle);
      throw new DiscoveryError(
        'cursor_expired',
        'This history cursor has expired. Restart the read.',
      );
    }
    if (binding !== undefined && binding !== entry.binding) {
      throw new DiscoveryError(
        'cursor_context_changed',
        'This history context changed. Restart the read.',
      );
    }
    this.handles.delete(handle);
    this.handles.set(handle, entry);
    return { ...entry, locator: { ...entry.locator } };
  }

  put(
    binding: string,
    transcriptRevision: number,
    locator: ReadLocator,
  ): string {
    const now = Date.now();
    this.handles.forEach((entry, handle) => {
      if (entry.expiresAt <= now) this.handles.delete(handle);
    });
    const handle = randomBytes(32).toString('hex');
    this.handles.set(handle, {
      binding,
      transcriptRevision,
      locator: { ...locator },
      expiresAt: now + READ_CURSOR_TTL_MS,
    });
    while (this.handles.size > MAX_HANDLES) {
      const oldest = this.handles.keys().next().value;
      if (oldest === undefined) break;
      this.handles.delete(oldest);
    }
    return handle;
  }
}
