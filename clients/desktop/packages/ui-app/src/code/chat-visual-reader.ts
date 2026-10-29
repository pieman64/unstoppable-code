import type { PersistedVisualReference } from '@canopy/agent-transcript/types';
import type { ChatVisualOwner } from './chat-visual-host';

export const VISUAL_RANGE_LIMIT = 1024 * 1024;
export const VISUAL_CACHE_BYTE_BUDGET = 16 * 1024 * 1024;

export interface VisualRangeResponse {
  bytes: Uint8Array;
  offset: number;
  length: number;
  byteLength: number;
  sha256: string;
}

export type VisualRangeReader = (
  offset: number,
  limit: number,
  signal: AbortSignal,
) => Promise<VisualRangeResponse>;

/** The range reader is transport-neutral; every returned slice must match the reference. */
export async function readVisualRanges(
  readRange: VisualRangeReader,
  reference: PersistedVisualReference,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const total = reference.byteLength;
  if (!Number.isSafeInteger(total) || total < 0)
    throw new Error('Invalid visual length.');
  // Nothing is sized from the reference before the host has accepted it: the
  // host refuses an oversized length on the first read.
  const pages: Uint8Array[] = [];
  for (let offset = 0; offset < total || (total === 0 && offset === 0); ) {
    signal.throwIfAborted();
    const limit = Math.max(1, Math.min(VISUAL_RANGE_LIMIT, total - offset));
    const page = await readRange(offset, limit, signal);
    signal.throwIfAborted();
    const expectedLength = Math.min(limit, total - offset);
    if (
      page.offset !== offset ||
      page.byteLength !== total ||
      page.sha256 !== reference.sha256 ||
      page.length !== page.bytes.byteLength ||
      page.length !== expectedLength
    ) {
      throw new Error('Visual content changed while loading.');
    }
    pages.push(page.bytes);
    if (total === 0) break;
    offset += page.length;
  }
  const result = new Uint8Array(total);
  let position = 0;
  for (const page of pages) {
    result.set(page, position);
    position += page.byteLength;
  }
  return result;
}

/** Verify the complete artifact before any untrusted HTML reaches a frame. */
export async function verifyVisualDocument(
  bytes: Uint8Array,
  reference: PersistedVisualReference,
): Promise<string> {
  if (bytes.byteLength !== reference.byteLength)
    throw new Error('Visual length does not match.');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    Uint8Array.from(bytes).buffer,
  );
  const sha = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (sha !== reference.sha256)
    throw new Error('Visual content does not match.');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

interface CachedVisual {
  bytes: Uint8Array;
  document: string;
  authorizedOwners: Set<string>;
}

interface PendingVisual {
  task: Promise<string>;
  controller: AbortController;
  waiters: number;
}

/** The host authorizes the whole reference, so every field is in the key. */
export function chatVisualOwnerKey(owner: ChatVisualOwner): string {
  const { reference } = owner;
  return JSON.stringify([
    owner.messageId,
    owner.toolUseId,
    JSON.stringify(reference, Object.keys(reference).sort()),
  ]);
}

/** Content identity is not authority: an owner absent from an entry must be checked by the host. */
export class ChatVisualDocumentCache {
  private entries = new Map<string, CachedVisual>();
  private pending = new Map<string, PendingVisual>();
  private bytes = 0;
  private authorityIds = new WeakMap<object, number>();
  private nextAuthorityId = 0;

  constructor(private readonly budget = VISUAL_CACHE_BYTE_BUDGET) {}

  get byteLength(): number {
    return this.bytes;
  }

  async load(
    authority: object,
    owner: ChatVisualOwner,
    read: (owner: ChatVisualOwner, signal: AbortSignal) => Promise<Uint8Array>,
    authorize: (owner: ChatVisualOwner, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    let authorityId = this.authorityIds.get(authority);
    if (authorityId === undefined) {
      authorityId = ++this.nextAuthorityId;
      this.authorityIds.set(authority, authorityId);
    }
    const key = `${authorityId}\u0000${chatVisualOwnerKey(owner)}`;
    const digest = owner.reference.sha256;
    const cached = this.entries.get(digest);
    if (cached && cached.bytes.byteLength === owner.reference.byteLength) {
      if (!cached.authorizedOwners.has(key)) {
        await authorize(owner, signal);
        signal.throwIfAborted();
        cached.authorizedOwners.add(key);
      }
      this.entries.delete(digest);
      this.entries.set(digest, cached);
      return cached.document;
    }
    const pendingKey = `${digest}\u0000${key}`;
    let pending = this.pending.get(pendingKey);
    if (!pending) {
      const controller = new AbortController();
      const task = (async (): Promise<string> => {
        const raw = await read(owner, controller.signal);
        controller.signal.throwIfAborted();
        const document = await verifyVisualDocument(raw, owner.reference);
        controller.signal.throwIfAborted();
        if (raw.byteLength <= this.budget) {
          const old = this.entries.get(digest);
          if (old) this.bytes -= old.bytes.byteLength;
          this.entries.delete(digest);
          this.entries.set(digest, {
            bytes: raw,
            document,
            authorizedOwners: new Set([key]),
          });
          this.bytes += raw.byteLength;
          while (this.bytes > this.budget) {
            const eldest = this.entries.keys().next().value;
            if (eldest === undefined) break;
            const evicted = this.entries.get(eldest);
            if (evicted) this.bytes -= evicted.bytes.byteLength;
            this.entries.delete(eldest);
          }
        }
        return document;
      })();
      pending = { task, controller, waiters: 0 };
      this.pending.set(pendingKey, pending);
      void task
        .finally((): void => {
          if (this.pending.get(pendingKey)?.task === task)
            this.pending.delete(pendingKey);
        })
        .catch(() => undefined);
    }
    const active = pending;
    active.waiters += 1;
    let rejectAbort: ((reason?: unknown) => void) | undefined;
    const onAbort = (): void => rejectAbort?.(signal.reason);
    try {
      return await Promise.race([
        active.task,
        new Promise<string>((_resolve, reject): void => {
          rejectAbort = reject;
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
      active.waiters -= 1;
      if (active.waiters === 0 && this.pending.get(pendingKey) === active) {
        active.controller.abort();
        this.pending.delete(pendingKey);
      }
    }
  }
}

export const chatVisualDocumentCache = new ChatVisualDocumentCache();
