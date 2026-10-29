import { requestBrowserPanel } from '@/lib/browserPanelActivation';
import { useBrowserStore } from '@/stores/browserStore';

/**
 * `file://` URL for an absolute host path, without Node's `pathToFileURL`
 * (unavailable in the renderer). Windows drive paths gain the leading slash a
 * file URL requires; every segment is percent-encoded.
 */
export function absolutePathToFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  const rooted = /^[A-Za-z]:\//.test(normalized)
    ? `/${normalized}`
    : normalized;
  const encoded = rooted
    .split('/')
    .map((segment, index) =>
      index === 1 && /^[A-Za-z]:$/.test(segment)
        ? segment
        : encodeURIComponent(segment),
    )
    .join('/');
  return `file://${encoded}`;
}

/** True for files the in-app browser renders better than the file viewer. */
export function isBrowserRenderedFile(filename: string): boolean {
  return /\.html?$/i.test(filename);
}

/**
 * Open a local file (an HTML page, typically) in a new in-app browser tab for
 * the given scope and reveal its panel. The browser loads linked stylesheets,
 * scripts and fonts, which the sandboxed `srcDoc` HTML preview cannot. Main
 * confines `file:` navigation for read-only viewer scopes to the replica.
 *
 * The tab is placed at once with its URL prefilled; the session is created in
 * the background. `originChatTabId` places the panel beside that chat;
 * `focus: false` adds it without moving focus. `awaitReady` (for callers that
 * report the outcome, like agent tools) resolves only after the session
 * exists, removing the tab when it could not be opened; otherwise a failed
 * open stays in the tab with a Retry. Resolves to the browser id, or `null`
 * when the page could not be opened. `reuseBrowserId` may select a browser
 * returned by an earlier activation; URL equality alone never chooses an account.
 */
export async function openFileInBrowserPanel(
  projectId: string,
  worktreeId: string,
  absolutePath: string,
  options: {
    originChatTabId?: string;
    focus?: boolean;
    awaitReady?: boolean;
    reuseBrowserId?: string;
    preserveSelection?: boolean;
  } = {},
): Promise<string | null> {
  const url = absolutePathToFileUrl(absolutePath);
  const activationOptions =
    options.focus === undefined && !options.preserveSelection
      ? undefined
      : {
          ...(options.focus === undefined ? {} : { focus: options.focus }),
          ...(options.preserveSelection ? { preserveSelection: true } : {}),
        };
  const existing = options.reuseBrowserId
    ? useBrowserStore.getState().worktrees[`${projectId}/${worktreeId}`]
        ?.browsers[options.reuseBrowserId]
    : undefined;
  if (existing?.url === url && options.reuseBrowserId) {
    const activated = await requestBrowserPanel(
      projectId,
      worktreeId,
      options.reuseBrowserId,
      options.originChatTabId,
      activationOptions,
    ).catch(() => false);
    return activated ? options.reuseBrowserId : null;
  }
  const opened = useBrowserStore
    .getState()
    .openUrlFromDevServer(projectId, worktreeId, { url });
  if (opened === null) {
    return null;
  }
  const activated = await requestBrowserPanel(
    projectId,
    worktreeId,
    opened.browserId,
    options.originChatTabId,
    activationOptions,
  ).catch(() => false);
  if (
    !activated ||
    (options.awaitReady === true && (await opened.ready) === null)
  ) {
    const { discardOpenedBrowser } =
      await import('@/lib/panels/browser-panel-sync');
    await discardOpenedBrowser(projectId, worktreeId, opened.browserId);
    return null;
  }
  return opened.browserId;
}
