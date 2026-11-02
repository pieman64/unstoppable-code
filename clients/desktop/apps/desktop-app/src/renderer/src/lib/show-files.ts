import type {
  FileContentResponse,
  ReviewAnnotation,
  ReviewCommentThread,
  ShowFileRequest,
  ShowFilesPresentationReason,
  ShowFilesRendererRequest,
  ShowFilesRendererResult,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  isRichDocumentRenderKind,
  resolveFileRenderKind,
} from '@canopy/ui-app';
import { useChatStore } from '@/stores/chatStore';
import { useAgentFilePresentationStore } from '@/stores/agentFilePresentationStore';
import {
  placeFilePanelsBesideChat,
  requestFilePanelPlacementBesideChat,
  settleFilePanelOpen,
} from '@/lib/panels/chat-panel-sync';
import { openFileInBrowserPanel } from '@/lib/openFileInBrowserPanel';
import { requestBrowserPanel } from '@/lib/browserPanelActivation';
import { selectBrowserHandoff, useBrowserStore } from '@/stores/browserStore';
import { pendingTabCreation } from '@/stores/chat/pending-tab-creation';

const MAX_ANNOTATION_QUOTE_BYTES = 256 * 1024;

function slash(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const prefix = normalized.startsWith('//')
    ? '//'
    : normalized.startsWith('/')
      ? '/'
      : '';
  return `${prefix}${normalized.replace(/^\/+/, '').replace(/\/+/g, '/')}`;
}

function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) || /^\\\\/.test(path)
  );
}

export function pathInsideRoot(path: string, root: string): boolean {
  const normalizedPath = slash(path).replace(/\/+$/, '');
  const normalizedRoot = slash(root).replace(/\/+$/, '');
  const insensitive =
    /^[a-z]:\//i.test(normalizedRoot) || normalizedRoot.startsWith('//');
  const candidate = insensitive ? normalizedPath.toLowerCase() : normalizedPath;
  const base = insensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  return candidate === base || candidate.startsWith(`${base}/`);
}

export function joinRoot(root: string, relative: string): string | null {
  const segments = slash(relative).split('/');
  const clean: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (clean.length === 0) return null;
      clean.pop();
    } else {
      clean.push(segment);
    }
  }
  const windowsRoot = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(root);
  const separator = windowsRoot ? '\\' : '/';
  const normalizedRoot = windowsRoot
    ? root.replace(/\//g, '\\')
    : root.replace(/\\/g, '/');
  return `${normalizedRoot.replace(/[\\/]+$/, '')}${separator}${clean.join(separator)}`;
}

function supportsRichView(file: FileContentResponse): boolean {
  return (
    file.kind === 'markdown' ||
    file.kind === 'html' ||
    file.filename.toLowerCase().endsWith('.csv') ||
    file.kind === 'image'
  );
}

/**
 * An HTML page opens rendered in the in-app browser, which loads its linked
 * styles and scripts. The sandboxed preview cannot, and is deliberately left
 * that way. Asking for source (`view: 'raw'`), a line, or annotations is
 * about the code, so those keep the file viewer.
 */
function opensInBrowser(
  request: ShowFileRequest,
  file: FileContentResponse,
): boolean {
  return (
    file.kind === 'html' &&
    request.view !== 'raw' &&
    request.line === undefined &&
    !request.annotations?.length
  );
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}

function normalizedPresentation(
  request: ShowFileRequest,
  file: FileContentResponse,
): {
  line?: number;
  annotations?: NonNullable<ShowFileRequest['annotations']>;
} {
  if (file.kind === 'image') return {};
  const lineCount = Math.max(1, file.content.split(/\r?\n/).length);
  const line =
    request.line !== undefined && request.line <= lineCount
      ? request.line
      : undefined;
  const annotations = request.annotations
    ?.filter((annotation) => {
      const end = annotation.endLine ?? annotation.startLine;
      return (
        annotation.startLine <= lineCount &&
        end >= annotation.startLine &&
        end <= lineCount
      );
    })
    .map((annotation) => ({ ...annotation }));
  return {
    ...(line !== undefined ? { line } : {}),
    ...(annotations?.length ? { annotations } : {}),
  };
}

function buildAnnotations(
  request: NonNullable<ShowFileRequest['annotations']>,
  file: FileContentResponse,
  absolutePath: string,
  repoId: string,
  quoteByteBudget: number,
): {
  annotations: ReviewAnnotation[];
  commentThreads: ReviewCommentThread[];
  quoteBytes: number;
  skipped: number;
} {
  const sourceLines = file.content.split(/\r?\n/);
  const lineBytePrefix = [0];
  let cumulativeLineBytes = 0;
  for (const line of sourceLines) {
    cumulativeLineBytes += utf8ByteLength(line);
    lineBytePrefix.push(cumulativeLineBytes);
  }
  const annotations: ReviewAnnotation[] = [];
  const commentThreads: ReviewCommentThread[] = [];
  let quoteBytes = 0;
  let skipped = 0;
  for (const input of request) {
    const annotationId = crypto.randomUUID();
    const lineEnd = input.endLine ?? input.startLine;
    const title = input.title?.trim() || 'Agent annotation';
    const comment = input.comment?.trim();
    const startIndex = input.startLine - 1;
    const lineBytes =
      (lineBytePrefix[lineEnd] ?? 0) - (lineBytePrefix[startIndex] ?? 0);
    const nextQuoteBytes = comment
      ? lineBytes + Math.max(0, lineEnd - input.startLine)
      : 0;
    if (quoteBytes + nextQuoteBytes > quoteByteBudget) {
      skipped += 1;
      continue;
    }
    const quote = comment
      ? sourceLines.slice(startIndex, lineEnd).join('\n')
      : '';
    quoteBytes += nextQuoteBytes;
    const annotation: ReviewAnnotation = {
      id: annotationId,
      repoId,
      filePath: absolutePath,
      side: 'new',
      lineStart: input.startLine,
      lineEnd,
      kind: 'context',
      title,
      body: comment || title,
    };
    annotations.push(annotation);
    if (comment) {
      const now = new Date().toISOString();
      commentThreads.push({
        id: crypto.randomUUID(),
        status: 'open',
        createdAt: now,
        anchor: {
          source: 'code',
          repoId,
          filePath: absolutePath,
          side: 'new',
          lineStart: input.startLine,
          lineEnd,
          quote,
          annotationId,
        },
        anchorState: 'matched',
        comments: [
          {
            id: crypto.randomUUID(),
            author: 'agent',
            body: comment,
            createdAt: now,
            staged: false,
          },
        ],
      });
    }
  }
  return { annotations, commentThreads, quoteBytes, skipped };
}

/**
 * Main resolves the presentation before the request reaches the renderer.
 * Agent work is also rechecked against the renderer's handoff mirror, so a
 * handoff that started while this request was in flight still wins.
 */
function presentsInBackground(payload: ShowFilesRendererRequest): boolean {
  if (payload.intent === 'user') return false;
  if (payload.presentation === 'background') return true;
  return (
    selectBrowserHandoff(
      useBrowserStore.getState(),
      payload.target.projectId,
      payload.target.worktreeId,
    ) !== null
  );
}

function deferredResult(
  payload: ShowFilesRendererRequest,
): ShowFilesRendererResult {
  return {
    presentation: 'deferred',
    ...(payload.reason ? { reason: payload.reason } : {}),
    opened: 0,
    failed: 0,
    activated: false,
    deferred: payload.files.length,
    files: payload.files.map((file) => ({
      path: file.path,
      ok: true,
      opened: false,
      activated: false,
      deferred: true,
    })),
  };
}

export async function showFilesInRenderer(
  payload: ShowFilesRendererRequest,
  surface: 'main' | 'app-advisor',
  options: { reuseBrowserId?: string } = {},
): Promise<ShowFilesRendererResult> {
  // Main never forwards a deferred request; refuse to open one regardless.
  if (payload.intent !== 'user' && payload.presentation === 'deferred') {
    return deferredResult(payload);
  }
  const { projectId, worktreeId } = payload.target;
  const target = { projectId, worktreeId };
  if (surface === 'app-advisor') {
    if (projectId !== APP_ADVISOR_PROJECT_ID) {
      return {
        opened: 0,
        failed: payload.files.length,
        files: payload.files.map((file) => ({
          path: file.path,
          ok: false,
          error: 'A target project file must be opened in the main window.',
        })),
      };
    }
  }
  if (!useChatStore.getState().worktreeChats[`${projectId}/${worktreeId}`]) {
    await useChatStore.getState().loadTabsForTarget(projectId, worktreeId);
  }

  let roots: Awaited<ReturnType<typeof window.api.getFileTreeRoots>>['roots'];
  try {
    ({ roots } = await window.api.getFileTreeRoots({ projectId, worktreeId }));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Project files are unavailable.';
    return {
      opened: 0,
      failed: payload.files.length,
      files: payload.files.map((file) => ({
        path: file.path,
        ok: false,
        error: message,
      })),
    };
  }

  const opened: Array<{
    request: ShowFileRequest;
    absolutePath: string;
    file: FileContentResponse;
    tabId: string;
  }> = [];
  const pages: Array<{ resultIndex: number; absolutePath: string }> = [];
  const results: ShowFilesRendererResult['files'] = [];
  const originChatTabId =
    payload.origin.projectId === projectId &&
    payload.origin.worktreeId === worktreeId
      ? payload.origin.chatTabId
      : undefined;
  let remainingQuoteBytes = MAX_ANNOTATION_QUOTE_BYTES;

  for (const request of payload.files) {
    let absolutePath: string | null = null;
    if (isAbsolutePath(request.path)) {
      absolutePath = roots.some((root) =>
        pathInsideRoot(request.path, root.absolutePath),
      )
        ? request.path
        : null;
    } else if (roots[0]) {
      const joined = joinRoot(roots[0].absolutePath, request.path);
      absolutePath =
        joined && pathInsideRoot(joined, roots[0].absolutePath) ? joined : null;
    }

    if (!absolutePath) {
      results.push({
        path: request.path,
        ok: false,
        error: 'File is outside the target project or no project root exists.',
      });
      continue;
    }

    let file: FileContentResponse;
    try {
      file = await window.api.readFileContent({
        absolutePath,
        workspaceTarget: payload.target,
      });
    } catch (error) {
      results.push({
        path: request.path,
        ok: false,
        absolutePath,
        error: error instanceof Error ? error.message : 'Unable to read file.',
      });
      continue;
    }
    // Videos, PDFs and Office files read as unsupported text, but the file tab
    // previews them from their bytes.
    const previewsBytes =
      file.kind === 'unsupported' &&
      isRichDocumentRenderKind(resolveFileRenderKind({ path: file.filename }));
    if (
      file.kind === 'missing' ||
      (file.kind === 'unsupported' && !previewsBytes)
    ) {
      results.push({
        path: request.path,
        ok: false,
        absolutePath,
        error:
          file.kind === 'missing'
            ? 'File does not exist.'
            : 'This file type is not supported by the app for opening.',
      });
      continue;
    }

    if (opensInBrowser(request, file)) {
      // Opened after the file panels, below, so the browser can take focus
      // when the page was requested first.
      pages.push({ resultIndex: results.length, absolutePath });
      results.push({
        path: request.path,
        ok: true,
        absolutePath,
        openedIn: 'browser',
      });
      continue;
    }

    const alreadyOpen = useChatStore
      .getState()
      .worktreeChats[
        `${projectId}/${worktreeId}`
      ]?.tabs.some((tab) => tab.kind === 'file' && tab.filePath === absolutePath);
    const tabId = useChatStore.getState().openFileTab(
      {
        absolutePath,
        filename: file.filename,
      },
      target,
      // Agent creation itself never activates. Foreground selection happens
      // after its canonical acknowledgement and a fresh handoff-policy check.
      { activate: payload.intent === 'user' },
    );
    if (!tabId) {
      results.push({
        path: request.path,
        ok: false,
        absolutePath,
        error: 'The target project has no active file-panel surface.',
      });
      continue;
    }
    const cancelPlacement =
      payload.origin.projectId === projectId &&
      payload.origin.worktreeId === worktreeId
        ? requestFilePanelPlacementBesideChat(tabId, payload.origin.chatTabId, {
            activate: !presentsInBackground(payload),
          })
        : undefined;
    const creation = await pendingTabCreation(projectId, worktreeId, tabId);
    if (creation !== undefined && creation !== 'accepted') {
      cancelPlacement?.();
      results.push({
        path: request.path,
        absolutePath,
        ok: false,
        error: 'The file tab could not be created.',
      });
      continue;
    }
    if (
      !settleFilePanelOpen(`${projectId}/${worktreeId}`, tabId, {
        activate: !presentsInBackground(payload),
        originChatTabId,
      })
    ) {
      cancelPlacement?.();
      if (
        !alreadyOpen &&
        useChatStore
          .getState()
          .worktreeChats[
            `${projectId}/${worktreeId}`
          ]?.tabs.some((tab) => tab.id === tabId)
      ) {
        useChatStore.getState().closeTab(tabId, target);
      }
      const selection = useChatStore.getState().selectedWorktree;
      results.push({
        path: request.path,
        absolutePath,
        ok: false,
        error:
          selection?.projectId !== projectId ||
          selection.worktreeId !== worktreeId
            ? 'Open the project to view this file, then try again.'
            : 'The file could not be placed beside the chat. Close a tab and try again.',
      });
      continue;
    }

    if (request.view === 'raw' && file.kind !== 'image') {
      useChatStore.getState().setFileTabViewMode(tabId, 'raw', target);
    } else if (
      (request.view === undefined ||
        request.view === 'rich' ||
        file.kind === 'image') &&
      supportsRichView(file)
    ) {
      useChatStore
        .getState()
        .setFileTabViewMode(
          tabId,
          file.filename.toLowerCase().endsWith('.csv') ? 'table' : 'preview',
          target,
        );
    }
    const presentation = previewsBytes
      ? {}
      : normalizedPresentation(request, file);
    useAgentFilePresentationStore.getState().present(tabId, {
      line: presentation.line,
      origin: payload.origin,
    });
    let warning: string | undefined;
    if (presentation.annotations?.length) {
      const root = roots
        .filter((candidate) =>
          pathInsideRoot(absolutePath, candidate.absolutePath),
        )
        .sort(
          (left, right) => right.absolutePath.length - left.absolutePath.length,
        )[0];
      const appended = buildAnnotations(
        presentation.annotations,
        file,
        absolutePath,
        root?.repoId ?? roots[0]?.repoId ?? 'workspace',
        remainingQuoteBytes,
      );
      remainingQuoteBytes -= appended.quoteBytes;
      if (appended.skipped > 0) {
        warning = `${appended.skipped} annotation${
          appended.skipped === 1 ? '' : 's'
        } skipped because annotation quotes exceed the 256 KiB request limit.`;
      }
      try {
        if (appended.annotations.length > 0) {
          await window.api.fileAnnotations.append({
            projectId,
            worktreeId,
            filePath: absolutePath,
            annotations: appended.annotations,
            commentThreads: appended.commentThreads,
          });
        }
      } catch (error) {
        const appendWarning = `The file opened, but its annotations could not be applied: ${
          error instanceof Error ? error.message : 'unknown error'
        }`;
        warning = warning ? `${warning} ${appendWarning}` : appendWarning;
      }
    }
    opened.push({ request, absolutePath, file, tabId });
    results.push({
      path: request.path,
      ok: true,
      opened: true,
      activated: false,
      absolutePath,
      tabId,
      ...(warning ? { warning } : {}),
    });
  }

  if (opened.length > 0 && originChatTabId !== undefined) {
    placeFilePanelsBesideChat(
      projectId,
      worktreeId,
      opened.map((entry) => entry.tabId),
      originChatTabId,
      { activate: !presentsInBackground(payload) },
    );
  }

  const openedPages: Array<{ resultIndex: number; browserId: string }> = [];
  for (const page of pages) {
    const browserId = await openFileInBrowserPanel(
      projectId,
      worktreeId,
      page.absolutePath,
      {
        originChatTabId,
        focus: false,
        awaitReady: true,
        ...options,
        ...(presentsInBackground(payload) ? { preserveSelection: true } : {}),
      },
    );
    const result = results[page.resultIndex];
    if (browserId !== null) {
      openedPages.push({ resultIndex: page.resultIndex, browserId });
      if (result) {
        result.browserId = browserId;
        result.opened = true;
        result.activated = false;
      }
    } else if (result) {
      results[page.resultIndex] = {
        path: result.path,
        ok: false,
        absolutePath: page.absolutePath,
        error: 'The page could not be opened in the browser.',
      };
    }
  }

  // The first file that opened, in request order, becomes active, unless
  // this is background presentation, rechecked now that the opens settled.
  const firstPage = openedPages[0];
  const firstFile = opened[0];
  const firstFileIndex = firstFile
    ? results.findIndex((entry) => entry.tabId === firstFile.tabId)
    : -1;
  const foreground = !presentsInBackground(payload);
  let activatedIndex = -1;
  if (
    foreground &&
    firstPage &&
    (firstFileIndex === -1 || firstPage.resultIndex < firstFileIndex)
  ) {
    const activated = await requestBrowserPanel(
      projectId,
      worktreeId,
      firstPage.browserId,
      originChatTabId,
      { focus: true, ...(payload.intent === 'user' ? {} : { queue: false }) },
    ).catch(() => false);
    if (activated) activatedIndex = firstPage.resultIndex;
  } else if (foreground && firstFile) {
    useChatStore.getState().switchTab(firstFile.tabId, target);
    activatedIndex = firstFileIndex;
  }
  const activatedResult = results[activatedIndex];
  if (activatedResult) activatedResult.activated = true;

  const openedCount = opened.length + openedPages.length;
  const reason: ShowFilesPresentationReason | undefined =
    payload.reason ?? (foreground ? undefined : 'browser_handoff');
  return {
    presentation: foreground ? 'foreground' : 'background',
    ...(reason ? { reason } : {}),
    activated: activatedResult !== undefined,
    opened: openedCount,
    failed: payload.files.length - openedCount,
    files: results,
  };
}
