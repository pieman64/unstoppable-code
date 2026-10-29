/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TurnDiffSummary } from '../TurnDiffSummary';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('TurnDiffSummary file chip tooltip (CAN-2799)', () => {
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

  it('shows the rename "previous → current" path in a rich tooltip on hover', () => {
    act(() => {
      root.render(
        <TurnDiffSummary
          files={[
            {
              path: 'src/b.ts',
              previousPath: 'src/a.ts',
              status: 'renamed',
              insertions: 0,
              deletions: 0,
            },
          ]}
        />,
      );
    });
    const chip = container.querySelector<HTMLButtonElement>(
      'button[data-file-path="src/b.ts"]',
    );
    expect(chip).not.toBeNull();
    expect(chip?.hasAttribute('title')).toBe(false);
    // The wrapper keeps `min-w-0` so the chip can still truncate in the
    // flex-wrap row; a `shrink-0` wrapper would defeat the ellipsis.
    expect(chip?.parentElement?.classList.contains('min-w-0')).toBe(true);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      chip?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'src/a.ts → src/b.ts',
    );
  });
});
