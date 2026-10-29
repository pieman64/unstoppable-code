// ---------------------------------------------------------------------------
// Pick & Polish — browser element → chat attachment
// ---------------------------------------------------------------------------
//
// Turns a `BrowserElementSnapshot` (emitted by the in-app browser when the user
// clicks an element in "Pick & Polish" mode) into a markdown attachment and
// stages it as a *pending* attachment on the active chat draft. It never sends
// a chat message — the user reviews the attachment and sends manually.

import type {
  BrowserConsoleEntry,
  BrowserElementSnapshot,
  BrowserLocatorCandidate,
  BrowserNetworkEntry,
  ClipboardAttachmentData,
  AttachmentMeta,
  ChatAttachmentPromptKind,
} from '@canopy/desktop-shared/types';
import { useGitHubStore } from '@/stores/githubStore';
import { useBrowserStore } from '@/stores/browserStore';
import {
  addPendingAttachmentsAndRefreshIndex,
  importChatAttachments,
  resolveActiveEditableChatTarget,
} from '@/lib/chatAttachments';

const PICK_ATTACH_SUCCESS_MESSAGE = 'UI selection attached to chat draft.';
const PICK_ATTACH_NO_TAB_MESSAGE =
  'Unable to attach UI selection to this chat.';
const IN_APP_BROWSER_RESOURCE_PROMPT_KIND =
  'in-app-browser-resource' satisfies ChatAttachmentPromptKind;

/** Max diagnostics rows embedded in the attachment markdown. */
const MAX_DIAGNOSTIC_ROWS = 20;

export interface BrowserPickDiagnostics {
  consoleErrors: BrowserConsoleEntry[];
  failedRequests: BrowserNetworkEntry[];
}

function compactTimestamp(iso: string): string {
  // Render an ISO timestamp as `YYYYMMDD-HHMMSS` (UTC). Falls back to a stable
  // placeholder when the snapshot timestamp cannot be parsed.
  const parsed = new Date(iso);
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

function locatorLine(candidate: BrowserLocatorCandidate): string {
  const expression = candidate.playwright ?? candidate.value;
  const suffix = candidate.unique ? '' : ' (not unique)';
  return `- ${candidate.confidence}: ${expression}${suffix}`;
}

/**
 * Build the markdown body (and filename) describing a picked element. Pure:
 * diagnostics are passed in so this stays trivially testable.
 */
export function buildBrowserElementAttachment(
  snapshot: BrowserElementSnapshot,
  diagnostics?: BrowserPickDiagnostics,
): { markdownFilename: string; markdown: string } {
  const lines: string[] = [];
  lines.push('# UI Element Selection');
  lines.push('');
  lines.push(`URL: ${snapshot.url}`);
  lines.push(`Title: ${snapshot.title}`);
  lines.push(`Captured at: ${snapshot.capturedAt}`);
  lines.push(`Browser theme: ${snapshot.themeMode}`);
  lines.push(
    `Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height} @ ${snapshot.viewport.deviceScaleFactor}`,
  );
  lines.push('');

  lines.push('## Preferred Locator');
  lines.push('');
  const preferred =
    snapshot.preferredLocator?.playwright ??
    snapshot.preferredLocator?.value ??
    snapshot.locatorCandidates[0]?.playwright ??
    snapshot.locatorCandidates[0]?.value;
  lines.push(preferred ?? '(none generated)');
  lines.push('');

  lines.push('## Locator Candidates');
  lines.push('');
  if (snapshot.locatorCandidates.length === 0) {
    lines.push('(none)');
  } else {
    for (const candidate of snapshot.locatorCandidates) {
      lines.push(locatorLine(candidate));
    }
  }
  lines.push('');

  lines.push('## Element');
  lines.push('');
  lines.push(`Tag: ${snapshot.tagName}`);
  if (snapshot.role) {
    lines.push(`Role: ${snapshot.role}`);
  }
  if (snapshot.accessibleName) {
    lines.push(`Accessible name: ${snapshot.accessibleName}`);
  }
  const textOrValue = snapshot.text ?? snapshot.value;
  if (textOrValue !== undefined) {
    lines.push(`Text/value: ${textOrValue}`);
  }
  lines.push(
    `Bounds: x=${snapshot.bounds.x}, y=${snapshot.bounds.y}, ` +
      `width=${snapshot.bounds.width}, height=${snapshot.bounds.height}`,
  );
  lines.push('');

  lines.push('## Attributes');
  lines.push('');
  const attributeEntries = Object.entries(snapshot.attributes);
  if (attributeEntries.length === 0) {
    lines.push('(none)');
  } else {
    for (const [name, value] of attributeEntries) {
      lines.push(`- ${name}="${value}"`);
    }
  }
  lines.push('');

  lines.push('## DOM Excerpt');
  lines.push('');
  if (snapshot.domPath.length > 0) {
    lines.push(`Path: ${snapshot.domPath.join(' > ')}`);
    lines.push('');
  }
  lines.push('```html');
  lines.push(snapshot.outerHtml);
  lines.push('```');
  lines.push('');

  lines.push('## Recent Browser Diagnostics');
  lines.push('');
  lines.push('Console errors:');
  const consoleErrors = diagnostics?.consoleErrors ?? [];
  if (consoleErrors.length === 0) {
    lines.push('(none)');
  } else {
    for (const entry of consoleErrors.slice(-MAX_DIAGNOSTIC_ROWS)) {
      const where =
        entry.url !== undefined
          ? ` (${entry.url}${
              entry.lineNumber !== undefined ? `:${entry.lineNumber}` : ''
            })`
          : '';
      lines.push(`- ${entry.text}${where}`);
    }
  }
  lines.push('');
  lines.push('Failed network requests:');
  const failedRequests = diagnostics?.failedRequests ?? [];
  if (failedRequests.length === 0) {
    lines.push('(none)');
  } else {
    for (const entry of failedRequests.slice(-MAX_DIAGNOSTIC_ROWS)) {
      const status =
        entry.status !== undefined
          ? String(entry.status)
          : (entry.errorText ?? 'failed');
      lines.push(`- ${entry.method} ${status} ${entry.url}`);
    }
  }
  lines.push('');

  return {
    markdownFilename: `ui-selection-${compactTimestamp(snapshot.capturedAt)}.md`,
    markdown: lines.join('\n'),
  };
}

function readDiagnostics(browserId: string): BrowserPickDiagnostics {
  const state = useBrowserStore.getState();
  const consoleErrors = (state.consoleEntries[browserId] ?? []).filter(
    (entry) => entry.level === 'error',
  );
  const failedRequests = (state.networkEntries[browserId] ?? []).filter(
    (entry) => entry.failed === true,
  );
  return { consoleErrors, failedRequests };
}

function markdownToClipboardItem(
  filename: string,
  markdown: string,
): ClipboardAttachmentData {
  return { filename, data: new TextEncoder().encode(markdown) };
}

export function markInAppBrowserResourceAttachment(
  attachment: AttachmentMeta,
): AttachmentMeta {
  return {
    ...attachment,
    promptKind: IN_APP_BROWSER_RESOURCE_PROMPT_KIND,
  };
}

/**
 * Stage a picked element as a pending chat attachment on the active editable
 * chat tab. Shows a toast on success/failure and never sends a message.
 */
export async function stageBrowserElementPick(
  snapshot: BrowserElementSnapshot,
): Promise<void> {
  const toast = useGitHubStore.getState().addToast;
  const pendingTarget = resolveActiveEditableChatTarget();
  if (!pendingTarget) {
    toast(PICK_ATTACH_NO_TAB_MESSAGE, 'error');
    return;
  }

  const diagnostics = readDiagnostics(snapshot.browserId);
  const { markdownFilename, markdown } = buildBrowserElementAttachment(
    snapshot,
    diagnostics,
  );

  const target = {
    projectId: pendingTarget.projectId,
    worktreeId: pendingTarget.worktreeId,
  };

  try {
    const imported = await importChatAttachments(
      target,
      snapshot.screenshotAttachmentPath
        ? [snapshot.screenshotAttachmentPath]
        : [],
      [markdownToClipboardItem(markdownFilename, markdown)],
    );
    const attachments = imported.map(markInAppBrowserResourceAttachment);
    addPendingAttachmentsAndRefreshIndex(
      target,
      attachments,
      undefined,
      pendingTarget,
    );
    toast(PICK_ATTACH_SUCCESS_MESSAGE, 'success');
  } catch {
    toast(PICK_ATTACH_NO_TAB_MESSAGE, 'error');
  }
}
