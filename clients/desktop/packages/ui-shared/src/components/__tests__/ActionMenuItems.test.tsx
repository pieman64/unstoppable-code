/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ActionMenuItems, type ActionMenuItem } from '../ActionMenuItems';
import { CloseIcon, PinIcon } from '../../icons/AppIcons';

describe('ActionMenuItems icons', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(items: readonly ActionMenuItem[]): void {
    act(() => {
      root.render(<ActionMenuItems items={items} onSelect={jest.fn()} />);
    });
  }

  function hasIcon(testId: string): boolean {
    const row = container.querySelector(`[data-testid="${testId}"]`);
    if (!row) throw new Error(`row ${testId} missing`);
    return row.querySelector('svg') !== null;
  }

  function slotWidthClass(testId: string): boolean {
    const slot = container.querySelector(
      `[data-testid="${testId}"] > span[aria-hidden="true"]`,
    );
    return slot?.className.includes('w-4') === true;
  }

  it('shows a shared icon only on the first row of a run in a group', () => {
    render([
      { key: 'pin', label: 'Pin', icon: <PinIcon />, testId: 'pin' },
      {
        key: 'close',
        label: 'Close',
        icon: <CloseIcon />,
        separatorBefore: true,
        testId: 'close',
      },
      {
        key: 'close-others',
        label: 'Close others',
        icon: <CloseIcon />,
        testId: 'close-others',
      },
      {
        key: 'close-all',
        label: 'Close all',
        icon: <CloseIcon />,
        testId: 'close-all',
      },
    ]);
    expect(hasIcon('pin')).toBe(true);
    expect(hasIcon('close')).toBe(true);
    expect(hasIcon('close-others')).toBe(false);
    expect(hasIcon('close-all')).toBe(false);
    // The empty slot keeps its width, so the labels stay aligned.
    expect(slotWidthClass('close-others')).toBe(true);
  });

  it('shows the icon again after a divider and for a different icon', () => {
    render([
      { key: 'a', label: 'A', icon: <CloseIcon />, testId: 'a' },
      {
        key: 'b',
        label: 'B',
        icon: <CloseIcon />,
        separatorBefore: true,
        testId: 'b',
      },
      {
        key: 'c',
        label: 'C',
        icon: <CloseIcon className="rotate-180" />,
        testId: 'c',
      },
    ]);
    expect(hasIcon('a')).toBe(true);
    expect(hasIcon('b')).toBe(true);
    expect(hasIcon('c')).toBe(true);
  });
});
