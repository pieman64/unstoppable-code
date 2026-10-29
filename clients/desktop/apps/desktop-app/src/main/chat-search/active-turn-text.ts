/**
 * Incremental in-flight text for chat search over delta-journal scopes
 * (phase 10).
 *
 * While a turn is in progress its active rows live in the journal writer's
 * memory and records, not in a rewritten active sidecar. Search keeps, per
 * live chat, the text of each active row at one transcript revision. An
 * update asks the writer which rows changed since that revision
 * (`activeTurnDelta`) and re-extracts only those rows; the in-flight body is
 * then rebuilt from the cached rows in the writer's order, with the same
 * extraction and separator as a full read, so it is the body a full read of
 * the same rows produces.
 */
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import type { ActiveTurnDelta } from '../lib/chat-delta-journal/active-turn';

/** The revision a chat's cached rows hold, for its next delta request. */
export interface ActiveTurnTextState {
  committedFingerprint: string;
  transcriptRevision: number;
}

interface CachedChat extends ActiveTurnTextState {
  order: string[];
  texts: Map<string, string>;
}

/** Live chats whose in-flight rows are cached; least recently used leave. */
const DEFAULT_CACHED_CHATS = 32;

export class ActiveTurnSearchText {
  private readonly chats = new Map<string, CachedChat>();

  public constructor(
    private readonly extract: (message: PersistedChatMessage) => string,
    private readonly limit = DEFAULT_CACHED_CHATS,
  ) {}

  public state(key: string): ActiveTurnTextState | undefined {
    const chat = this.chats.get(key);
    return chat
      ? {
          committedFingerprint: chat.committedFingerprint,
          transcriptRevision: chat.transcriptRevision,
        }
      : undefined;
  }

  private remember(key: string, chat: CachedChat): void {
    this.chats.delete(key);
    this.chats.set(key, chat);
    while (this.chats.size > this.limit) {
      const oldest = this.chats.keys().next();
      if (oldest.done) break;
      this.chats.delete(oldest.value);
    }
  }

  private static body(chat: CachedChat): string {
    const text: string[] = [];
    for (const id of chat.order) {
      const value = chat.texts.get(id);
      if (value) text.push(value);
    }
    return text.join('\n\n');
  }

  /** Cache a full read of the active rows; returns their body. */
  public reset(
    key: string,
    state: ActiveTurnTextState,
    rows: ReadonlyArray<{ id: string; text: string }>,
  ): string {
    const chat: CachedChat = {
      ...state,
      order: rows.map((row) => row.id),
      texts: new Map(rows.map((row) => [row.id, row.text])),
    };
    this.remember(key, chat);
    return ActiveTurnSearchText.body(chat);
  }

  /**
   * Apply a writer delta taken since the cached revision. Undefined, and the
   * entry forgotten, when the chat's cache is not at the delta's base or a
   * row the order names was never read: the caller reads the rows whole.
   */
  public apply(
    key: string,
    committedFingerprint: string,
    since: number,
    delta: ActiveTurnDelta,
  ): string | undefined {
    const chat = this.chats.get(key);
    if (
      !chat ||
      chat.committedFingerprint !== committedFingerprint ||
      chat.transcriptRevision !== since
    ) {
      this.chats.delete(key);
      return undefined;
    }
    const texts = new Map<string, string>();
    for (const message of delta.changed)
      texts.set(message.id, this.extract(message));
    for (const id of delta.order) {
      if (texts.has(id)) continue;
      const cached = chat.texts.get(id);
      if (cached === undefined) {
        this.chats.delete(key);
        return undefined;
      }
      texts.set(id, cached);
    }
    const next: CachedChat = {
      committedFingerprint,
      transcriptRevision: delta.transcriptRevision,
      order: [...delta.order],
      texts,
    };
    this.remember(key, next);
    return ActiveTurnSearchText.body(next);
  }

  public delete(key: string): void {
    this.chats.delete(key);
  }

  /** Forget every chat whose key starts with `prefix`. */
  public deletePrefix(prefix: string): void {
    for (const key of Array.from(this.chats.keys()))
      if (key.startsWith(prefix)) this.chats.delete(key);
  }
}
