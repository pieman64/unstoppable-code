/**
 * In-memory view of one chat's transcript: the files on disk plus the effects
 * of journal records a checkpoint has not applied yet.
 *
 * Each operation mirrors the matching `ChatTranscriptLog` operation, including
 * the conditions under which it throws, so a writer can refuse a record that
 * a checkpoint could not apply. A refused record is never journaled; an
 * accepted one is applied by a checkpoint through the real log.
 */
import { createHash } from 'node:crypto';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { activeRowBytes } from './active-turn';
import type { DeltaJournalTranscriptEffect } from './format';
import { ChatDeltaJournalIntegrityError } from './format';

/** Read access to the transcript files a checkpoint last wrote. */
export interface TranscriptOverlayBase {
  exists(chatId: string): Promise<boolean>;
  committedMessageState(
    chatId: string,
    message: PersistedChatMessage,
  ): Promise<'absent' | 'identical' | 'different'>;
  hasCommittedMessage(chatId: string, messageId: string): Promise<boolean>;
  activeMessages(chatId: string): Promise<PersistedChatMessage[]>;
  iterate(chatId: string): AsyncIterable<PersistedChatMessage>;
  /** The transcript revision the chat's log index holds. */
  transcriptRevision(chatId: string): Promise<number>;
}

/** The rewrite revision a version 2 transaction assigns a replaced log. */
export function rewriteTranscriptRevision(
  toRevision: number,
  prior: number,
): number {
  return Math.max(toRevision, prior + 1);
}

export function messageDigest(message: PersistedChatMessage): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex');
}

/** Upsert by id: replace in place, append ids the projection lacks. */
export function upsertActiveMessages(
  active: readonly PersistedChatMessage[],
  messages: readonly PersistedChatMessage[],
): PersistedChatMessage[] {
  const merged = [...active];
  const positions = new Map(
    merged.map((message, index) => [message.id, index]),
  );
  for (const message of messages) {
    const index = positions.get(message.id);
    if (index === undefined) {
      positions.set(message.id, merged.length);
      merged.push(message);
    } else merged[index] = message;
  }
  return merged;
}

export class ChatTranscriptOverlay {
  /**
   * The serialized size of the rows in `active`, maintained as they change
   * (see {@link setActive}). The size trigger reads it after every commit,
   * so it must not cost a pass over a long turn's rows.
   */
  private activeRowsBytes = 0;

  private constructor(
    public readonly chatId: string,
    private readonly base: TranscriptOverlayBase,
    private hasBase: boolean,
    private patches: Map<string, PersistedChatMessage>,
    private removed: Set<string>,
    private appended: PersistedChatMessage[],
    private active: PersistedChatMessage[] | undefined,
    private deleted: boolean,
    /**
     * The log index's transcript revision once the effects so far are
     * applied, following `ChatTranscriptLog`: each active write adds one,
     * an append that finalizes rows adds one, a rewrite sets it.
     */
    private revision: number,
    /** The chat's transcript revision in the files the effects apply to. */
    public readonly baseRevision: number,
    /**
     * Ids the files hold no committed row for. The files do not change while
     * an overlay lives (a checkpoint replaces every overlay), so an active
     * row is looked up on disk once, not again on every later update.
     */
    private baseAbsent: Set<string> = new Set(),
  ) {}

  /**
   * The chat as the files hold it. A missing transcript is an error unless
   * the effect creates the chat, exactly as a scope transaction requires.
   */
  public static async open(
    chatId: string,
    base: TranscriptOverlayBase,
    create: boolean,
  ): Promise<ChatTranscriptOverlay> {
    const exists = await base.exists(chatId);
    if (!exists && !create)
      throw new ChatDeltaJournalIntegrityError(
        `Transcript ${chatId} is missing`,
      );
    const revision = exists ? await base.transcriptRevision(chatId) : 0;
    return new ChatTranscriptOverlay(
      chatId,
      base,
      exists,
      new Map(),
      new Set(),
      [],
      exists ? undefined : [],
      false,
      revision,
      revision,
    );
  }

  /** A chat whose transcript a record deletes; its files need not exist. */
  public static deletedChat(
    chatId: string,
    base: TranscriptOverlayBase,
  ): ChatTranscriptOverlay {
    return new ChatTranscriptOverlay(
      chatId,
      base,
      false,
      new Map(),
      new Set(),
      [],
      [],
      true,
      0,
      0,
    );
  }

  public clone(): ChatTranscriptOverlay {
    const copy = new ChatTranscriptOverlay(
      this.chatId,
      this.base,
      this.hasBase,
      new Map(this.patches),
      new Set(this.removed),
      [...this.appended],
      this.active ? [...this.active] : undefined,
      this.deleted,
      this.revision,
      this.baseRevision,
      new Set(this.baseAbsent),
    );
    copy.activeRowsBytes = this.activeRowsBytes;
    return copy;
  }

  public get isDeleted(): boolean {
    return this.deleted;
  }

  public get transcriptRevision(): number {
    return this.revision;
  }

  /**
   * Whether the effects so far change the chat's committed rows, or create
   * or delete it, rather than only its active projection.
   */
  public get changesCommittedRows(): boolean {
    return (
      this.deleted ||
      !this.hasBase ||
      this.appended.length > 0 ||
      this.patches.size > 0 ||
      this.removed.size > 0
    );
  }

  /**
   * The active rows the effects so far leave, when only the active
   * projection changed: exactly what the active sidecar holds once they are
   * applied. `undefined` when no effect wrote the active projection.
   */
  public activeProjection():
    | { messages: PersistedChatMessage[]; transcriptRevision: number }
    | undefined {
    if (this.changesCommittedRows || !this.active) return undefined;
    return { messages: [...this.active], transcriptRevision: this.revision };
  }

  /**
   * The serialized size of the active rows {@link activeProjection} holds,
   * or 0 when it holds none: what a checkpoint would write to the sidecar.
   */
  public get activeBytes(): number {
    if (this.changesCommittedRows || !this.active) return 0;
    return this.activeRowsBytes;
  }

  /**
   * Replace the active rows, keeping {@link activeRowsBytes} equal to their
   * serialized size. Only rows that enter or leave are measured: a row
   * object kept from the previous rows keeps its size, so an upsert costs
   * the rows it changes, not the turn's length. Row identity is what
   * matters; the rows' ids are unique, so no object appears twice.
   */
  private setActive(next: PersistedChatMessage[]): void {
    const previous = this.active;
    let bytes = 0;
    if (!previous || previous.length === 0)
      for (const message of next) bytes += activeRowBytes(message);
    else {
      bytes = this.activeRowsBytes;
      const kept = new Set(next);
      for (const message of previous)
        if (!kept.has(message)) bytes -= activeRowBytes(message);
      const prior = new Set(previous);
      for (const message of next)
        if (!prior.has(message)) bytes += activeRowBytes(message);
    }
    this.active = next;
    this.activeRowsBytes = bytes;
  }

  /** The files' committed state of a row this overlay does not change. */
  private async baseCommittedState(
    message: PersistedChatMessage,
  ): Promise<'absent' | 'identical' | 'different'> {
    if (this.baseAbsent.has(message.id)) return 'absent';
    const state = await this.base.committedMessageState(this.chatId, message);
    if (state === 'absent') this.baseAbsent.add(message.id);
    return state;
  }

  private appendedMessage(id: string): PersistedChatMessage | undefined {
    for (let index = this.appended.length - 1; index >= 0; index -= 1)
      if (this.appended[index].id === id) return this.appended[index];
    return undefined;
  }

  public async committedMessageState(
    message: PersistedChatMessage,
  ): Promise<'absent' | 'identical' | 'different'> {
    const existing =
      this.appendedMessage(message.id) ??
      (this.hasBase && !this.removed.has(message.id)
        ? this.patches.get(message.id)
        : undefined);
    if (existing)
      return messageDigest(existing) === messageDigest(message)
        ? 'identical'
        : 'different';
    if (!this.hasBase || this.removed.has(message.id)) return 'absent';
    return this.baseCommittedState(message);
  }

  public async hasCommittedMessage(messageId: string): Promise<boolean> {
    if (this.appendedMessage(messageId)) return true;
    if (!this.hasBase || this.removed.has(messageId)) return false;
    if (this.patches.has(messageId)) return true;
    if (this.baseAbsent.has(messageId)) return false;
    const committed = await this.base.hasCommittedMessage(
      this.chatId,
      messageId,
    );
    if (!committed) this.baseAbsent.add(messageId);
    return committed;
  }

  public async activeMessages(): Promise<PersistedChatMessage[]> {
    return this.active
      ? [...this.active]
      : this.base.activeMessages(this.chatId);
  }

  /** Committed rows in log order. */
  public async *committed(): AsyncGenerator<PersistedChatMessage> {
    if (this.hasBase)
      for await (const row of this.base.iterate(this.chatId)) {
        if (this.removed.has(row.id)) continue;
        yield this.patches.get(row.id) ?? row;
      }
    yield* this.appended;
  }

  private assertLive(): void {
    if (this.deleted)
      throw new ChatDeltaJournalIntegrityError(
        `Transcript ${this.chatId} was deleted`,
      );
  }

  /** `ChatTranscriptLog.append`. */
  private async append(
    messages: readonly PersistedChatMessage[],
  ): Promise<void> {
    const prepared: PersistedChatMessage[] = [];
    const ids = new Set<string>();
    for (const message of messages) {
      const state = await this.committedMessageState(message);
      if (state === 'different')
        throw new Error(`Conflicting committed message ${message.id}`);
      if (state === 'identical') continue;
      if (ids.has(message.id)) throw new Error('Duplicate message in append');
      ids.add(message.id);
      prepared.push(message);
    }
    if (prepared.length === 0) return;
    const active = await this.activeMessages();
    const pendingIds: string[] = [];
    for (const message of active)
      if (!(await this.hasCommittedMessage(message.id)))
        pendingIds.push(message.id);
    if (
      prepared.some((message, index) =>
        index < pendingIds.length ? message.id !== pendingIds[index] : false,
      )
    )
      throw new Error('Finalized messages must follow active transcript order');
    this.appended.push(...prepared);
    this.setActive(active.filter((message) => !ids.has(message.id)));
    this.revision += 1;
  }

  /** `ChatTranscriptLog.writeActive` / `replaceActive`. */
  private async writeActive(
    messages: readonly PersistedChatMessage[],
    allowRemoval: boolean,
  ): Promise<void> {
    const stored: PersistedChatMessage[] = [];
    const ids = new Set<string>();
    for (const message of messages) {
      if (ids.has(message.id)) throw new Error('Duplicate active message');
      ids.add(message.id);
      const state = await this.committedMessageState(message);
      if (state === 'different')
        throw new Error('Active message conflicts with committed history');
      if (state === 'absent') stored.push(message);
    }
    if (!allowRemoval)
      for (const message of await this.activeMessages())
        if (
          !ids.has(message.id) &&
          !(await this.hasCommittedMessage(message.id))
        )
          throw new Error(
            'Active transcript replacement would discard an uncommitted message',
          );
    this.setActive(stored);
    this.revision += 1;
  }

  /** `ChatTranscriptLog.replace`, then the mutable suffix. */
  private async replaceRows(
    rows: readonly PersistedChatMessage[],
    activeTailCount: number,
    revision: number,
  ): Promise<void> {
    const split = rows.length - activeTailCount;
    this.revision = revision;
    this.hasBase = false;
    this.patches = new Map();
    this.removed = new Set();
    this.appended = rows.slice(0, split);
    this.setActive([]);
    const mutable = rows.slice(split);
    if (mutable.length) await this.writeActive(mutable, false);
  }

  /**
   * The scope transaction's admission checks, against the state before the
   * record. They are stricter than the log operation only where the active
   * projection could hold a committed row, which no writer produces.
   */
  private async admit(effect: DeltaJournalTranscriptEffect): Promise<void> {
    if (
      effect.kind !== 'append' &&
      effect.kind !== 'active' &&
      effect.kind !== 'active-replace'
    )
      return;
    if (effect.create) return;
    const active = await this.activeMessages();
    const ids = new Set<string>();
    const appended: string[] = [];
    for (const message of effect.messages) {
      ids.add(message.id);
      const state = await this.committedMessageState(message);
      if (state === 'different')
        throw new Error(`Conflicting committed message ${message.id}`);
      if (state === 'absent') appended.push(message.id);
    }
    if (effect.kind === 'active') {
      if (active.some((message) => !ids.has(message.id)))
        throw new Error('Active update would discard uncommitted messages');
    } else if (
      effect.kind === 'append' &&
      appended.some(
        (id, ordinal) => ordinal < active.length && active[ordinal].id !== id,
      )
    )
      throw new Error('Finalized messages must follow active transcript order');
  }

  private async patch(
    effect: {
      patches: readonly PersistedChatMessage[];
      removedMessageIds: readonly string[];
      tail: readonly PersistedChatMessage[];
      activeTailCount: number;
    },
    revision: number,
  ): Promise<void> {
    this.revision = revision;
    const tailIds = new Set(effect.tail.map((message) => message.id));
    const dropped = new Set([
      ...effect.removedMessageIds,
      ...Array.from(tailIds),
    ]);
    const replacements = new Map(
      effect.patches.map((message) => [message.id, message]),
    );
    if (this.hasBase) {
      for (const id of Array.from(dropped)) {
        this.patches.delete(id);
        this.removed.add(id);
      }
      for (const [id, message] of Array.from(replacements))
        if (
          !this.removed.has(id) &&
          (this.patches.has(id) ||
            (await this.base.hasCommittedMessage(this.chatId, id)))
        )
          this.patches.set(id, message);
    }
    this.appended = this.appended
      .filter((message) => !dropped.has(message.id))
      .map((message) => replacements.get(message.id) ?? message);
    const split = effect.tail.length - effect.activeTailCount;
    this.appended.push(...effect.tail.slice(0, split));
    this.setActive([]);
    const mutable = effect.tail.slice(split);
    if (mutable.length) await this.writeActive(mutable, false);
  }

  /**
   * Apply one effect, throwing exactly where a checkpoint applying it through
   * `ChatTranscriptLog` would. Callers apply to a clone and keep it only
   * once the record is durable. `toRevision` is the record's revision,
   * which sets the transcript revision of a rewrite.
   */
  public async apply(
    effect: DeltaJournalTranscriptEffect,
    toRevision: number,
  ): Promise<void> {
    if (effect.chatId !== this.chatId)
      throw new Error('Transcript effect targets another chat');
    if (effect.kind === 'delete') {
      // Deletion needs no transcript, like `ChatTranscriptLog.remove`.
      this.deleted = true;
      return;
    }
    this.assertLive();
    await this.admit(effect);
    switch (effect.kind) {
      case 'append':
        return this.append(effect.messages);
      case 'active':
        return this.writeActive(effect.messages, false);
      case 'active-replace':
        return this.writeActive(effect.messages, true);
      case 'active-upsert':
        return this.writeActive(
          upsertActiveMessages(await this.activeMessages(), effect.messages),
          false,
        );
      case 'replace':
        return this.replaceRows(
          effect.messages,
          effect.activeTailCount,
          rewriteTranscriptRevision(toRevision, effect.priorTranscriptRevision),
        );
      case 'patch':
        return this.patch(
          effect,
          rewriteTranscriptRevision(toRevision, effect.priorTranscriptRevision),
        );
    }
  }
}
