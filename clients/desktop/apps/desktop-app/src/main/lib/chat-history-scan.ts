import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getWorkspacesRootDir } from './paths';
import {
  chatStorageScopeIds,
  readChatStorageDiscoveryIndex,
} from './chat-storage-discovery';

/**
 * Shared backfill answer to "has this user ever sent a chat message?", for
 * users who installed before a given signal existed.
 *
 * Two independent subsystems need exactly this question and used to each
 * carry their own copy of the walk: the activation notification campaigns
 * (CAN-1967/CAN-2438, `notifications/campaigns/activation-signals.ts`) and the
 * sidebar onboarding checklist's `start-chat` item (CAN-2663,
 * `onboarding-checklist-progress.ts`). They cannot import each other —
 * activation-signals already depends on the checklist evaluator, so the reverse
 * edge would be a cycle — hence this leaf module, which depends only on
 * `paths`.
 *
 * Memoized once per process and shared by both callers: the scan parses chat
 * files, and running it twice to answer the same question is pure waste. Live
 * sends latch through each subsystem's own durable marker
 * (`latchFirstTaskSubmitted`, `notifyOnboardingChecklistChatStarted`), so this
 * never needs to re-run.
 *
 * Only user-visible workspaces under `workspaces/` are scanned.
 * `app-workspaces/` (App Advisor, Code Review, Pipeline Editor) is excluded on
 * purpose: a Canopy-owned assistant turn is not the user starting work of
 * their own.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function chatFileHasUserMessage(filePath: string): Promise<boolean> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.tabs)) return false;
    return parsed.tabs.some(
      (tab) =>
        isRecord(tab) &&
        Array.isArray(tab.messages) &&
        tab.messages.some(
          (message) => isRecord(message) && message.role === 'user',
        ),
    );
  } catch {
    // A single unreadable or corrupt chat file must not abort the scan.
    return false;
  }
}

let userMessageScan: Promise<boolean> | null = null;

export function hasEverSentChatMessage(): Promise<boolean> {
  userMessageScan ??= (async (): Promise<boolean> => {
    let workspaceIds: string[];
    try {
      // `withFileTypes` matters: `workspaces/` also holds `index.json`, and
      // without it every non-directory entry becomes a candidate workspace id
      // whose `<entry>/chats` probe then fails — using a thrown ENOENT as
      // control flow once per file.
      const entries = await readdir(getWorkspacesRootDir(), {
        withFileTypes: true,
      });
      workspaceIds = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return false;
    }
    for (const workspaceId of workspaceIds) {
      const workspaceRoot = join(getWorkspacesRootDir(), workspaceId);
      const canonicalScopes = new Set(
        await chatStorageScopeIds(workspaceRoot).catch(() => []),
      );
      for (const scopeId of Array.from(canonicalScopes)) {
        try {
          const index = await readChatStorageDiscoveryIndex(
            workspaceRoot,
            scopeId,
          );
          if (
            index.tabs.some(
              (tab) =>
                isRecord(tab.transcript) &&
                typeof tab.transcript.userMessageCount === 'number' &&
                tab.transcript.userMessageCount > 0,
            )
          )
            return true;
        } catch {
          // Preserve authority even when corrupt; continue with other scopes.
        }
      }
      const chatsDir = join(getWorkspacesRootDir(), workspaceId, 'chats');
      let chatFiles: string[];
      try {
        chatFiles = await readdir(chatsDir);
      } catch {
        continue;
      }
      for (const chatFile of chatFiles) {
        if (!chatFile.endsWith('.json')) continue;
        if (canonicalScopes.has(chatFile.slice(0, -5))) continue;
        // Short-circuit on the first hit: this only answers a yes/no.
        if (await chatFileHasUserMessage(join(chatsDir, chatFile))) return true;
      }
    }
    return false;
  })();
  return userMessageScan;
}

/**
 * Test-only: clears the memoized scan. Production never resets it — scanning
 * once per process is the point.
 */
export function resetChatHistoryScanForTests(): void {
  userMessageScan = null;
}
