/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  LifetimeLimitNoticeDisplay,
  type LifetimeLimitNoticeDisplayProps,
} from '../LifetimeLimitNoticeDisplay';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('lifetime notice display', () => {
  let element: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    element = document.createElement('div');
    document.body.append(element);
    root = createRoot(element);
  });
  afterEach(() => {
    act(() => root.unmount());
    element.remove();
  });
  function render(props: LifetimeLimitNoticeDisplayProps): void {
    act(() => root.render(<LifetimeLimitNoticeDisplay {...props} />));
  }

  test('full notice offers one text action', () => {
    const extend = jest.fn();
    render({ state: 'full', canExtend: true, atCap: false, onExtend: extend });
    expect(element.textContent).toContain('Lifetime limit reached');
    expect(element.textContent).toContain("worktree's lifetime limit");
    expect(element.textContent).toContain("Refused starts aren't retried");
    expect(element.querySelectorAll('button')).toHaveLength(1);
    act(() => element.querySelector('button')?.click());
    expect(extend).toHaveBeenCalledTimes(1);
  });
  test('pending disables a second extension', () => {
    const extend = jest.fn();
    render({
      state: 'full',
      canExtend: true,
      atCap: false,
      extension: 'pending',
      onExtend: extend,
    });
    expect(element.querySelector('button')?.disabled).toBe(true);
    act(() => element.querySelector('button')?.click());
    expect(extend).not.toHaveBeenCalled();
  });
  test('at cap explains the build maximum without an action', () => {
    render({ state: 'full', canExtend: false, atCap: true });
    expect(element.querySelector('button')).toBeNull();
    expect(element.textContent).toContain(
      "this build's maximum lifetime limit",
    );
  });
  test('read-only full state does not promise extension', () => {
    render({ state: 'full', canExtend: false, atCap: false });
    expect(element.querySelector('button')).toBeNull();
    expect(element.textContent).not.toContain('Extend');
  });
  test('unavailable is a calm storage message, never a fullness claim', () => {
    render({ state: 'unavailable' });
    expect(element.textContent).not.toContain('limit reached');
    expect(element.textContent).toContain(
      "Couldn't read this worktree's lifetime limit",
    );
    expect(element.querySelector('button')).toBeNull();
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });
  test('gated is static, count-free and action-free', () => {
    render({ state: 'gated' });
    expect(element.textContent).toContain(
      "can't show or change this worktree's lifetime limit",
    );
    expect(element.textContent).not.toMatch(/\d/);
    expect(
      element.querySelector('[role="status"], [role="alert"], [aria-live]'),
    ).toBeNull();
    expect(element.querySelector('button')).toBeNull();
  });
  test.each([
    ['failed', "The extension didn't apply."],
    ['uncertain', "Couldn't confirm the extension."],
  ] as const)(
    '%s keeps the full notice with post-action feedback',
    (extension, detail) => {
      render({
        state: 'full',
        canExtend: true,
        atCap: false,
        extension,
        onExtend: jest.fn(),
      });
      expect(element.textContent).toContain('Lifetime limit reached');
      expect(element.textContent).toContain(detail);
    },
  );
});
