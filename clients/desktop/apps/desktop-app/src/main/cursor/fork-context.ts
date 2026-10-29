import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { buildTranscriptForkPrompt } from '../agents/transcript-fork-context';

/** Transfers the target's frozen transcript once per native Cursor session. */
export class CursorForkContext {
  private deliveredSessionId: string | undefined;
  private pendingSessionId: string | undefined;

  constructor(
    private readonly scope: {
      projectId: string;
      worktreeId: string;
      chatId: string;
    },
  ) {}

  async prompt(
    profile: string,
    sessionId: string,
    userMessageId?: string,
  ): Promise<string> {
    if (this.deliveredSessionId === sessionId) return '';
    try {
      if (
        (await readFile(join(profile, 'fork-context-delivered'), 'utf8')) ===
        sessionId
      ) {
        this.deliveredSessionId = sessionId;
        return '';
      }
    } catch (error) {
      if (
        !(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      )
        throw error;
    }
    const uncertainDelivery = (): Error =>
      new Error(
        'Delivery of this fork context could not be confirmed. Create a new fork to continue.',
      );
    if (this.pendingSessionId !== undefined) throw uncertainDelivery();
    try {
      // Replacing the native session does not settle the previous prompt's
      // effects. Any unresolved marker refuses replay, even a partial one.
      await readFile(join(profile, 'fork-context-pending'), 'utf8');
      throw uncertainDelivery();
    } catch (error) {
      if (
        !(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      )
        throw error;
    }
    // The destination snapshot is authoritative. Reading the source would leak
    // messages sent after a historical fork, and would fail if it was deleted.
    const file = await readChatTabsFile(
      this.scope.projectId,
      this.scope.worktreeId,
      { chatIds: [this.scope.chatId], fullTranscript: true },
    );
    const tab = file.tabs.find(
      (candidate) => candidate.id === this.scope.chatId,
    );
    const prompt = tab
      ? buildTranscriptForkPrompt(tab, 'Cursor', userMessageId)
      : '';
    if (!prompt) this.deliveredSessionId = sessionId;
    else {
      // A failed RPC can have reached the provider. Persist intent before
      // sending so a restart cannot replay uncertain work automatically.
      await writeFile(join(profile, 'fork-context-pending'), sessionId, {
        mode: 0o600,
        flush: true,
      });
      this.pendingSessionId = sessionId;
    }
    return prompt;
  }

  async delivered(profile: string, sessionId: string): Promise<void> {
    // Publish confirmed delivery before clearing its uncertain-admission marker.
    await writeFile(join(profile, 'fork-context-delivered'), sessionId, {
      mode: 0o600,
    });
    this.deliveredSessionId = sessionId;
    this.pendingSessionId = undefined;
    await rm(join(profile, 'fork-context-pending'), { force: true });
  }
}
