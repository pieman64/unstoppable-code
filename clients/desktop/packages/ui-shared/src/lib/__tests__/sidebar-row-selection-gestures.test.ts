import {
  resolveSelectionClick,
  resolveSelectionKey,
  shiftMouseDownSuppressesTextSelection,
} from '../sidebar-row-selection-gestures';

const base = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

describe('resolveSelectionClick', () => {
  it('toggles on the platform command click and ranges on shift', () => {
    const inputs = { selectable: true, active: false };
    expect(
      resolveSelectionClick({ ...base, metaKey: true }, inputs, true),
    ).toBe('toggle');
    expect(
      resolveSelectionClick({ ...base, ctrlKey: true }, inputs, false),
    ).toBe('toggle');
    expect(
      resolveSelectionClick({ ...base, shiftKey: true }, inputs, true),
    ).toBe('range');
    // Command wins over Shift.
    expect(
      resolveSelectionClick(
        { ...base, metaKey: true, shiftKey: true },
        inputs,
        true,
      ),
    ).toBe('toggle');
  });

  it("uses only the platform's command modifier", () => {
    const inputs = { selectable: true, active: false };
    expect(
      resolveSelectionClick({ ...base, ctrlKey: true }, inputs, true),
    ).toBe('open');
    expect(
      resolveSelectionClick({ ...base, metaKey: true }, inputs, false),
    ).toBe('open');
  });

  it('opens on a modified click on an unselectable row', () => {
    expect(
      resolveSelectionClick(
        { ...base, metaKey: true },
        { selectable: false, active: true },
        true,
      ),
    ).toBe('open');
    expect(
      resolveSelectionClick(
        { ...base, shiftKey: true },
        { selectable: false, active: true },
        true,
      ),
    ).toBe('open');
  });

  it('a plain click opens and ends an active selection', () => {
    expect(
      resolveSelectionClick(base, { selectable: true, active: true }, true),
    ).toBe('open-and-clear');
    expect(
      resolveSelectionClick(base, { selectable: true, active: false }, true),
    ).toBe('open');
  });
});

describe('resolveSelectionKey', () => {
  it('keys: x toggles, command-a selects all, Escape clears only when allowed', () => {
    const inputs = { selectable: true, active: false, escapeClears: true };
    expect(resolveSelectionKey({ ...base, key: 'x' }, inputs, true)).toBe(
      'toggle',
    );
    expect(resolveSelectionKey({ ...base, key: 'X' }, inputs, false)).toBe(
      'toggle',
    );
    expect(
      resolveSelectionKey(
        { ...base, metaKey: true, key: 'a' },
        { selectable: false, active: false, escapeClears: true },
        true,
      ),
    ).toBe('select-all');
    expect(
      resolveSelectionKey({ ...base, ctrlKey: true, key: 'A' }, inputs, false),
    ).toBe('select-all');
    expect(
      resolveSelectionKey(
        { ...base, key: 'Escape' },
        { selectable: true, active: true, escapeClears: false },
        true,
      ),
    ).toBeNull();
    expect(
      resolveSelectionKey(
        { ...base, key: 'Escape' },
        { selectable: true, active: true, escapeClears: true },
        true,
      ),
    ).toBe('clear');
  });

  it('ignores x with a modifier, x on an unselectable row, and Escape with nothing selected', () => {
    const inputs = { selectable: true, active: false, escapeClears: true };
    expect(
      resolveSelectionKey({ ...base, metaKey: true, key: 'x' }, inputs, true),
    ).toBeNull();
    expect(
      resolveSelectionKey({ ...base, altKey: true, key: 'x' }, inputs, true),
    ).toBeNull();
    expect(
      resolveSelectionKey(
        { ...base, key: 'x' },
        { ...inputs, selectable: false },
        true,
      ),
    ).toBeNull();
    expect(
      resolveSelectionKey({ ...base, key: 'Escape' }, inputs, true),
    ).toBeNull();
    expect(
      resolveSelectionKey(
        { ...base, metaKey: true, altKey: true, key: 'a' },
        inputs,
        true,
      ),
    ).toBeNull();
  });
});

describe('shiftMouseDownSuppressesTextSelection', () => {
  it('suppresses text selection only on a selectable row', () => {
    expect(
      shiftMouseDownSuppressesTextSelection({ shiftKey: true }, true),
    ).toBe(true);
    expect(
      shiftMouseDownSuppressesTextSelection({ shiftKey: true }, false),
    ).toBe(false);
    expect(
      shiftMouseDownSuppressesTextSelection({ shiftKey: false }, true),
    ).toBe(false);
  });
});
