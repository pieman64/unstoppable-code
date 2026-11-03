/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GuestFilesState } from '../GuestFilesState';
import { GUEST_FILES_MESSAGE } from '../guest-files-copy';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('explains account access with an accessible host-owned sign-in action', () => {
  const onSignIn = jest.fn();
  act(() => root.render(<GuestFilesState onSignIn={onSignIn} />));
  expect(container.textContent).toContain(GUEST_FILES_MESSAGE);
  const buttons = container.querySelectorAll('button');
  expect(buttons).toHaveLength(1);
  const button = buttons.item(0);
  expect(button.textContent).toBe('Sign in');
  expect(button.getAttribute('type')).toBe('button');
  act(() => {
    button.click();
  });
  expect(onSignIn).toHaveBeenCalledTimes(1);
  expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
    'true',
  );
  expect(container.querySelector('input, [role="alert"]')).toBeNull();
  expect(container.textContent).not.toMatch(/Retry|Try again|upload|loading/i);
});
