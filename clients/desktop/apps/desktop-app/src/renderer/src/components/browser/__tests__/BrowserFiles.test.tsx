/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  BrowserCopyTransfer,
  BrowserUploadTransfer,
  BrowserDownloadTransfer,
  BrowserListTransfersRequest,
  BrowserListTransfersResult,
  BrowserSessionSnapshot,
  BrowserTransferCommand,
  BrowserTransferCommandResult,
} from '@canopy/desktop-shared/types';
import { useBrowserStore } from '@/stores/browserStore';
import { stageBrowserDownload } from '@/lib/browserChatStaging';
import { BrowserAddressBar } from '../BrowserAddressBar';
import { BrowserDownloadNotices } from '../BrowserDownloadNotices';
import { BrowserFileChooserNotice } from '../BrowserFileChooserNotice';
import { BrowserPrintRequestNotice } from '../BrowserPrintRequestNotice';
import { BrowserAuthRequestNotice } from '../BrowserAuthRequestNotice';
import { BrowserSignInDialog } from '../BrowserSignInDialog';
import { BrowserFilesPanel } from '../BrowserFilesPanel';
import { BrowserInspector } from '../BrowserInspector';

jest.mock('@/lib/browserChatStaging', () => ({
  ...jest.requireActual<object>('@/lib/browserChatStaging'),
  stageBrowserDownload: jest.fn().mockResolvedValue(true),
}));

const BROWSER_ID = 'b1';
const MB = 1024 * 1024;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let listTransfers: jest.Mock<
  Promise<BrowserListTransfersResult>,
  [BrowserListTransfersRequest]
>;
let transferCommand: jest.Mock<
  Promise<BrowserTransferCommandResult>,
  [BrowserTransferCommand]
>;
let answerFileChooser: jest.Mock<Promise<{ ok: boolean }>, [unknown]>;
let answerPrintRequest: jest.Mock<Promise<{ ok: boolean }>, [unknown]>;
let answerAuthRequest: jest.Mock<Promise<{ ok: boolean }>, [unknown]>;

function download(
  overrides: Partial<BrowserDownloadTransfer> = {},
): BrowserDownloadTransfer {
  return {
    kind: 'download',
    id: 'download-1',
    browserId: BROWSER_ID,
    source: 'user',
    origin: 'http://localhost:3000/report.csv',
    fileName: 'report.csv',
    receivedBytes: MB,
    totalBytes: 4 * MB,
    status: 'in_progress',
    startedAt: 1,
    ...overrides,
  };
}

function snapshot(): BrowserSessionSnapshot {
  return {
    id: BROWSER_ID,
    projectId: 'p',
    worktreeId: 'w',
    createdAt: 1,
    updatedAt: 2,
    url: 'http://localhost:3000/',
    title: 'Local',
    status: 'ready',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    themeMode: 'light',
    pickMode: false,
    recording: false,
  };
}

function copy(
  overrides: Partial<BrowserCopyTransfer> = {},
): BrowserCopyTransfer {
  return {
    kind: 'copy',
    id: 'copy-1',
    browserId: BROWSER_ID,
    sourceId: 'download-1',
    source: 'agent',
    destinationName: 'exports/report.csv',
    copiedBytes: MB,
    totalBytes: 4 * MB,
    status: 'in_progress',
    startedAt: 2,
    ...overrides,
  };
}

function upload(
  overrides: Partial<BrowserUploadTransfer> = {},
): BrowserUploadTransfer {
  return {
    kind: 'upload',
    id: 'upload-1',
    browserId: BROWSER_ID,
    frameOrigin: 'https://upload.example',
    topOrigin: 'https://upload.example',
    files: [
      {
        name: 'report.csv',
        displayPath: 'exports/report.csv',
        sizeBytes: 4 * MB,
      },
    ],
    stagedBytes: MB,
    totalBytes: 4 * MB,
    status: 'staging',
    startedAt: 3,
    ...overrides,
  };
}

function seedTransfers(
  ...transfers: Array<
    BrowserDownloadTransfer | BrowserCopyTransfer | BrowserUploadTransfer
  >
): void {
  useBrowserStore.setState({ transfers: { [BROWSER_ID]: transfers } });
}

beforeEach(() => {
  listTransfers = jest
    .fn<Promise<BrowserListTransfersResult>, [BrowserListTransfersRequest]>()
    .mockResolvedValue({
      transfers: [],
      total: 0,
      offset: 0,
      limit: 100,
    });
  transferCommand = jest
    .fn<Promise<BrowserTransferCommandResult>, [BrowserTransferCommand]>()
    .mockResolvedValue({ ok: true });
  answerFileChooser = jest
    .fn<Promise<{ ok: boolean }>, [unknown]>()
    .mockResolvedValue({ ok: true });
  answerPrintRequest = jest
    .fn<Promise<{ ok: boolean }>, [unknown]>()
    .mockResolvedValue({ ok: true });
  answerAuthRequest = jest
    .fn<Promise<{ ok: boolean }>, [unknown]>()
    .mockResolvedValue({ ok: true });
  (window as unknown as { api: unknown }).api = {
    browser: {
      listTransfers,
      transferCommand,
      answerFileChooser,
      answerPrintRequest,
      answerAuthRequest,
    },
  };
  useBrowserStore.setState({
    transfers: {},
    blockedDownloads: {},
    downloadToasts: {},
    fileChoosers: {},
    inspectorOpen: {},
    inspectorTab: {},
    consoleEntries: {},
    networkEntries: {},
    diagnosticsSeenAt: {},
  });
});

function mount(node: React.ReactElement): {
  container: HTMLElement;
  root: Root;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  return {
    container,
    root,
    unmount: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function byTestId(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function click(element: Element | null): void {
  if (!(element instanceof HTMLElement)) {
    throw new Error('Expected a clickable element.');
  }
  act(() => {
    element.click();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('BrowserFilesPanel', () => {
  it('points at downloading once the list loads empty', async () => {
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      expect(byTestId(view.container, 'browser-files-panel')).not.toBeNull();
      // Not claimed empty before main has answered.
      expect(byTestId(view.container, 'browser-files-empty')).toBeNull();
      await flush();
      expect(listTransfers).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        limit: 100,
      });
      expect(byTestId(view.container, 'browser-files-empty')?.textContent).toBe(
        'Files you download here appear in this list.',
      );
    } finally {
      view.unmount();
    }
  });

  it('says when the list could not load and retries it', async () => {
    listTransfers.mockRejectedValueOnce(new Error('ipc failed'));
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      await flush();
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
        "Couldn't load downloads.",
      );
      expect(byTestId(view.container, 'browser-files-empty')).toBeNull();
      const retry = Array.from(view.container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Retry',
      );
      click(retry ?? null);
      await flush();
      // Each load reads the newest page, plus the downloads still running.
      expect(
        listTransfers.mock.calls.filter(
          ([request]) => request.status === undefined,
        ),
      ).toHaveLength(2);
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      expect(byTestId(view.container, 'browser-files-empty')).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('shows a running download with its name, size, progress, and status', () => {
    seedTransfers(download());
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      const row = byTestId(view.container, 'browser-transfer-row-download-1');
      expect(row?.getAttribute('aria-label')).toBe('report.csv, Downloading');
      expect(row?.textContent).toContain('report.csv');
      expect(row?.textContent).toContain('Downloading');
      expect(row?.textContent).toContain('1MB of 4MB');
      const progress = row?.querySelector('[role="progressbar"]');
      expect(progress?.getAttribute('aria-valuenow')).toBe('25');
      expect(progress?.getAttribute('aria-label')).toBe(
        'Downloading report.csv',
      );
      expect(byTestId(view.container, 'browser-files-empty')).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('cancels a running download and offers no other action', async () => {
    seedTransfers(download());
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      const cancel = byTestId(
        view.container,
        'browser-transfer-cancel-download-1',
      );
      expect(cancel?.textContent).toBe('Cancel');
      expect(
        byTestId(view.container, 'browser-transfer-show-download-1'),
      ).toBeNull();
      expect(
        byTestId(view.container, 'browser-transfer-resume-download-1'),
      ).toBeNull();
      click(cancel);
      await flush();
      expect(transferCommand).toHaveBeenCalledWith({
        kind: 'cancel',
        browserId: BROWSER_ID,
        transferId: 'download-1',
      });
    } finally {
      view.unmount();
    }
  });

  it('resumes an interrupted download only when it can resume', async () => {
    seedTransfers(
      download({ id: 'resumable', status: 'interrupted', canResume: true }),
      download({ id: 'stuck', status: 'interrupted', canResume: false }),
    );
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      expect(
        byTestId(view.container, 'browser-transfer-resume-stuck'),
      ).toBeNull();
      expect(
        byTestId(view.container, 'browser-transfer-cancel-stuck'),
      ).toBeNull();
      expect(
        byTestId(view.container, 'browser-transfer-cancel-resumable'),
      ).not.toBeNull();
      click(byTestId(view.container, 'browser-transfer-resume-resumable'));
      await flush();
      expect(transferCommand).toHaveBeenCalledWith({
        kind: 'resume',
        browserId: BROWSER_ID,
        transferId: 'resumable',
      });
    } finally {
      view.unmount();
    }
  });

  it('shows a completed download in its folder', async () => {
    seedTransfers(download({ status: 'complete', receivedBytes: 4 * MB }));
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      const row = byTestId(view.container, 'browser-transfer-row-download-1');
      expect(row?.textContent).toContain('Downloaded');
      expect(row?.textContent).toContain('4MB');
      expect(row?.querySelector('[role="progressbar"]')).toBeNull();
      expect(
        byTestId(view.container, 'browser-transfer-cancel-download-1'),
      ).toBeNull();
      const show = byTestId(view.container, 'browser-transfer-show-download-1');
      expect(show?.textContent).toBe('Show in folder');
      click(show);
      await flush();
      expect(transferCommand).toHaveBeenCalledWith({
        kind: 'show',
        browserId: BROWSER_ID,
        transferId: 'download-1',
      });
    } finally {
      view.unmount();
    }
  });

  it('names a disk-full failure', () => {
    seedTransfers(
      download({
        status: 'failed',
        error: { code: 'disk_full', message: 'ENOSPC: no space left' },
      }),
    );
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      const row = byTestId(view.container, 'browser-transfer-row-download-1');
      expect(row?.textContent).toContain('Failed');
      expect(row?.textContent).toContain('Not enough disk space');
      expect(row?.textContent).not.toContain('ENOSPC');
    } finally {
      view.unmount();
    }
  });

  it('reports a command that did not work in the row', async () => {
    transferCommand.mockResolvedValue({
      ok: false,
      error: { code: 'not_resumable', message: 'not resumable' },
    });
    seedTransfers(download({ status: 'interrupted', canResume: true }));
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      click(byTestId(view.container, 'browser-transfer-resume-download-1'));
      await flush();
      const alert = view.container.querySelector('[role="alert"]');
      expect(alert?.textContent).toBe("Couldn't resume this download.");
    } finally {
      view.unmount();
    }
  });

  it('announces a download that stops without finishing', () => {
    seedTransfers(download());
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      const status = view.container.querySelector('[role="status"]');
      expect(status?.textContent).toBe('');
      act(() => {
        useBrowserStore
          .getState()
          .upsertTransfer(BROWSER_ID, download({ status: 'failed' }));
      });
      expect(status?.textContent).toBe('report.csv failed.');
    } finally {
      view.unmount();
    }
  });
});

describe('BrowserFilesPanel copies and attach', () => {
  it('offers Save a copy and Attach to chat on a finished download only', () => {
    seedTransfers(
      download({ status: 'complete', receivedBytes: 4 * MB }),
      download({ id: 'running' }),
    );
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      expect(
        byTestId(view.container, 'browser-transfer-save-copy-download-1')
          ?.textContent,
      ).toBe('Save a copy…');
      expect(
        byTestId(view.container, 'browser-transfer-attach-download-1')
          ?.textContent,
      ).toBe('Attach to chat');
      expect(
        byTestId(view.container, 'browser-transfer-save-copy-running'),
      ).toBeNull();
      expect(
        byTestId(view.container, 'browser-transfer-attach-running'),
      ).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('saves a copy through the save dialog, quietly when it is dismissed', async () => {
    seedTransfers(download({ status: 'complete', receivedBytes: 4 * MB }));
    transferCommand
      .mockResolvedValueOnce({ ok: true, dismissed: true })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'copy_failed', message: 'The copy failed.' },
      });
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      const save = byTestId(
        view.container,
        'browser-transfer-save-copy-download-1',
      );
      click(save);
      await flush();
      expect(transferCommand).toHaveBeenCalledWith({
        kind: 'save_copy',
        browserId: BROWSER_ID,
        transferId: 'download-1',
      });
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      click(save);
      await flush();
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
        "Couldn't save a copy of this file.",
      );
    } finally {
      view.unmount();
    }
  });

  it('attaches a finished download to the chat draft', async () => {
    seedTransfers(download({ status: 'complete', receivedBytes: 4 * MB }));
    transferCommand
      .mockResolvedValueOnce({ ok: true, attachPath: '/host/report.csv' })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'not_found', message: 'gone' },
      });
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      const attach = byTestId(
        view.container,
        'browser-transfer-attach-download-1',
      );
      click(attach);
      await flush();
      await flush();
      expect(transferCommand).toHaveBeenCalledWith({
        kind: 'attach',
        browserId: BROWSER_ID,
        transferId: 'download-1',
      });
      expect(stageBrowserDownload).toHaveBeenCalledWith(
        '/host/report.csv',
        'report.csv',
      );
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      click(attach);
      await flush();
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
        "Couldn't find this file. It may have been moved or deleted.",
      );
    } finally {
      view.unmount();
    }
  });

  it('shows a copy with its progress and Cancel, then how it ended', async () => {
    seedTransfers(copy());
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      const row = byTestId(view.container, 'browser-transfer-row-copy-1');
      expect(row?.getAttribute('aria-label')).toBe(
        'exports/report.csv, Copying',
      );
      expect(row?.textContent).toContain('Copying • 1MB of 4MB');
      expect(row?.querySelector('[role="progressbar"]')).not.toBeNull();
      expect(
        byTestId(view.container, 'browser-transfer-show-copy-1'),
      ).toBeNull();
      click(byTestId(view.container, 'browser-transfer-cancel-copy-1'));
      await flush();
      expect(transferCommand).toHaveBeenCalledWith({
        kind: 'cancel',
        browserId: BROWSER_ID,
        transferId: 'copy-1',
      });
      act(() => {
        useBrowserStore.getState().upsertTransfer(
          BROWSER_ID,
          copy({
            status: 'failed',
            error: {
              code: 'destination_exists',
              message: 'A file with that name already exists.',
            },
          }),
        );
      });
      expect(
        byTestId(view.container, 'browser-transfer-row-copy-1')?.textContent,
      ).toContain('Failed • 1MB of 4MB • A file with that name already exists');
      expect(
        byTestId(view.container, 'browser-transfer-cancel-copy-1'),
      ).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('shows an upload while it is prepared and waits for approval, with Cancel until it is attached', async () => {
    seedTransfers(upload());
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      const row = (): Element | null =>
        byTestId(view.container, 'browser-transfer-row-upload-1');
      expect(row()?.getAttribute('aria-label')).toBe(
        'exports/report.csv, Preparing',
      );
      expect(row()?.textContent).toContain('Preparing • 1MB of 4MB');
      expect(row()?.querySelector('[role="progressbar"]')).not.toBeNull();
      click(byTestId(view.container, 'browser-transfer-cancel-upload-1'));
      await flush();
      expect(transferCommand).toHaveBeenCalledWith({
        kind: 'cancel',
        browserId: BROWSER_ID,
        transferId: 'upload-1',
      });

      act(() => {
        useBrowserStore
          .getState()
          .upsertTransfer(
            BROWSER_ID,
            upload({ status: 'awaiting_approval', stagedBytes: 4 * MB }),
          );
      });
      expect(row()?.textContent).toContain('Waiting for approval • 4MB');
      expect(row()?.querySelector('[role="progressbar"]')).toBeNull();
      expect(
        byTestId(view.container, 'browser-transfer-cancel-upload-1'),
      ).not.toBeNull();

      act(() => {
        useBrowserStore
          .getState()
          .upsertTransfer(
            BROWSER_ID,
            upload({ status: 'attached', stagedBytes: 4 * MB }),
          );
      });
      expect(row()?.textContent).toContain('Attached • 4MB');
      expect(row()?.querySelectorAll('button')).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });

  it('names several files, a denied upload, and a reason worth fixing', () => {
    seedTransfers(
      upload({
        id: 'several',
        status: 'denied',
        files: [
          { name: 'a.csv', displayPath: 'exports/a.csv', sizeBytes: MB },
          { name: 'b.csv', displayPath: 'b.csv', sizeBytes: MB },
          { name: 'c.csv', displayPath: 'c.csv', sizeBytes: 2 * MB },
        ],
      }),
      upload({
        id: 'changed',
        status: 'failed',
        error: { code: 'file_changed', message: 'Changed.' },
      }),
      upload({
        id: 'moved',
        status: 'failed',
        error: { code: 'origin_changed', message: 'Moved.' },
      }),
    );
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      expect(
        byTestId(view.container, 'browser-transfer-row-several')?.getAttribute(
          'aria-label',
        ),
      ).toBe('exports/a.csv and 2 more, Not approved');
      expect(
        byTestId(view.container, 'browser-transfer-row-several')?.textContent,
      ).toContain('Not approved • 4MB');
      expect(
        byTestId(view.container, 'browser-transfer-row-changed')?.textContent,
      ).toContain('Failed • 4MB • A file changed after it was approved');
      expect(
        byTestId(view.container, 'browser-transfer-row-moved')?.textContent,
      ).toContain('Failed • 4MB • The page moved to another site');
    } finally {
      view.unmount();
    }
  });

  it('shows a finished copy as copied, with no file actions', () => {
    seedTransfers(copy({ status: 'complete', copiedBytes: 4 * MB }));
    const view = mount(<BrowserFilesPanel browserId={BROWSER_ID} />);
    try {
      const row = byTestId(view.container, 'browser-transfer-row-copy-1');
      expect(row?.textContent).toContain('Copied • 4MB');
      expect(row?.querySelectorAll('button')).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });
});

describe('BrowserInspector Files tab', () => {
  it('loads the transfer list when the Files tab opens', async () => {
    listTransfers.mockResolvedValue({
      transfers: [download()],
      total: 1,
      offset: 0,
      limit: 100,
    });
    useBrowserStore.setState({
      inspectorOpen: { [BROWSER_ID]: true },
      inspectorTab: {},
    });
    const view = mount(<BrowserInspector browserId={BROWSER_ID} />);
    try {
      const tab = byTestId(view.container, 'browser-inspector-tab-files');
      expect(tab?.getAttribute('role')).toBe('tab');
      expect(tab?.textContent).toBe('Files');
      expect(tab?.getAttribute('aria-selected')).toBe('false');
      expect(listTransfers).not.toHaveBeenCalled();

      click(tab);
      await flush();

      expect(tab?.getAttribute('aria-selected')).toBe('true');
      expect(listTransfers).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        limit: 100,
      });
      expect(
        byTestId(view.container, 'browser-transfer-row-download-1'),
      ).not.toBeNull();
    } finally {
      view.unmount();
    }
  });
});

describe('BrowserInspector tab row', () => {
  it('scrolls the selected tab into view when it changes', () => {
    const scrollIntoView = jest.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const view = mount(<BrowserInspector browserId={BROWSER_ID} />);
    try {
      scrollIntoView.mockClear();
      act(() => {
        useBrowserStore.getState().openFilesPanel(BROWSER_ID);
      });
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(
        byTestId(view.container, 'browser-inspector-tab-files'),
      );
    } finally {
      view.unmount();
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });
});

describe('BrowserAddressBar Downloads button', () => {
  function mountBar(): ReturnType<typeof mount> {
    return mount(
      <BrowserAddressBar
        browserId={BROWSER_ID}
        snapshot={snapshot()}
        inspectorOpen={false}
        errorCount={0}
        onToggleInspector={(): void => undefined}
      />,
    );
  }

  it('opens the Files tab', () => {
    const view = mountBar();
    try {
      const button = byTestId(view.container, 'browser-files-button');
      expect(button?.getAttribute('aria-label')).toBe('Show downloads');
      expect(button?.querySelector('[data-part="arc"]')).toBeNull();
      expect(button?.textContent).toBe('');
      click(button);
      expect(useBrowserStore.getState().inspectorOpen[BROWSER_ID]).toBe(true);
      expect(useBrowserStore.getState().inspectorTab[BROWSER_ID]).toBe('files');
    } finally {
      view.unmount();
    }
  });

  it('shows a count badge and a progress ring while downloads run', () => {
    seedTransfers(
      download({ id: 'a', receivedBytes: MB, totalBytes: 4 * MB }),
      download({ id: 'b', receivedBytes: MB, totalBytes: 4 * MB }),
      download({ id: 'c', status: 'complete' }),
    );
    const view = mountBar();
    try {
      const button = byTestId(view.container, 'browser-files-button');
      expect(button?.getAttribute('aria-label')).toBe(
        'Show downloads, 2 in progress',
      );
      expect(button?.textContent).toBe('2');
      const arc = button?.querySelector('[data-part="arc"]');
      expect(arc).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('counts downloads, not copies or uploads', () => {
    seedTransfers(download({ id: 'a' }), copy(), upload());
    const view = mountBar();
    try {
      expect(
        byTestId(view.container, 'browser-files-button')?.getAttribute(
          'aria-label',
        ),
      ).toBe('Show downloads, 1 in progress');
    } finally {
      view.unmount();
    }
  });

  it('closes the inspector when the Files tab is already showing', () => {
    useBrowserStore.setState({
      inspectorOpen: { [BROWSER_ID]: true },
      inspectorTab: { [BROWSER_ID]: 'files' },
    });
    const view = mount(
      <BrowserAddressBar
        browserId={BROWSER_ID}
        snapshot={snapshot()}
        inspectorOpen
        errorCount={0}
        onToggleInspector={(): void => undefined}
      />,
    );
    try {
      const button = byTestId(view.container, 'browser-files-button');
      expect(button?.getAttribute('aria-label')).toBe('Hide downloads');
      expect(button?.getAttribute('aria-pressed')).toBe('true');
      click(button);
      expect(useBrowserStore.getState().inspectorOpen[BROWSER_ID]).toBe(false);
    } finally {
      view.unmount();
    }
  });
});

describe('BrowserFileChooserNotice', () => {
  const chooser = {
    id: 'chooser-1',
    browserId: BROWSER_ID,
    frameOrigin: 'https://upload.example',
    topOrigin: 'https://app.example',
    multiple: false,
    openedAt: 1,
    expiresAt: 600_001,
  };

  it('renders nothing without a pending chooser', () => {
    const view = mount(<BrowserFileChooserNotice browserId={BROWSER_ID} />);
    try {
      expect(view.container.innerHTML).toBe('');
    } finally {
      view.unmount();
    }
  });

  it('names the site asking for a file and lets the user choose or dismiss', async () => {
    act(() => {
      useBrowserStore.getState().setFileChooser(BROWSER_ID, chooser);
    });
    const view = mount(<BrowserFileChooserNotice browserId={BROWSER_ID} />);
    try {
      const notice = byTestId(
        view.container,
        'browser-pending-surface-file-chooser',
      );
      expect(notice?.textContent).toContain(
        'upload.example is asking for a file',
      );
      const choose = byTestId(view.container, 'browser-file-chooser-choose');
      expect(choose?.textContent).toBe('Choose file…');
      click(choose);
      await flush();
      expect(answerFileChooser).toHaveBeenLastCalledWith({
        browserId: BROWSER_ID,
        chooserId: 'chooser-1',
        answer: 'choose',
      });
      click(byTestId(view.container, 'browser-file-chooser-dismiss'));
      await flush();
      expect(answerFileChooser).toHaveBeenLastCalledWith({
        browserId: BROWSER_ID,
        chooserId: 'chooser-1',
        answer: 'dismiss',
      });
      act(() => {
        useBrowserStore.getState().setFileChooser(BROWSER_ID, null);
      });
      expect(
        byTestId(view.container, 'browser-pending-surface-file-chooser'),
      ).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('asks for files when the input takes several', () => {
    act(() => {
      useBrowserStore
        .getState()
        .setFileChooser(BROWSER_ID, { ...chooser, multiple: true });
    });
    const view = mount(<BrowserFileChooserNotice browserId={BROWSER_ID} />);
    try {
      expect(
        byTestId(view.container, 'browser-pending-surface-file-chooser')
          ?.textContent,
      ).toContain('upload.example is asking for files');
      expect(
        byTestId(view.container, 'browser-file-chooser-choose')?.textContent,
      ).toBe('Choose files…');
    } finally {
      view.unmount();
    }
  });
});

describe('BrowserPrintRequestNotice', () => {
  const request = {
    id: 'print-1',
    browserId: BROWSER_ID,
    frameOrigin: 'https://report.example',
    topOrigin: 'https://app.example',
    openedAt: 1,
    expiresAt: 600_001,
  };

  it('renders nothing without a pending print request', () => {
    const view = mount(<BrowserPrintRequestNotice browserId={BROWSER_ID} />);
    try {
      expect(view.container.innerHTML).toBe('');
    } finally {
      view.unmount();
    }
  });

  it('names the site that wants to print and offers Save as PDF, Print…, and Dismiss', async () => {
    act(() => {
      useBrowserStore.getState().setPrintRequest(BROWSER_ID, request);
    });
    const view = mount(<BrowserPrintRequestNotice browserId={BROWSER_ID} />);
    try {
      expect(
        byTestId(view.container, 'browser-pending-surface-print')?.textContent,
      ).toContain('report.example wants to print this page');
      for (const [testId, answer, label] of [
        ['browser-print-request-save-pdf', 'save_pdf', 'Save as PDF'],
        ['browser-print-request-print', 'print', 'Print…'],
        ['browser-print-request-dismiss', 'dismiss', 'Dismiss'],
      ] as const) {
        const button = byTestId(view.container, testId);
        expect(button?.textContent).toBe(label);
        click(button);
        await flush();
        expect(answerPrintRequest).toHaveBeenLastCalledWith({
          browserId: BROWSER_ID,
          printRequestId: 'print-1',
          answer,
        });
      }
      act(() => {
        useBrowserStore.getState().setPrintRequest(BROWSER_ID, null);
      });
      expect(
        byTestId(view.container, 'browser-pending-surface-print'),
      ).toBeNull();
    } finally {
      view.unmount();
    }
  });
});

describe('BrowserPrintRequestNotice for an opaque frame', () => {
  it('names the page’s site when the frame that asked has no host', () => {
    act(() => {
      useBrowserStore.getState().setPrintRequest(BROWSER_ID, {
        id: 'print-2',
        browserId: BROWSER_ID,
        frameOrigin: '://',
        topOrigin: 'https://app.example',
        openedAt: 1,
        expiresAt: 600_001,
      });
    });
    const view = mount(<BrowserPrintRequestNotice browserId={BROWSER_ID} />);
    try {
      expect(
        byTestId(view.container, 'browser-pending-surface-print')?.textContent,
      ).toContain('app.example wants to print this page');
    } finally {
      view.unmount();
    }
  });
});

describe('BrowserAuthRequestNotice and BrowserSignInDialog', () => {
  const request = {
    id: 'auth-1',
    browserId: BROWSER_ID,
    origin: 'https://intranet.example',
    realm: 'Staff',
    isProxy: false,
    openedAt: 1,
    expiresAt: 300_001,
  };

  it('names the site that needs a sign-in, opens the dialog, and cancels', async () => {
    act(() => {
      useBrowserStore.getState().setAuthRequest(BROWSER_ID, request);
    });
    const onSignIn = jest.fn();
    const view = mount(
      <BrowserAuthRequestNotice browserId={BROWSER_ID} onSignIn={onSignIn} />,
    );
    try {
      expect(
        byTestId(view.container, 'browser-pending-surface-auth')?.textContent,
      ).toContain('intranet.example needs you to sign in');
      const signIn = byTestId(view.container, 'browser-auth-request-sign-in');
      expect(signIn?.textContent).toBe('Sign in…');
      click(signIn);
      expect(onSignIn).toHaveBeenCalled();
      click(byTestId(view.container, 'browser-auth-request-cancel'));
      await flush();
      expect(answerAuthRequest).toHaveBeenLastCalledWith({
        browserId: BROWSER_ID,
        authRequestId: 'auth-1',
        answer: 'cancel',
      });
    } finally {
      view.unmount();
    }
  });

  it('sends the typed credentials once and closes', async () => {
    const onClose = jest.fn();
    const view = mount(
      <BrowserSignInDialog
        browserId={BROWSER_ID}
        request={request}
        onClose={onClose}
      />,
    );
    try {
      const dialog = byTestId(view.container, 'browser-sign-in-dialog');
      expect(dialog?.textContent).toContain('Sign in to intranet.example');
      expect(dialog?.textContent).toContain('“Staff”');
      const type = (testId: string, value: string): void => {
        const input = byTestId(view.container, testId);
        if (!(input instanceof HTMLInputElement)) throw new Error(testId);
        act(() => {
          const descriptor = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          );
          descriptor?.set?.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      };
      type('browser-sign-in-username', 'ada');
      type('browser-sign-in-password', 'secret-7Q4M');
      const password = byTestId(view.container, 'browser-sign-in-password');
      expect(password?.getAttribute('type')).toBe('password');
      click(byTestId(view.container, 'browser-sign-in-submit'));
      await flush();
      expect(answerAuthRequest).toHaveBeenCalledTimes(1);
      expect(answerAuthRequest).toHaveBeenLastCalledWith({
        browserId: BROWSER_ID,
        authRequestId: 'auth-1',
        answer: 'sign_in',
        username: 'ada',
        password: 'secret-7Q4M',
      });
      expect(onClose).toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it('keeps Tab and Shift+Tab inside the dialog, including from the pane behind it', () => {
    const view = mount(
      <div>
        <button type="button" data-testid="pane-control">
          Back
        </button>
        <BrowserSignInDialog
          browserId={BROWSER_ID}
          request={request}
          onClose={jest.fn()}
        />
      </div>,
    );
    try {
      const element = (testId: string): HTMLElement => {
        const found = byTestId(view.container, testId);
        if (!(found instanceof HTMLElement)) throw new Error(testId);
        return found;
      };
      const tab = (shiftKey = false): void => {
        act(() => {
          document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Tab',
              shiftKey,
              bubbles: true,
            }),
          );
        });
      };
      act(() => element('browser-sign-in-submit').focus());
      tab();
      expect(document.activeElement).toBe(element('browser-sign-in-username'));
      tab(true);
      expect(document.activeElement).toBe(element('browser-sign-in-submit'));
      act(() => element('pane-control').focus());
      tab();
      expect(document.activeElement).toBe(element('browser-sign-in-username'));
    } finally {
      view.unmount();
    }
  });

  it('closes on Escape without answering, so the sign-in stays pending', () => {
    const onClose = jest.fn();
    const view = mount(
      <BrowserSignInDialog
        browserId={BROWSER_ID}
        request={request}
        onClose={onClose}
      />,
    );
    try {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(onClose).toHaveBeenCalled();
      expect(answerAuthRequest).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });
});

describe('BrowserDownloadNotices', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders nothing when there is nothing to announce', () => {
    const view = mount(<BrowserDownloadNotices browserId={BROWSER_ID} />);
    try {
      expect(view.container.innerHTML).toBe('');
    } finally {
      view.unmount();
    }
  });

  it('announces a finished download with a Show action', async () => {
    act(() => {
      useBrowserStore.getState().upsertTransfer(BROWSER_ID, download());
      useBrowserStore
        .getState()
        .upsertTransfer(BROWSER_ID, download({ status: 'complete' }));
    });
    const view = mount(<BrowserDownloadNotices browserId={BROWSER_ID} />);
    try {
      const toast = byTestId(view.container, 'browser-download-toast');
      expect(toast?.getAttribute('role')).toBe('status');
      expect(toast?.textContent).toContain('Downloaded report.csv');
      const show = Array.from(toast?.querySelectorAll('button') ?? []).find(
        (button) => button.textContent === 'Show',
      );
      click(show ?? null);
      await flush();
      expect(transferCommand).toHaveBeenCalledWith({
        kind: 'show',
        browserId: BROWSER_ID,
        transferId: 'download-1',
      });
      click(
        toast?.querySelector('[aria-label="Dismiss download notice"]') ?? null,
      );
      expect(byTestId(view.container, 'browser-download-toast')).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('dismisses the download toast on its own after a while', () => {
    jest.useFakeTimers();
    act(() => {
      useBrowserStore
        .getState()
        .upsertTransfer(BROWSER_ID, download({ status: 'complete' }));
    });
    const view = mount(<BrowserDownloadNotices browserId={BROWSER_ID} />);
    try {
      expect(byTestId(view.container, 'browser-download-toast')).not.toBeNull();
      act(() => {
        jest.advanceTimersByTime(15_000);
      });
      expect(byTestId(view.container, 'browser-download-toast')).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('offers Allow more downloads once for blocked downloads', async () => {
    act(() => {
      useBrowserStore.getState().noteDownloadsBlocked(BROWSER_ID, 1);
      useBrowserStore.getState().noteDownloadsBlocked(BROWSER_ID, 1);
    });
    const view = mount(<BrowserDownloadNotices browserId={BROWSER_ID} />);
    try {
      const allowMore = view.container.querySelectorAll(
        '[data-testid="browser-files-allow-more"]',
      );
      expect(allowMore).toHaveLength(1);
      expect(allowMore[0]?.textContent).toBe('Allow more downloads');
      click(allowMore[0] ?? null);
      await flush();
      expect(transferCommand).toHaveBeenCalledWith({
        kind: 'allow_more',
        browserId: BROWSER_ID,
      });
      expect(byTestId(view.container, 'browser-files-allow-more')).toBeNull();
    } finally {
      view.unmount();
    }
  });
});
