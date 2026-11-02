/**
 * Host port for the Memory panel: the personal memories agents save on this
 * computer, in a user scope (every project) and a workspace scope (one
 * project). The desktop host implements it over its local memory IPC; a host
 * without local memory does not mount the panel.
 *
 * This is the Memory feature's host adapter boundary, a feature port like
 * `SettingsHostPorts` rather than `CanopyClient` methods: only a host that
 * owns a local memory store can serve it, so mounting the panel is the
 * capability gate, and no `CanopyClient` host has to stub operations it
 * cannot serve. Transport differences stay in each host's implementation;
 * the shared panel never branches on the host.
 *
 * Shapes mirror the desktop local memory contract structurally, so the
 * desktop adapter passes its results through unchanged.
 */

export type LocalMemoryScope =
  | { readonly scope: 'user' }
  | { readonly scope: 'workspace'; readonly workspaceId: string };

export interface LocalMemoryFile {
  readonly fileKey: string;
  readonly kind: 'index' | 'topic' | 'inbox';
  readonly modifiedAt: string;
  readonly sizeBytes: number;
  readonly title?: string;
  readonly excerpt?: string;
  readonly source?: { readonly provider: string; readonly chatId: string };
  /** Absent while usage tracking is unknown for the scope. */
  readonly usageCount?: number;
}

export interface LocalMemoryDocumentItem {
  readonly id: string;
  readonly kind: 'heading' | 'list-item' | 'paragraph' | 'code' | 'block';
  readonly text: string;
  readonly level?: number;
  readonly children: readonly LocalMemoryDocumentItem[];
}

export interface LocalMemoryFileDocument {
  readonly fileKey: string;
  readonly revision: string;
  readonly items: readonly LocalMemoryDocumentItem[];
  /** The Markdown after the front matter, exactly as the file has it. */
  readonly markdown?: string;
}

export interface LocalMemoryStatus {
  readonly pendingNotes: number;
  readonly running: boolean;
  readonly rebuilding: boolean;
  readonly lastRunAt: string | null;
  readonly lastResult: 'success' | 'skipped' | 'failed' | 'cancelled' | null;
  readonly lastReason: string | null;
  readonly lastConsolidatedAt: string | null;
}

export interface LocalMemoryRebuildOutcome {
  readonly rebuild: {
    readonly status: 'completed' | 'stopped' | 'failed' | 'skipped';
    readonly reason?: string;
  };
  readonly status: LocalMemoryStatus;
}

/** A chat a memory came from, as the host can show and open it. */
export interface LocalMemoryChatRef {
  readonly title: string;
}

export interface LocalMemoryClient {
  list(scope: LocalMemoryScope): Promise<readonly LocalMemoryFile[]>;
  read(
    scope: LocalMemoryScope,
    fileKey: string,
  ): Promise<LocalMemoryFileDocument>;
  /** Rejects when the file changed since `revision`. */
  updateFile(
    scope: LocalMemoryScope,
    request: {
      readonly fileKey: string;
      readonly revision: string;
      readonly title?: string;
      readonly body: string;
    },
  ): Promise<LocalMemoryFileDocument>;
  /** Rejects when the file changed since `revision`. */
  deleteFile(
    scope: LocalMemoryScope,
    request: { readonly fileKey: string; readonly revision: string },
  ): Promise<void>;
  status(scope: LocalMemoryScope): Promise<LocalMemoryStatus>;
  consolidate(scope: LocalMemoryScope): Promise<LocalMemoryStatus>;
  rebuild(scope: LocalMemoryScope): Promise<LocalMemoryRebuildOutcome>;
  /** Watches the scope for outside changes; returns the stop function. */
  watch(scope: LocalMemoryScope, onChange: () => void): () => void;
  /** Titles of the chats with these ids that the host still knows. */
  lookupChats(
    chatIds: readonly string[],
  ): Promise<ReadonlyMap<string, LocalMemoryChatRef>>;
  /**
   * Calls `onChange` when the host's chat list changes, so chat titles are
   * looked up again; returns the stop function.
   */
  watchChats(onChange: () => void): () => void;
  /** Opens a chat; resolves with a message when it can't. */
  openChat(
    chatId: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  openSettings(): void;
  /** Opens a web link from a memory, the way other content links open. */
  openLink(url: string): void;
}

/** A brief notice the host shows; `action` adds a button such as Undo. */
export interface LocalMemoryNotice {
  readonly message: string;
  readonly tone?: 'success' | 'error';
  readonly action?: { readonly label: string; readonly run: () => void };
}

export type LocalMemoryNotify = (notice: LocalMemoryNotice) => void;
