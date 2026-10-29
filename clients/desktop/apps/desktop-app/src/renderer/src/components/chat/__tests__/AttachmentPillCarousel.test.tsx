/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AttachmentMeta,
  FilePreviewResponse,
} from '@canopy/desktop-shared/types';

import { AttachmentPillCarousel } from '../AttachmentPillCarousel';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function attachment(filename: string): AttachmentMeta {
  return { filename, absolutePath: `/tmp/attachments/${filename}` };
}

function preview(
  kind: FilePreviewResponse['kind'],
  content: string,
  filename: string,
): FilePreviewResponse {
  return {
    kind,
    content,
    filename,
    sizeBytes: 10,
    truncated: false,
    modifiedAtMs: 0,
  };
}

const PREVIEWS: Record<string, FilePreviewResponse> = {
  '/tmp/attachments/ci-failure.png': preview(
    'image',
    'data:image/png;base64,iVBORw0KGgo=',
    'ci-failure.png',
  ),
  '/tmp/attachments/upload-test.log': preview(
    'text',
    'FAIL src/upload/uploader.test.ts',
    'upload-test.log',
  ),
  '/tmp/attachments/Xcode_27.1_beta.xip': preview(
    'unsupported',
    '',
    'Xcode_27.1_beta.xip',
  ),
};

describe('AttachmentPillCarousel', () => {
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
    readFilePreview.mockClear();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { readFilePreview },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderStrip(
    attachments: AttachmentMeta[],
    onRemove = jest.fn(),
  ): Promise<void> {
    await act(async () => {
      root.render(
        <AttachmentPillCarousel
          attachments={attachments}
          onRemove={onRemove}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('shows an image as a square thumbnail and other files as named cards', async () => {
    await renderStrip([
      attachment('ci-failure.png'),
      attachment('upload-test.log'),
      attachment('Xcode_27.1_beta.xip'),
    ]);
    const tiles = Array.from(
      container.querySelectorAll('[data-attachment-kind]'),
    );
    expect(
      tiles.map((tile) => tile.getAttribute('data-attachment-kind')),
    ).toEqual(['image', 'file', 'file']);

    const [image, log, archive] = tiles;
    expect(image?.classList.contains('h-30')).toBe(true);
    expect(image?.classList.contains('w-30')).toBe(true);
    expect(image?.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
    // The thumbnail's 1px edge (black in light, white in dark, at 16%) is
    // drawn over the picture, after it, so a dark or pale image still ends
    // on a line.
    const edge = image?.lastElementChild;
    expect(edge?.getAttribute('data-testid')).toBe('attachment-image-edge');
    expect(edge?.previousElementSibling?.tagName).toBe('IMG');
    for (const cls of [
      'absolute',
      'inset-0',
      'inset-ring',
      'inset-ring-fg-primary/16',
    ]) {
      expect(edge?.classList.contains(cls)).toBe(true);
    }
    // Every other tile draws the same edge as the image beside it.
    for (const tile of [log, archive]) {
      expect(tile?.classList.contains('inset-ring')).toBe(true);
      expect(tile?.classList.contains('inset-ring-fg-primary/16')).toBe(true);
    }
    // A text file shows its first lines above its name.
    expect(log?.querySelector('.font-mono')?.textContent).toBe(
      'FAIL src/upload/uploader.test.ts',
    );
    expect(log?.textContent).toContain('upload-test.log');
    // A file with no preview shows its type's icon above its name.
    expect(archive?.querySelector('.font-mono')).toBeNull();
    expect(archive?.textContent).toContain('Xcode_27.1_beta.xip');
  });

  it('leads the strip with the tiles it is given (code selections)', async () => {
    await act(async () => {
      root.render(
        <AttachmentPillCarousel
          leading={<span data-testid="selection-tile" />}
          attachments={[attachment('upload-test.log')]}
          onRemove={jest.fn()}
        />,
      );
      await Promise.resolve();
    });
    const strip = container.querySelector('[data-testid="attachment-strip"]');
    expect(strip?.firstElementChild?.getAttribute('data-testid')).toBe(
      'selection-tile',
    );
  });

  it('scrolls sideways through the tiles', async () => {
    await renderStrip([attachment('ci-failure.png')]);
    const strip = container.querySelector('[data-testid="attachment-strip"]');
    expect(strip?.classList.contains('overflow-x-auto')).toBe(true);
    expect(strip?.classList.contains('flex')).toBe(true);
  });

  it('removes a tile from the corner button that hover reveals', async () => {
    const onRemove = jest.fn();
    await renderStrip([attachment('upload-test.log')], onRemove);
    const remove = container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove upload-test.log"]',
    );
    expect(remove?.classList.contains('opacity-0')).toBe(true);
    expect(remove?.classList.contains('group-hover:opacity-100')).toBe(true);
    expect(remove?.classList.contains('focus-visible:opacity-100')).toBe(true);
    act(() => remove?.click());
    expect(onRemove).toHaveBeenCalledWith('/tmp/attachments/upload-test.log');
  });

  it('names a Linear ticket with the Linear logo without reading it', async () => {
    await renderStrip([
      {
        filename: 'linear-can-202.md',
        absolutePath: '/tmp/attachments/linear-can-202.md',
        promptKind: 'linear-ticket',
      },
    ]);
    expect(container.textContent).toContain('linear-can-202.md');
    expect(container.innerHTML).toContain('viewBox="0 0 100 100"');
    expect(readFilePreview).not.toHaveBeenCalled();
  });

  it('renders on the server before any preview loads', () => {
    const html = renderToStaticMarkup(
      <AttachmentPillCarousel
        attachments={[attachment('notes.txt')]}
        onRemove={jest.fn()}
      />,
    );
    expect(html).toContain('notes.txt');
    expect(html).toContain('data-attachment-kind="file"');
  });
});
