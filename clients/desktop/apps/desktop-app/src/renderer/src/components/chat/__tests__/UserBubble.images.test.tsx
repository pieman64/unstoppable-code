/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FilePreviewResponse } from '@canopy/desktop-shared/types';
import { UserBubble } from '../UserBubble';
import type { DisplayMessage } from '../types';

jest.mock('@/lib/terminal-instances', () => ({
  getOrCreateInstance: jest.fn(),
  peekInstance: jest.fn(() => undefined),
  TERMINAL_BG_COLOR: '#0b0c10',
}));
jest.mock('@xterm/xterm', () => ({ Terminal: jest.fn() }));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: jest.fn() }));

let mockEarlyAccess = true;
jest.mock('@/stores/labsExperimentsStore', () => ({
  useLabsExperimentEnabled: (): boolean => mockEarlyAccess,
}));

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function preview(
  kind: FilePreviewResponse['kind'],
  content: string,
): FilePreviewResponse {
  return {
    kind,
    content,
    filename: 'file',
    sizeBytes: 1,
    truncated: false,
    modifiedAtMs: 1,
  };
}

const PREVIEWS: Record<string, FilePreviewResponse> = {
  '/tmp/attachments/shot.png': preview('image', 'data:image/png;base64,AAAA'),
  // Over the preview handler's 5 MB image cap.
  '/tmp/attachments/huge.png': preview('unsupported', ''),
};

describe('UserBubble sent images (early access)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const readFilePreview = jest.fn(
    ({ absolutePath }: { absolutePath: string }) => {
      const result = PREVIEWS[absolutePath];
      return result
        ? Promise.resolve(result)
        : Promise.reject(new Error('missing'));
    },
  );

  beforeEach(() => {
    mockEarlyAccess = true;
    globalThis.ResizeObserver = TestResizeObserver;
    readFilePreview.mockClear();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { readFilePreview, openExternalFile: jest.fn() },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderBubble(attachmentPaths: string[]): Promise<void> {
    const message: DisplayMessage = {
      id: 'user-images',
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'see the references' }],
      attachmentPaths,
    };
    await act(async () => {
      root.render(<UserBubble message={message} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function tileNames(): string[] {
    return Array.from(
      container.querySelectorAll('[data-testid="message-image-attachment"]'),
    ).map((tile) => tile.getAttribute('title') ?? '');
  }

  function chipText(): string {
    return Array.from(
      container.querySelectorAll('[data-testid="file-attachment-chip"]'),
    )
      .map((chip) => chip.textContent ?? '')
      .join(' ');
  }

  it('draws a loaded image inside the bubble', async () => {
    await renderBubble(['/tmp/attachments/shot.png']);

    expect(tileNames()).toEqual(['shot.png']);
    expect(
      container
        .querySelector('[data-testid="message-image-attachment"] img')
        ?.getAttribute('src'),
    ).toBe('data:image/png;base64,AAAA');
    expect(chipText()).toBe('');
  });

  it('keeps a HEIC image a file chip instead of a blank tile', async () => {
    await renderBubble(['/tmp/attachments/photo.heic']);

    expect(tileNames()).toEqual([]);
    expect(chipText()).toContain('photo.heic');
    expect(readFilePreview).not.toHaveBeenCalled();
  });

  it('falls back to a file chip when the image is too large to preview', async () => {
    await renderBubble([
      '/tmp/attachments/shot.png',
      '/tmp/attachments/huge.png',
    ]);

    expect(tileNames()).toEqual(['shot.png']);
    expect(chipText()).toContain('huge.png');
    expect(chipText()).not.toContain('shot.png');
  });

  it('falls back to a file chip when the preview cannot be read', async () => {
    await renderBubble(['/tmp/attachments/gone.png']);

    expect(tileNames()).toEqual([]);
    expect(chipText()).toContain('gone.png');
  });

  it('loads image previews even with a retired false choice', async () => {
    mockEarlyAccess = false;
    await renderBubble(['/tmp/attachments/shot.png']);

    expect(tileNames()).toEqual(['shot.png']);
    expect(chipText()).not.toContain('shot.png');
    expect(readFilePreview).toHaveBeenCalled();
  });
});
