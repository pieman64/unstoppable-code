/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useValueHeldWhile } from '../useValueHeldWhile';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

let seen: boolean[] = [];

function Probe({
  value,
  hold,
}: {
  value: boolean;
  hold: boolean;
}): JSX.Element {
  seen.push(useValueHeldWhile(value, hold));
  return <></>;
}

describe('useValueHeldWhile', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    seen = [];
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
  });

  function render(value: boolean, hold: boolean): boolean | undefined {
    act(() => root.render(<Probe value={value} hold={hold} />));
    return seen.at(-1);
  }

  it('follows the value while nothing holds it', () => {
    expect(render(false, false)).toBe(false);
    expect(render(true, false)).toBe(true);
    expect(render(false, false)).toBe(false);
  });

  it('keeps the earlier value while held, then takes the latest one', () => {
    expect(render(false, false)).toBe(false);
    // Say, a queued-message edit is open: flipping Compact queue now would
    // remount the editor and lose its unsaved text.
    expect(render(true, true)).toBe(false);
    expect(render(false, true)).toBe(false);
    expect(render(true, true)).toBe(false);
    expect(render(true, false)).toBe(true);
  });
});
