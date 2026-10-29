/**
 * @jest-environment jsdom
 */
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffContentView } from '../DiffContentView';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

jest.mock('react-diff-viewer-continued', () => ({
  __esModule: true,
  DiffMethod: { LINES: 'diffLines', WORDS: 'diffWords' },
  default: ({
    oldValue,
    newValue,
    compareMethod,
    splitView,
  }: {
    oldValue: string;
    newValue: string;
    compareMethod: string;
    splitView: boolean;
  }): ReactElement => (
    <div
      data-testid="loaded-diff-viewer"
      data-compare-method={compareMethod}
      data-split-view={String(splitView)}
    >
      {oldValue}→{newValue}
    </div>
  ),
}));

const PROPS = {
  oldValue: 'before',
  newValue: 'after',
  viewMode: 'split',
  loading: false,
  truncated: false,
  binary: false,
} as const;

describe('DiffContentView lazy diff viewer', () => {
  // The viewer library loads once per module registry, so this test must run
  // before the one that renders it loaded.
  it('shows the diff loading state while the viewer library loads', () => {
    const markup = renderToStaticMarkup(<DiffContentView {...PROPS} />);

    expect(markup).toContain('Loading diff…');
    expect(markup).not.toContain('loaded-diff-viewer');
    // The same state the view shows while the diff itself loads.
    expect(markup).toBe(
      renderToStaticMarkup(<DiffContentView {...PROPS} loading />),
    );
  });

  it('renders the loaded viewer with line comparison and the view props', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(() => {
      root.render(<DiffContentView {...PROPS} />);
      // An async act scope lets the lazy import resolve and render.
      return Promise.resolve();
    });

    const viewer = container.querySelector(
      '[data-testid="loaded-diff-viewer"]',
    );
    expect(viewer?.getAttribute('data-compare-method')).toBe('diffLines');
    expect(viewer?.getAttribute('data-split-view')).toBe('true');
    expect(viewer?.textContent).toBe('before→after');
    expect(container.textContent).not.toContain('Loading diff…');

    act(() => root.unmount());
    container.remove();
  });
});
