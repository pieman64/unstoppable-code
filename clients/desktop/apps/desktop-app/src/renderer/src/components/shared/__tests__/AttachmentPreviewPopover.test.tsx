/**
 * @jest-environment jsdom
 */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { AttachmentPreviewPopover } from '../AttachmentPreviewPopover';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function findOpenButton(): HTMLButtonElement {
  const openButton = Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === 'Open',
  );
  if (!(openButton instanceof HTMLButtonElement)) {
    throw new Error('Open action not found');
  }
  return openButton;
}

describe('AttachmentPreviewPopover', () => {
  let container: HTMLDivElement;
  let root: Root;
  const openFileTab = jest.fn(() => 'file-tab-1');
  const addToast = jest.fn();
  const openExternalFile = jest.fn(() => Promise.resolve());
  const originalOpenFileTab = useChatStore.getState().openFileTab;
  const originalAddToast = useGitHubStore.getState().addToast;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    openFileTab.mockClear();
    addToast.mockClear();
    openExternalFile.mockClear();
    openExternalFile.mockImplementation(() => Promise.resolve());
    useChatStore.setState({ openFileTab });
    useGitHubStore.setState({ addToast });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        openExternalFile,
        readFilePreview: jest.fn(() =>
          Promise.resolve({
            kind: 'image',
            content: 'data:image/png;base64,preview',
            filename: 'design.png',
            sizeBytes: 2048,
            truncated: false,
            modifiedAtMs: 1,
          }),
        ),
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useChatStore.setState({ openFileTab: originalOpenFileTab });
    useGitHubStore.setState({ addToast: originalAddToast });
  });

  it('blocks the portaled attachment preview body, keeping its name and actions recorded', async () => {
    const anchorRef = createRef<HTMLButtonElement>();

    await act(async () => {
      root.render(
        <>
          <button ref={anchorRef} type="button">
            Attachment
          </button>
          <AttachmentPreviewPopover
            absolutePath="/workspace/attachments/design.png"
            filename="design.png"
            anchorRef={anchorRef}
            onMouseEnter={jest.fn()}
            onMouseLeave={jest.fn()}
          />
        </>,
      );
      await Promise.resolve();
    });

    const popover = document.body.querySelector(
      ':scope > [data-canopy-browser-native-overlay="true"]',
    );
    expect(popover?.textContent).toContain('design.png');
    expect(popover?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    const blocks = popover?.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`);
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0].getAttribute('data-testid')).toBe(
      'attachment-preview-body',
    );
    expect(blocks?.[0].textContent).not.toContain('design.png');
    expect(
      findOpenButton().closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });

  it('shows attachment metadata and opens the file in the system default application', async () => {
    const anchorRef = createRef<HTMLButtonElement>();
    const createdAt = '2026-07-16T12:00:00.000Z';

    await act(async () => {
      root.render(
        <>
          <button ref={anchorRef} type="button">
            Attachment
          </button>
          <AttachmentPreviewPopover
            absolutePath="/workspace/attachments/design.png"
            filename="design.png"
            sizeBytes={2048}
            createdAt={createdAt}
            anchorRef={anchorRef}
            onMouseEnter={jest.fn()}
            onMouseLeave={jest.fn()}
          />
        </>,
      );
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('2.0 KB');
    expect(document.body.textContent).toContain(
      `Created ${new Date(createdAt).toLocaleString()}`,
    );

    await act(async () => {
      findOpenButton().click();
      await Promise.resolve();
    });

    // CAN-2707: the New Task screen has no selected worktree, so the old
    // `openFileTab` path resolved to null and the button was inert. Opening
    // in the system default application works from every surface.
    expect(openExternalFile).toHaveBeenCalledWith({
      absolutePath: '/workspace/attachments/design.png',
    });
    expect(openFileTab).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Show in');
  });

  it('surfaces an error toast when the file cannot be opened', async () => {
    const anchorRef = createRef<HTMLButtonElement>();
    openExternalFile.mockImplementation(() =>
      Promise.reject(new Error('ENOENT')),
    );

    await act(async () => {
      root.render(
        <>
          <button ref={anchorRef} type="button">
            Attachment
          </button>
          <AttachmentPreviewPopover
            absolutePath="/workspace/attachments/design.png"
            filename="design.png"
            anchorRef={anchorRef}
            onMouseEnter={jest.fn()}
            onMouseLeave={jest.fn()}
          />
        </>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      findOpenButton().click();
      await Promise.resolve();
    });

    expect(addToast).toHaveBeenCalledWith(
      "Couldn't open design.png.",
      'error',
      undefined,
      { forceInApp: true },
    );
  });

  it('uses a caller-provided full-view action for archived attachments', async () => {
    const anchorRef = createRef<HTMLButtonElement>();
    const onOpen = jest.fn();

    await act(async () => {
      root.render(
        <>
          <button ref={anchorRef} type="button">
            Attachment
          </button>
          <AttachmentPreviewPopover
            absolutePath="/archive/attachments/design.png"
            filename="design.png"
            anchorRef={anchorRef}
            onOpen={onOpen}
            onMouseEnter={jest.fn()}
            onMouseLeave={jest.fn()}
          />
        </>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      findOpenButton().click();
      await Promise.resolve();
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(openExternalFile).not.toHaveBeenCalled();
    expect(openFileTab).not.toHaveBeenCalled();
  });
});
