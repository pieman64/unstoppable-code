/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspaceAttachmentItem } from '@canopy/desktop-shared/types';

jest.mock('@/components/shared/AttachmentPreviewPopover', () => ({
  AttachmentPreviewPopover: ({
    absolutePath,
    filename,
    sizeBytes,
    createdAt,
  }: {
    absolutePath: string;
    filename?: string;
    sizeBytes?: number;
    createdAt?: string;
  }): JSX.Element => (
    <div data-testid="attachment-preview-popover">
      {filename}:{absolutePath}:{sizeBytes}:{createdAt}
    </div>
  ),
}));

import { useWorkspaceItemsStore } from '@/stores/workspaceItemsStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  ActivitySectionChromeContext,
  type ActivitySectionChrome,
} from '@/components/shared/panel-section';
import { AttachmentsSection } from '../AttachmentsSection';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const ATTACHMENT: WorkspaceAttachmentItem = {
  filename: 'design.png',
  absolutePath: '/workspace/attachments/design.png',
  sizeBytes: 2048,
  createdAt: '2026-07-16T12:00:00.000Z',
};

describe('AttachmentsSection', () => {
  let container: HTMLDivElement;
  let root: Root;
  const initialState = useWorkspaceItemsStore.getState();
  const initialGitHubState = useGitHubStore.getState();
  const importAttachments = jest.fn(() => Promise.resolve([]));
  const addToast = jest.fn();
  const showInFinder = jest.fn(() => Promise.resolve());
  const workspaceItemsApi = {
    importAttachments: jest.fn(),
    listAttachments: jest.fn(() => Promise.resolve([])),
  };
  const getPathForFile = jest.fn((file: File): string =>
    file.name === 'design.fig'
      ? '/Users/example/Desktop/design.fig'
      : 'C:\\Users\\example\\Desktop\\notes.txt',
  );

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useWorkspaceItemsStore.setState({
      attachments: { 'project-1/worktree-1': [ATTACHMENT] },
      loadAttachments: jest.fn(() => Promise.resolve()),
      importAttachments,
    });
    importAttachments.mockClear();
    addToast.mockClear();
    useGitHubStore.setState({ addToast });
    getPathForFile.mockClear();
    showInFinder.mockClear();
    workspaceItemsApi.importAttachments.mockReset();
    workspaceItemsApi.listAttachments.mockClear();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getPathForFile,
        showInFinder,
        workspaceItems: workspaceItemsApi,
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useWorkspaceItemsStore.setState(initialState, true);
    useGitHubStore.setState(initialGitHubState, true);
    jest.useRealTimers();
  });

  function renderSection(chrome: ActivitySectionChrome = 'card'): void {
    act(() => {
      root.render(
        <ActivitySectionChromeContext.Provider value={chrome}>
          <AttachmentsSection projectId="project-1" worktreeId="worktree-1" />
        </ActivitySectionChromeContext.Provider>,
      );
    });
  }

  function dispatchFileDrag(
    target: HTMLElement,
    type: 'dragenter' | 'dragover' | 'drop',
    files: File[],
  ): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files, dropEffect: 'none' },
    });
    target.dispatchEvent(event);
    return event;
  }

  it('opens the file preview popover when an attachment row is hovered', () => {
    renderSection();

    const row = container.querySelector(
      '[data-testid="workspace-attachments-item"]',
    );
    if (!(row instanceof HTMLElement)) {
      throw new Error('Attachment row not found');
    }

    expect(
      container.querySelector('[data-testid="attachment-preview-popover"]'),
    ).toBeNull();

    act(() => {
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      jest.advanceTimersByTime(300);
    });

    expect(
      container.querySelector('[data-testid="attachment-preview-popover"]')
        ?.textContent,
    ).toBe(
      'design.png:/workspace/attachments/design.png:2048:2026-07-16T12:00:00.000Z',
    );
    expect(container.querySelector('[aria-label="Item details"]')).toBeNull();
  });

  it('scopes attachment reveal requests to the active worktree', () => {
    renderSection();

    const reveal = container.querySelector<HTMLButtonElement>(
      '[aria-label="Reveal in Finder"]',
    );
    act(() => {
      reveal?.click();
    });

    expect(showInFinder).toHaveBeenCalledWith({
      absolutePath: ATTACHMENT.absolutePath,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
  });

  it.each<ActivitySectionChrome>(['card', 'frameless'])(
    'advertises file dropping in the empty %s surface',
    (chrome) => {
      useWorkspaceItemsStore.setState({
        attachments: { 'project-1/worktree-1': [] },
      });
      renderSection(chrome);

      expect(
        container.querySelector(
          '[data-testid="workspace-attachments-empty-dropzone"]',
        )?.textContent,
      ).toContain('Drop files here or click + to add attachments');
    },
  );

  it.each<ActivitySectionChrome>(['card', 'frameless'])(
    'accepts native file drops over an already-populated %s surface',
    (chrome) => {
      renderSection(chrome);
      const dropzone = container.querySelector(
        '[data-testid="workspace-attachments-dropzone"]',
      );
      if (!(dropzone instanceof HTMLElement)) {
        throw new Error('Attachments dropzone not found');
      }
      expect(
        container.querySelector('[data-testid="workspace-attachments-item"]'),
      ).not.toBeNull();

      const files = [
        new File(['design'], 'design.fig'),
        new File(['notes'], 'notes.txt'),
      ];
      act(() => {
        dispatchFileDrag(dropzone, 'dragenter', files);
      });
      expect(
        container.querySelector(
          '[data-testid="workspace-attachments-active-dropzone"]',
        )?.textContent,
      ).toContain('Drop files to attach');

      let dropEvent: Event | undefined;
      act(() => {
        dropEvent = dispatchFileDrag(dropzone, 'drop', files);
      });

      expect(dropEvent?.defaultPrevented).toBe(true);
      expect(importAttachments).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        filePaths: [
          '/Users/example/Desktop/design.fig',
          'C:\\Users\\example\\Desktop\\notes.txt',
        ],
      });
    },
  );

  it('reports a file-picker import rejected by the project items API', async () => {
    const importError = new Error('Selected file is no longer available');
    workspaceItemsApi.importAttachments.mockRejectedValueOnce(importError);
    useWorkspaceItemsStore.setState({
      importAttachments: initialState.importAttachments,
    });
    renderSection();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-attachments-import"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workspaceItemsApi.importAttachments).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      filePaths: [],
    });
    expect(addToast).toHaveBeenCalledWith(
      "Couldn't attach that file. It may have moved or become unavailable — try selecting it again.",
      'error',
      undefined,
      { category: 'Chat' },
    );
  });

  it('keeps a cancelled file-picker import silent', async () => {
    workspaceItemsApi.importAttachments.mockResolvedValueOnce({
      attachments: [],
    });
    useWorkspaceItemsStore.setState({
      importAttachments: initialState.importAttachments,
    });
    renderSection();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-attachments-import"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workspaceItemsApi.importAttachments).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      filePaths: [],
    });
    expect(addToast).not.toHaveBeenCalled();
  });

  it('reports a native file drop rejected by the project items API', async () => {
    const importError = new Error('Dropped file is no longer available');
    workspaceItemsApi.importAttachments.mockRejectedValueOnce(importError);
    useWorkspaceItemsStore.setState({
      importAttachments: initialState.importAttachments,
    });
    renderSection();
    const dropzone = container.querySelector(
      '[data-testid="workspace-attachments-dropzone"]',
    );
    if (!(dropzone instanceof HTMLElement)) {
      throw new Error('Attachments dropzone not found');
    }

    await act(async () => {
      dispatchFileDrag(dropzone, 'drop', [new File(['gone'], 'design.fig')]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workspaceItemsApi.importAttachments).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      filePaths: ['/Users/example/Desktop/design.fig'],
    });
    expect(addToast).toHaveBeenCalledWith(
      "Couldn't attach that file. It may have moved or become unavailable — try selecting it again.",
      'error',
      undefined,
      { category: 'Chat' },
    );
  });

  it('reports a dropped file that becomes unavailable before its bytes are read', async () => {
    renderSection();
    const dropzone = container.querySelector(
      '[data-testid="workspace-attachments-dropzone"]',
    );
    if (!(dropzone instanceof HTMLElement)) {
      throw new Error('Attachments dropzone not found');
    }

    const unavailableFile = new File(['gone'], 'moved.png', {
      type: 'image/png',
    });
    Object.defineProperty(unavailableFile, 'arrayBuffer', {
      configurable: true,
      value: jest.fn(() =>
        Promise.reject(
          new DOMException(
            'A requested file or directory could not be found at the time an operation was processed.',
            'NotFoundError',
          ),
        ),
      ),
    });
    getPathForFile.mockImplementationOnce(() => {
      throw new DOMException('No native path', 'NotSupportedError');
    });

    await act(async () => {
      dispatchFileDrag(dropzone, 'drop', [unavailableFile]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(importAttachments).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(
      "Couldn't attach that file. It may have moved or become unavailable — try selecting it again.",
      'error',
      undefined,
      { category: 'Chat' },
    );
  });
});
