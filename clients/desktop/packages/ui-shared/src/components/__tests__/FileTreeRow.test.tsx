/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';
import { FileTreeRow } from '../FileTreeRow';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('FileTreeRow', () => {
  it.each([null, undefined])('omits the badge container for %s', (badge) => {
    act(() =>
      root.render(
        <FileTreeRow
          label="README.md"
          depth={0}
          isDirectory={false}
          badge={badge}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="file-tree-row-badge"]'),
    ).toBeNull();
  });

  it.each([
    [true, true],
    [false, false],
  ])(
    'masks only the label text in replays when replayMaskLabel is %s',
    (replayMaskLabel, masked) => {
      act(() =>
        root.render(
          <FileTreeRow
            label="Vendor Spend Q3"
            depth={0}
            isDirectory
            isRepoRoot
            replayMaskLabel={replayMaskLabel}
          />,
        ),
      );
      const button = container.querySelector('button');
      expect(button?.classList.contains(REPLAY_MASK_CLASS)).toBe(false);
      expect(button?.getAttribute('title')).toBe(
        masked ? null : 'Vendor Spend Q3',
      );
      expect(
        container.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent ===
          'Vendor Spend Q3',
      ).toBe(masked);
    },
  );

  it('renders an always visible badge and a plain secondary title inside the button', () => {
    act(() =>
      root.render(
        <FileTreeRow
          label="ses-a"
          depth={0}
          isDirectory
          badge="Saved copy"
          secondaryLabel="Research <b>β</b>"
        />,
      ),
    );
    const button = container.querySelector('button');
    if (!button) throw new Error('Expected file row');
    const badge = container.querySelector(
      '[data-testid="file-tree-row-badge"]',
    );
    expect(badge?.textContent).toBe('Saved copy');
    expect(button.contains(badge)).toBe(true);
    expect(button.title).toBe('ses-a — Research <b>β</b>');
    expect(button.textContent).toContain('Research <b>β</b>');
    expect(button.querySelector('b')).toBeNull();
  });

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('keeps right-click-only rows enabled', () => {
    const onContextMenu = jest.fn();
    act(() => {
      root.render(
        <FileTreeRow
          label="src"
          depth={0}
          isDirectory
          onContextMenu={onContextMenu}
        />,
      );
    });

    const button = container.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('file tree row not rendered');
    }

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      button.dispatchEvent(event);
    });

    expect(button.disabled).toBe(false);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it('pins sticky folder headers at a depth-based offset', () => {
    act(() => {
      root.render(
        <FileTreeRow
          label="src"
          depth={2}
          isDirectory
          sticky
          onClick={() => {}}
        />,
      );
    });

    const button = container.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('file tree row not rendered');
    }

    // Sticky headers expose the hooks the scroll container needs to measure and
    // flag them, and pin themselves `depth` rows down. The pinned block styling
    // (z-index, background, edge radius/border) lives in globals.css keyed off
    // the `data-stuck` / `data-stuck-edge` attributes the container toggles.
    expect(button.getAttribute('data-file-tree-folder')).toBe('');
    expect(button.getAttribute('data-sticky-depth')).toBe('2');
    expect(button.style.position).toBe('sticky');
    // depth 2 pins below the root row plus one nested row: root-height + 1×row.
    expect(button.style.top).toBe(
      'calc(var(--file-tree-root-height, 1.75rem) + var(--file-tree-row-height, 1.75rem) * 1)',
    );
  });

  it('omits sticky hooks for non-sticky rows', () => {
    act(() => {
      root.render(
        <FileTreeRow label="README.md" depth={1} isDirectory={false} />,
      );
    });

    const button = container.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('file tree row not rendered');
    }

    expect(button.getAttribute('data-file-tree-folder')).toBeNull();
    expect(button.style.position).toBe('');
  });

  it('marks and highlights the owning panel current file', () => {
    act(() => {
      root.render(
        <FileTreeRow
          label="README.md"
          depth={1}
          isDirectory={false}
          current
          dataNodeId="repo:README.md"
        />,
      );
    });

    const button = container.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('file tree row not rendered');
    }

    expect(button.dataset.currentFile).toBe('true');
    expect(button.getAttribute('aria-current')).toBe('page');
    expect(button.className).toContain('bg-fg-primary/[0.06]');
  });

  it('omits sticky hooks for non-directory rows even if sticky is passed', () => {
    act(() => {
      root.render(
        <FileTreeRow label="README.md" depth={1} isDirectory={false} sticky />,
      );
    });

    const button = container.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('file tree row not rendered');
    }

    expect(button.getAttribute('data-file-tree-folder')).toBeNull();
    expect(button.getAttribute('data-sticky-depth')).toBeNull();
    expect(button.style.position).toBe('');
  });
});
