/**
 * @jest-environment jsdom
 */
import {
  resetInputModality,
  trackInputModality,
  wasFocusVisible,
} from '../input-modality';

function makeButton(): HTMLButtonElement {
  const button = document.createElement('button');
  document.body.appendChild(button);
  return button;
}

function keydown(key: string, init: KeyboardEventInit = {}): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, ...init }),
  );
}

describe('wasFocusVisible', () => {
  beforeEach(() => {
    resetInputModality(document);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('treats programmatic focus with no prior input as not visible', () => {
    const button = makeButton();
    button.focus();
    expect(wasFocusVisible(button)).toBe(false);
  });

  it.each(['Tab', 'ArrowDown', 'Enter', ' '])(
    'treats focus after a %j keydown as keyboard-visible',
    (key) => {
      const button = makeButton();
      keydown(key);
      button.focus();
      expect(wasFocusVisible(button)).toBe(true);
    },
  );

  it('treats a Shift+Tab keydown as keyboard-visible', () => {
    const button = makeButton();
    keydown('Tab', { shiftKey: true });
    button.focus();
    expect(wasFocusVisible(button)).toBe(true);
  });

  it.each(['pointerdown', 'mousedown', 'touchstart'])(
    'treats focus after a %s as not visible, even after earlier keyboard use',
    (type) => {
      const button = makeButton();
      keydown('Tab');
      button.dispatchEvent(new Event(type, { bubbles: true }));
      button.focus();
      expect(wasFocusVisible(button)).toBe(false);
    },
  );

  it('ignores keydowns that carry a command modifier', () => {
    // Cmd/Ctrl/Alt chords are app shortcuts, not focus navigation; the focus
    // they cause (e.g. a shortcut that opens a panel) should not read as Tab.
    const button = makeButton();
    keydown('k', { metaKey: true });
    button.focus();
    expect(wasFocusVisible(button)).toBe(false);
    keydown('b', { ctrlKey: true });
    expect(wasFocusVisible(button)).toBe(false);
    keydown('x', { altKey: true });
    expect(wasFocusVisible(button)).toBe(false);
  });

  it('sees events that a bubbling listener stopped', () => {
    // Tracking is installed in the capture phase so app code that stops
    // propagation (menus, editors) cannot starve it.
    const button = makeButton();
    button.addEventListener('keydown', (event) => event.stopPropagation());
    button.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    );
    button.focus();
    expect(wasFocusVisible(button)).toBe(true);
  });

  it('sees the first keydown once tracking is installed on mount', () => {
    // A fresh document, as a second Electron window would be: the component
    // installs tracking when it mounts, so the Tab press that precedes the
    // user's first keyboard focus is recorded.
    const doc = document.implementation.createHTMLDocument('aux');
    const button = doc.createElement('button');
    doc.body.appendChild(button);
    trackInputModality(doc);
    doc.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    );
    expect(wasFocusVisible(button)).toBe(true);
  });

  it('cannot see a keydown that predates tracking (why components install it on mount)', () => {
    const doc = document.implementation.createHTMLDocument('aux');
    const button = doc.createElement('button');
    doc.body.appendChild(button);
    doc.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    );
    expect(wasFocusVisible(button)).toBe(false);
  });

  it('keeps keyboard modality across later programmatic focus moves', () => {
    // Matches the native heuristic: once the user is driving by keyboard,
    // focus that scripts move (e.g. a menu returning focus to its trigger
    // after Escape) still counts as visible until the pointer is used.
    const first = makeButton();
    const second = makeButton();
    keydown('Escape');
    first.focus();
    second.focus();
    expect(wasFocusVisible(second)).toBe(true);
  });
});
