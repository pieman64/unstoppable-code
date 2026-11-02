/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { DiffViewerSession, FileViewerState } from '@canopy/app-state';
import type { PortalDiffReadPayload } from '@canopy/protocol/portal';

let mockState: FileViewerState;
// Per-target capabilities the viewer gates on (REG-3024); empty = defaults.
let mockCapabilities: { readonly wholeWorktreeDiff?: boolean } = {};
jest.mock('@canopy/app-state', () => {
  const real: Record<string, unknown> = jest.requireActual('@canopy/app-state');
  return {
    __esModule: true,
    ...real,
    useFileViewerStore: <T,>(selector: (state: FileViewerState) => T): T =>
      selector(mockState),
    useWorkspaceCapabilities: (): { readonly wholeWorktreeDiff?: boolean } =>
      mockCapabilities,
  };
});

import { diffViewerKey } from '@canopy/app-state';
import { DiffViewer } from '../DiffViewer';

const REQUEST: PortalDiffReadPayload = {
  workspaceId: 'w1',
  worktreeId: 'wt1',
  source: 'combined',
};

function baseState(diff: DiffViewerSession | undefined): FileViewerState {
  const key = diffViewerKey(REQUEST);
  return {
    files: {},
    diffs: diff ? { [key]: diff } : {},
    activeFileKey: null,
    activeDiffKey: diff ? key : null,
    canEdit: true,
    openFile: (): Promise<string> => Promise.resolve(''),
    updateContent: (): void => {},
    saveFile: (): Promise<boolean> => Promise.resolve(true),
    discardEdits: (): void => {},
    setViewMode: (): void => {},
    closeFile: (): void => {},
    openDiff: (): Promise<string> => Promise.resolve(key),
    closeDiff: (): void => {},
    refreshFile: (): Promise<void> => Promise.resolve(),
    markFileChanged: (): void => {},
    reloadFromDisk: (): Promise<boolean> => Promise.resolve(false),
    dismissExternalChange: (): void => {},
    overwriteWithEdits: (): Promise<boolean> => Promise.resolve(false),
    chooseOverlapVersion: (): void => {},
    notifyFileChanged: (): void => {},
  };
}

const PATCH = ['@@ -1 +1 @@', '-old', '+new'].join('\n');

function loadedDiff(): DiffViewerSession {
  return {
    key: diffViewerKey(REQUEST),
    request: REQUEST,
    diff: {
      workspaceLocalId: 'w1',
      worktreeLocalId: 'wt1',
      files: [
        { filePath: 'src/a.ts', status: 'M', insertions: 1, deletions: 1 },
        { filePath: 'src/b.ts', status: 'A' },
      ],
      patch: PATCH,
      rangeLabel: 'abc..WORKTREE',
    },
    status: 'idle',
    error: null,
  };
}

describe('DiffViewer', () => {
  it('shows a loading placeholder before the diff resolves', () => {
    mockState = baseState(undefined);
    const out = renderToString(<DiffViewer request={REQUEST} />);
    expect(out).not.toContain('data-testid="diff-viewer"');
  });

  it('renders the file tree and the unified patch', () => {
    mockState = baseState(loadedDiff());
    const out = renderToString(<DiffViewer request={REQUEST} />);
    expect(out).toContain('data-testid="diff-viewer"');
    expect(out).toContain('data-testid="file-unified-diff"');
    expect(out).toContain('data-testid="diff-viewer-layout"');
    // Files group under a directory heading and rows drop the redundant
    // prefix (CAN-2517).
    expect(out).toContain('>src<');
    expect(out).toContain('>a.ts<');
    expect(out).toContain('>b.ts<');
  });

  it('renders an error state when the diff read fails', () => {
    mockState = baseState({
      key: diffViewerKey(REQUEST),
      request: REQUEST,
      diff: null,
      status: 'error',
      error: 'diff boom',
    });
    const out = renderToString(<DiffViewer request={REQUEST} />);
    expect(out).toContain('data-testid="diff-error"');
    expect(out).toContain('diff boom');
  });

  it('renders the empty-state when there is no patch text', () => {
    mockState = baseState({
      key: diffViewerKey(REQUEST),
      request: REQUEST,
      diff: {
        workspaceLocalId: 'w1',
        worktreeLocalId: 'wt1',
        files: [],
        patch: '',
      },
      status: 'idle',
      error: null,
    });
    const out = renderToString(<DiffViewer request={REQUEST} />);
    expect(out).toContain('No textual changes to display.');
  });
});

describe('DiffViewer bounded responses (REG-3024)', () => {
  function withDiff(
    extra: Partial<NonNullable<DiffViewerSession['diff']>>,
  ): FileViewerState {
    const session = loadedDiff();
    return baseState({
      ...session,
      diff: session.diff === null ? null : { ...session.diff, ...extra },
    });
  }

  it('renders no notice when the producer reports no bounds', () => {
    mockState = baseState(loadedDiff());
    const out = renderToString(<DiffViewer request={REQUEST} />);
    expect(out).not.toContain('diff-viewer-notice');
  });

  it('says an oversized patch is cut and still shows its beginning', () => {
    mockState = withDiff({ oversized: true });
    const out = renderToString(<DiffViewer request={REQUEST} />).replace(
      /<!-- -->/g,
      '',
    );
    expect(out).toContain('data-testid="diff-viewer-notice-oversized"');
    // The shared inline Notice (DESIGN.md), not a bare line.
    expect(out).toMatch(
      /data-notice-intent="neutral"[^>]*data-testid="diff-viewer-notice-oversized"|data-testid="diff-viewer-notice-oversized"[^>]*data-notice-intent="neutral"/,
    );
    expect(out).toContain(
      'This diff is too large to show in full. Showing the beginning.',
    );
    expect(out).toContain('data-testid="file-unified-diff"');
  });

  it('replaces the patch of a binary file with an explanation', () => {
    mockState = withDiff({ binary: true, patch: '' });
    const out = renderToString(<DiffViewer request={REQUEST} />);
    expect(out).toContain('data-testid="diff-viewer-notice-binary"');
    // No layout toggle for a patch with no text.
    expect(out).not.toContain('data-testid="diff-viewer-layout"');
    expect(out).toContain('Binary file. There is no text diff to show.');
    expect(out).not.toContain('No textual changes to display.');
  });

  it('says when the file list is incomplete', () => {
    mockState = withDiff({ truncated: true });
    const out = renderToString(<DiffViewer request={REQUEST} />);
    expect(out).toContain('data-testid="diff-viewer-notice-truncated"');
    expect(out).toContain('Not every changed file is listed.');
  });
});

describe('DiffViewer whole-worktree capability (REG-3024)', () => {
  afterEach(() => {
    mockCapabilities = {};
  });

  function renderClient(openDiff: jest.Mock): HTMLDivElement {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    mockState = { ...baseState(undefined), openDiff };
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(<DiffViewer request={REQUEST} />);
    });
    return container;
  }

  it('asks for a file instead of reading when the target serves no whole-worktree diff', () => {
    mockCapabilities = { wholeWorktreeDiff: false };
    const openDiff = jest.fn(() => Promise.resolve(''));
    const container = renderClient(openDiff);
    const gated = container.querySelector(
      '[data-testid="diff-viewer-select-file"]',
    );
    expect(gated?.textContent).toBe('Select a file to see its diff.');
    // A gated state, not an error.
    expect(container.querySelector('[data-testid="diff-error"]')).toBeNull();
    expect(openDiff).not.toHaveBeenCalled();
  });

  it('reads the whole-worktree diff where the target serves it', () => {
    const openDiff = jest.fn(() => Promise.resolve(''));
    renderClient(openDiff);
    expect(openDiff).toHaveBeenCalledWith(REQUEST);
  });

  it('reads a single file even where whole-worktree diffs are not served', () => {
    mockCapabilities = { wholeWorktreeDiff: false };
    const openDiff = jest.fn(() => Promise.resolve(''));
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const request = { ...REQUEST, path: 'src/a.ts' };
    mockState = { ...baseState(undefined), openDiff };
    const root = createRoot(document.createElement('div'));
    act(() => {
      root.render(<DiffViewer request={request} />);
    });
    expect(openDiff).toHaveBeenCalledWith(request);
  });
});
