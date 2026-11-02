/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FileViewerState } from '@canopy/app-state';
import type { PortalFileReadPayload } from '@canopy/protocol/portal';

let mockState: FileViewerState;
jest.mock('@canopy/app-state', () => {
  const real: Record<string, unknown> = jest.requireActual('@canopy/app-state');
  return {
    __esModule: true,
    ...real,
    useFileViewerStore: <T,>(selector: (state: FileViewerState) => T): T =>
      selector(mockState),
  };
});

import { fileViewerKey } from '@canopy/app-state';
import { FileViewer } from '../FileViewer';

const REQUEST: PortalFileReadPayload = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  relativePath: 'assets/logo.png',
};

function emptyState(): FileViewerState {
  return {
    files: {},
    diffs: {},
    activeFileKey: null,
    activeDiffKey: null,
    canEdit: true,
    openFile: (): Promise<string> => Promise.resolve(fileViewerKey(REQUEST)),
    updateContent: (): void => {},
    saveFile: (): Promise<boolean> => Promise.resolve(true),
    discardEdits: (): void => {},
    setViewMode: (): void => {},
    closeFile: (): void => {},
    openDiff: (): Promise<string> => Promise.resolve(''),
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

describe('FileViewer image retry', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mockState = emptyState();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('re-runs the resolver when the host advances the retry generation', async () => {
    const resolveImageSrc = jest
      .fn<Promise<string | null>, [PortalFileReadPayload]>()
      .mockResolvedValue('data:image/png;base64,abc');

    await act(async () => {
      root.render(
        <FileViewer
          request={REQUEST}
          resolveImageSrc={resolveImageSrc}
          imageRetryGeneration={0}
        />,
      );
      await Promise.resolve();
    });
    expect(resolveImageSrc).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <FileViewer
          request={REQUEST}
          resolveImageSrc={resolveImageSrc}
          imageRetryGeneration={0}
        />,
      );
      await Promise.resolve();
    });
    expect(resolveImageSrc).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <FileViewer
          request={REQUEST}
          resolveImageSrc={resolveImageSrc}
          imageRetryGeneration={1}
        />,
      );
      await Promise.resolve();
    });
    expect(resolveImageSrc).toHaveBeenCalledTimes(2);
  });
});
