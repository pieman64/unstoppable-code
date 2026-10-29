/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { DiffContentView } from '../DiffContentView';
import { rootClassList } from '@/test-utils/replay';

jest.mock('react-diff-viewer-continued', () => ({
  __esModule: true,
  default: (): null => null,
  DiffMethod: { LINES: 'LINES' },
}));

describe('DiffContentView', () => {
  it('renders the available old image in unified mode when current image data is absent', (): void => {
    const markup = renderToStaticMarkup(
      <DiffContentView
        oldValue=""
        newValue=""
        viewMode="unified"
        loading={false}
        truncated={false}
        binary
        imagePreview={{ oldDataUrl: 'data:image/png;base64,AQID' }}
      />,
    );

    expect(markup).toContain('Previous');
    expect(markup).toContain('src="data:image/png;base64,AQID"');
    expect(markup).not.toContain('Image unavailable');
  });

  describe('session replay', () => {
    it('blocks the text diff root from session replay', async (): Promise<void> => {
      // The line diff viewer loads lazily, so render on the client and wait
      // for it; static markup would only show the loading fallback.
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
      const container = document.createElement('div');
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <DiffContentView
            oldValue="secret before"
            newValue="secret after"
            viewMode="unified"
            loading={false}
            truncated={false}
            binary={false}
          />,
        );
        await Promise.resolve();
      });

      expect(Array.from(container.firstElementChild?.classList ?? [])).toEqual([
        POSTHOG_REPLAY_BLOCK_CLASS,
        'diff-content-view',
        'flex-1',
        'overflow-auto',
      ]);
      act(() => root.unmount());
    });

    // React reuses the root div when a loading, binary, or empty state turns
    // into the diff, and the recorder ignores a block class added to an
    // element it already recorded. Every state's root carries the block so it
    // is present from the element's first mount.
    it.each([
      ['loading', { loading: true, binary: false, oldValue: '', newValue: '' }],
      ['binary', { loading: false, binary: true, oldValue: '', newValue: '' }],
      ['empty', { loading: false, binary: false, oldValue: '', newValue: '' }],
    ] as const)(
      'blocks the %s state root so the diff root is blocked from first mount',
      (_state, props): void => {
        const markup = renderToStaticMarkup(
          <DiffContentView viewMode="unified" truncated={false} {...props} />,
        );

        // The binary state is the shared DiffBinaryState (REG-3024), so its
        // layout classes are the shared component's; what matters here is
        // that the block class is on the root from its first mount.
        expect(rootClassList(markup)).toEqual(
          expect.arrayContaining([POSTHOG_REPLAY_BLOCK_CLASS, 'flex-1']),
        );
      },
    );

    it.each(['unified', 'split'] as const)(
      'blocks the %s image diff root from session replay',
      (viewMode): void => {
        const markup = renderToStaticMarkup(
          <DiffContentView
            oldValue=""
            newValue=""
            viewMode={viewMode}
            loading={false}
            truncated={false}
            binary
            imagePreview={{
              oldDataUrl: 'data:image/png;base64,AQID',
              newDataUrl: 'data:image/png;base64,BAUG',
            }}
          />,
        );

        expect(rootClassList(markup)).toEqual([
          POSTHOG_REPLAY_BLOCK_CLASS,
          'flex',
          'min-h-0',
          'flex-1',
          'overflow-hidden',
        ]);
      },
    );
  });
});

describe('DiffContentView bounded states match the shared viewer (REG-3024)', () => {
  it('words a binary file exactly as the shared DiffViewer does', (): void => {
    const markup = renderToStaticMarkup(
      <DiffContentView
        oldValue=""
        newValue=""
        viewMode="unified"
        loading={false}
        truncated={false}
        binary
      />,
    );
    expect(markup).toContain('data-testid="diff-viewer-notice-binary"');
    expect(markup).toContain('Binary file. There is no text diff to show.');
    expect(markup).not.toContain('—');
  });

  it('marks a cut diff with the shared notice, not a tinted warning banner', async (): Promise<void> => {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DiffContentView
          oldValue="before"
          newValue="after"
          viewMode="unified"
          loading={false}
          truncated
          binary={false}
        />,
      );
      await Promise.resolve();
    });
    const notice = container.querySelector(
      '[data-testid="diff-viewer-notice-oversized"]',
    );
    expect(notice?.getAttribute('data-notice-intent')).toBe('neutral');
    expect(notice?.textContent).toContain(
      'This diff is too large to show in full. Showing the beginning.',
    );
    expect(container.innerHTML).not.toContain('bg-warning-subtle');
    expect(container.innerHTML).not.toContain('Diff truncated');
    act(() => root.unmount());
  });
});
