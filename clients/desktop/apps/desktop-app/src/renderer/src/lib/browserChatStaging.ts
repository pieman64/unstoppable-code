// ---------------------------------------------------------------------------
// In-app browser → chat attachment staging (recordings + screenshots)
// ---------------------------------------------------------------------------
//
// Helpers that stage a recorded Playwright-like script or a captured
// screenshot as a *pending* chat attachment on the active editable chat tab.
// Like Pick & Polish, these never send a message; they only stage a draft
// attachment and surface a toast.

import type {
  BrowserConsoleEntry,
  BrowserNetworkEntry,
  BrowserRecordingResult,
} from '@canopy/desktop-shared/types';
import { useGitHubStore } from '@/stores/githubStore';
import {
  addPendingAttachmentsAndRefreshIndex,
  importChatAttachments,
  resolveActiveEditableChatTarget,
} from '@/lib/chatAttachments';
import { markInAppBrowserResourceAttachment } from '@/lib/browserPickAttachment';

const NO_TAB_MESSAGE = 'Unable to attach to this chat.';

function compactTimestamp(epochMs: number): string {
  const parsed = new Date(epochMs);
  if (Number.isNaN(parsed.getTime())) {
    return 'unknown';
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${parsed.getUTCFullYear()}${pad(parsed.getUTCMonth() + 1)}` +
    `${pad(parsed.getUTCDate())}-${pad(parsed.getUTCHours())}` +
    `${pad(parsed.getUTCMinutes())}${pad(parsed.getUTCSeconds())}`
  );
}

/**
 * Build the markdown body for a recorded browser session. Pure so it can be
 * unit-tested without the chat stores.
 */
export function buildBrowserRecordingMarkdown(
  result: BrowserRecordingResult,
  capturedAtMs: number,
): { markdownFilename: string; markdown: string } {
  const lines: string[] = [];
  lines.push('# Browser Recording');
  lines.push('');
  lines.push(`Steps: ${result.steps.length}`);
  lines.push('');
  lines.push('## Playwright Script');
  lines.push('');
  lines.push('```ts');
  lines.push(result.playwrightScript);
  lines.push('```');
  lines.push('');
  return {
    markdownFilename: `browser-recording-${compactTimestamp(capturedAtMs)}.md`,
    markdown: lines.join('\n'),
  };
}

export function buildBrowserConsoleMarkdown(
  entry: BrowserConsoleEntry,
  capturedAtMs: number,
): { markdownFilename: string; markdown: string } {
  const location =
    entry.url !== undefined
      ? `${entry.url}${entry.lineNumber !== undefined ? `:${entry.lineNumber}` : ''}${
          entry.columnNumber !== undefined ? `:${entry.columnNumber}` : ''
        }`
      : 'unknown';
  const lines: string[] = [];
  lines.push('# Browser Console Entry');
  lines.push('');
  lines.push(`Level: ${entry.level}`);
  lines.push(`Source: ${location}`);
  lines.push(`Captured: ${new Date(entry.timestamp).toISOString()}`);
  lines.push('');
  lines.push('## Message');
  lines.push('');
  lines.push('```text');
  lines.push(entry.text);
  lines.push('```');
  lines.push('');
  return {
    markdownFilename: `browser-console-${compactTimestamp(capturedAtMs)}.md`,
    markdown: lines.join('\n'),
  };
}

export function buildBrowserNetworkMarkdown(
  entry: BrowserNetworkEntry,
  capturedAtMs: number,
): { markdownFilename: string; markdown: string } {
  const lines: string[] = [];
  lines.push('# Browser Network Entry');
  lines.push('');
  lines.push(`Method: ${entry.method || 'GET'}`);
  lines.push(`URL: ${entry.url || '(unknown URL)'}`);
  lines.push(
    `Status: ${
      entry.failed
        ? `failed${entry.errorText ? ` (${entry.errorText})` : ''}`
        : (entry.status ?? 'pending')
    }`,
  );
  if (entry.statusText) lines.push(`Status text: ${entry.statusText}`);
  if (entry.resourceType) lines.push(`Resource type: ${entry.resourceType}`);
  if (entry.mimeType) lines.push(`MIME type: ${entry.mimeType}`);
  if (entry.durationMs !== undefined) {
    lines.push(`Duration: ${Math.round(entry.durationMs)} ms`);
  }
  if (entry.fromCache) lines.push('From cache: true');
  lines.push(`Captured: ${new Date(entry.timestamp).toISOString()}`);
  lines.push('');
  return {
    markdownFilename: `browser-network-${compactTimestamp(capturedAtMs)}.md`,
    markdown: lines.join('\n'),
  };
}

async function stageBrowserMarkdownAttachment(options: {
  markdownFilename: string;
  markdown: string;
  successMessage: string;
}): Promise<boolean> {
  const toast = useGitHubStore.getState().addToast;
  const pendingTarget = resolveActiveEditableChatTarget();
  if (!pendingTarget) {
    toast(NO_TAB_MESSAGE, 'error');
    return false;
  }
  const target = {
    projectId: pendingTarget.projectId,
    worktreeId: pendingTarget.worktreeId,
  };
  try {
    const imported = await importChatAttachments(
      target,
      [],
      [
        {
          filename: options.markdownFilename,
          data: new TextEncoder().encode(options.markdown),
        },
      ],
    );
    addPendingAttachmentsAndRefreshIndex(
      target,
      imported.map(markInAppBrowserResourceAttachment),
      undefined,
      pendingTarget,
    );
    toast(options.successMessage, 'success');
    return true;
  } catch {
    toast(NO_TAB_MESSAGE, 'error');
    return false;
  }
}

/** Stage a recorded session's Playwright script as a chat attachment. */
export async function stageBrowserRecording(
  result: BrowserRecordingResult,
): Promise<boolean> {
  const { markdownFilename, markdown } = buildBrowserRecordingMarkdown(
    result,
    Date.now(),
  );
  return stageBrowserMarkdownAttachment({
    markdownFilename,
    markdown,
    successMessage: 'Recording attached to chat draft.',
  });
}

export async function stageBrowserConsoleEntry(
  entry: BrowserConsoleEntry,
): Promise<boolean> {
  const { markdownFilename, markdown } = buildBrowserConsoleMarkdown(
    entry,
    Date.now(),
  );
  return stageBrowserMarkdownAttachment({
    markdownFilename,
    markdown,
    successMessage: 'Console entry attached to chat draft.',
  });
}

export async function stageBrowserNetworkEntry(
  entry: BrowserNetworkEntry,
): Promise<boolean> {
  const { markdownFilename, markdown } = buildBrowserNetworkMarkdown(
    entry,
    Date.now(),
  );
  return stageBrowserMarkdownAttachment({
    markdownFilename,
    markdown,
    successMessage: 'Network entry attached to chat draft.',
  });
}

/**
 * Import an already-persisted browser screenshot into chat-owned storage and
 * stage that durable copy on the active draft.
 */
export async function stageBrowserScreenshot(
  attachmentPath: string,
): Promise<boolean> {
  const toast = useGitHubStore.getState().addToast;
  const pendingTarget = resolveActiveEditableChatTarget();
  if (!pendingTarget) {
    toast(NO_TAB_MESSAGE, 'error');
    return false;
  }
  const target = {
    projectId: pendingTarget.projectId,
    worktreeId: pendingTarget.worktreeId,
  };
  try {
    const imported = await importChatAttachments(target, [attachmentPath]);
    addPendingAttachmentsAndRefreshIndex(
      target,
      imported.map(markInAppBrowserResourceAttachment),
      undefined,
      pendingTarget,
    );
    toast('Screenshot attached to chat draft.', 'success');
    return true;
  } catch {
    toast(NO_TAB_MESSAGE, 'error');
    return false;
  }
}

/**
 * Import a finished browser download into chat-owned storage and stage that
 * copy on the active draft, like a screenshot.
 */
export async function stageBrowserDownload(
  attachPath: string,
  fileName: string,
): Promise<boolean> {
  const toast = useGitHubStore.getState().addToast;
  const pendingTarget = resolveActiveEditableChatTarget();
  if (!pendingTarget) {
    toast(NO_TAB_MESSAGE, 'error');
    return false;
  }
  const target = {
    projectId: pendingTarget.projectId,
    worktreeId: pendingTarget.worktreeId,
  };
  try {
    const imported = await importChatAttachments(target, [attachPath]);
    addPendingAttachmentsAndRefreshIndex(
      target,
      imported.map(markInAppBrowserResourceAttachment),
      undefined,
      pendingTarget,
    );
    toast(`${fileName} attached to chat draft.`, 'success');
    return true;
  } catch {
    toast(NO_TAB_MESSAGE, 'error');
    return false;
  }
}
