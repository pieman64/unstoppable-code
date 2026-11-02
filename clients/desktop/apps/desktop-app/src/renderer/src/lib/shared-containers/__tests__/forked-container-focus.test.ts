/**
 * @jest-environment jsdom
 *
 * The mark that keeps a just-opened copy's focus from the chat composer's
 * automatic focus (CAN-4782).
 */
import {
  focusForkedContainerTarget,
  hasForkedContainerFocus,
} from '../forked-container-focus';

afterEach(() => {
  document.body.replaceChildren();
});

it('marks the focused copy until it loses focus', () => {
  const line = document.createElement('p');
  line.tabIndex = -1;
  const composer = document.createElement('textarea');
  document.body.append(line, composer);

  expect(focusForkedContainerTarget(line)).toBe(true);
  expect(hasForkedContainerFocus(document)).toBe(true);

  composer.focus();

  expect(hasForkedContainerFocus(document)).toBe(false);
  line.focus();
  // Focus the user moves back is not the copy's opening focus.
  expect(hasForkedContainerFocus(document)).toBe(false);
});

it('leaves no mark when focus could not land', () => {
  const detached = document.createElement('p');
  detached.tabIndex = -1;

  expect(focusForkedContainerTarget(detached)).toBe(false);
  expect(detached.hasAttribute('data-forked-container-focus')).toBe(false);
  expect(hasForkedContainerFocus(document)).toBe(false);
});
