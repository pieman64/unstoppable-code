import {
  IPC_CHANNELS,
  type ChatInterestDeclaration,
} from '@canopy/desktop-shared/types';
import type { RemotePushSummary } from '@canopy/execution-engine/types/observability';

const WINDOW_MS = 30_000;

function emptySummary(windowMs: number): RemotePushSummary {
  return {
    windowMs,
    interestDeclared: false,
    chatState: {
      pushes: 0,
      bytes: 0,
      onScreenPushes: 0,
      offScreenPushes: 0,
      mixedPushes: 0,
      onScreenBytes: 0,
      offScreenBytes: 0,
      mixedBytes: 0,
    },
    chatEvent: {
      pushes: 0,
      bytes: 0,
      onScreenPushes: 0,
      offScreenPushes: 0,
      onScreenBytes: 0,
      offScreenBytes: 0,
    },
    terminal: { pushes: 0, bytes: 0 },
    other: { pushes: 0, bytes: 0 },
    duplicateDrops: 0,
  };
}

function chatKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return JSON.stringify([projectId, worktreeId, chatId]);
}

function recordOf(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function changeChatId(change: Record<string, unknown>): string | null {
  if (typeof change.chatId === 'string') return change.chatId;
  switch (change.type) {
    case 'tab.upserted': {
      const tab = change.tab;
      return recordOf(tab) && typeof tab.id === 'string' ? tab.id : null;
    }
    case 'tab.removed':
    case 'tab.metadata_patched':
      return typeof change.tabId === 'string' ? change.tabId : null;
    case 'tab.active_changed':
      return typeof change.activeTabId === 'string' ? change.activeTabId : null;
    case 'pending_question.upserted': {
      const question = change.question;
      return recordOf(question) && typeof question.chatId === 'string'
        ? question.chatId
        : null;
    }
    case 'archive.upserted': {
      const archive = change.archive;
      return recordOf(archive) && typeof archive.chatId === 'string'
        ? archive.chatId
        : null;
    }
    default:
      return null;
  }
}

/** Counts only what this live controller was actually forwarded. */
export class RemotePushSummaryAccumulator {
  private summary = emptySummary(WINDOW_MS);
  private windowStartedAt = Date.now();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  /** The declaration `onScreen` was built from; rebuilt when it changes. */
  private interest: ChatInterestDeclaration | undefined;
  private onScreen = new Set<string>();

  constructor(
    private readonly getInterest: () => ChatInterestDeclaration | undefined,
    private readonly record: (summary: RemotePushSummary) => void,
  ) {
    this.timer = setInterval(() => this.flush(), WINDOW_MS);
    this.timer.unref?.();
  }

  forwarded(
    channel: string,
    args: ReadonlyArray<unknown>,
    bytes: number,
    interest: ChatInterestDeclaration | null = this.getInterest() ?? null,
  ): void {
    if (this.closed) return;
    this.refreshInterest(interest ?? undefined);
    if (channel === IPC_CHANNELS.chatStateChanged) {
      const bucket = this.summary.chatState;
      bucket.pushes += 1;
      bucket.bytes += bytes;
      if (this.interest === undefined) return;
      const event = args[0];
      if (!recordOf(event)) return;
      const { projectId, worktreeId, changes } = event;
      if (
        typeof projectId !== 'string' ||
        typeof worktreeId !== 'string' ||
        !Array.isArray(changes)
      )
        return;
      let on = false;
      let off = false;
      for (const value of changes) {
        if (!recordOf(value)) continue;
        const chatId = changeChatId(value);
        if (chatId === null) continue;
        if (this.onScreen.has(chatKey(projectId, worktreeId, chatId)))
          on = true;
        else off = true;
      }
      // Scope-level changes have no chatId. Alone, they count as on screen;
      // alongside chat changes, they do not turn a push into mixed.
      if (!off) {
        bucket.onScreenPushes += 1;
        bucket.onScreenBytes += bytes;
      } else if (!on) {
        bucket.offScreenPushes += 1;
        bucket.offScreenBytes += bytes;
      } else {
        bucket.mixedPushes += 1;
        bucket.mixedBytes += bytes;
      }
      return;
    }
    if (channel === IPC_CHANNELS.chatEvent) {
      const bucket = this.summary.chatEvent;
      bucket.pushes += 1;
      bucket.bytes += bytes;
      if (this.interest === undefined) return;
      const event = args[0];
      if (!recordOf(event)) return;
      if (
        typeof event.projectId !== 'string' ||
        typeof event.worktreeId !== 'string' ||
        typeof event.chatId !== 'string'
      )
        return;
      if (
        this.onScreen.has(
          chatKey(event.projectId, event.worktreeId, event.chatId),
        )
      ) {
        bucket.onScreenPushes += 1;
        bucket.onScreenBytes += bytes;
      } else {
        bucket.offScreenPushes += 1;
        bucket.offScreenBytes += bytes;
      }
      return;
    }
    const bucket =
      channel === IPC_CHANNELS.terminalOutput ||
      channel === IPC_CHANNELS.authTerminalOutput
        ? this.summary.terminal
        : this.summary.other;
    bucket.pushes += 1;
    bucket.bytes += bytes;
  }

  duplicateDropped(): void {
    if (!this.closed) this.summary.duplicateDrops += 1;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.flush();
  }

  /**
   * Read the bridge's current declaration on every push (a map lookup), so a
   * chat switch mid-window is attributed at once; the on-screen set is only
   * rebuilt when the controller declares again.
   */
  private refreshInterest(interest: ChatInterestDeclaration | undefined): void {
    if (interest !== this.interest) {
      this.interest = interest;
      this.onScreen =
        interest === undefined
          ? new Set()
          : new Set(
              [...interest.focused, ...interest.warm].map((chat) =>
                chatKey(chat.projectId, chat.worktreeId, chat.chatId),
              ),
            );
    }
    if (interest !== undefined) this.summary.interestDeclared = true;
  }

  private flush(): void {
    const now = Date.now();
    const summary = this.summary;
    summary.windowMs = Math.max(0, now - this.windowStartedAt);
    this.windowStartedAt = now;
    this.summary = emptySummary(WINDOW_MS);
    if (
      summary.chatState.pushes +
        summary.chatEvent.pushes +
        summary.terminal.pushes +
        summary.other.pushes >
      0
    )
      this.record(summary);
  }
}
