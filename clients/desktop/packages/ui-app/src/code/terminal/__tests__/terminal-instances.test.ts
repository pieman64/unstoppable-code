/** @jest-environment jsdom */

type KeyHandler = (event: KeyboardEvent) => boolean;

const mockKeyHandlers: KeyHandler[] = [];
const mockInput = jest.fn();
const mockLoadAddon = jest.fn();

jest.mock('@xterm/xterm', () => ({
  Terminal: jest.fn().mockImplementation(() => ({
    attachCustomKeyEventHandler: (handler: KeyHandler): void => {
      mockKeyHandlers.push(handler);
    },
    dispose: jest.fn(),
    input: mockInput,
    loadAddon: mockLoadAddon,
  })),
}));
jest.mock('@xterm/addon-fit', () => ({
  FitAddon: jest.fn().mockImplementation(() => ({ kind: 'fit' })),
}));
jest.mock('@xterm/addon-search', () => ({
  SearchAddon: jest.fn().mockImplementation(() => ({ kind: 'search' })),
}));

import {
  disposeInstance,
  getOrCreateInstance,
  TERMINAL_FIND_DECORATIONS,
} from '../terminal-instances';

const TERMINAL_ID = 'terminal-instances-test';

function keyEvent(
  type: 'keydown' | 'keypress' | 'keyup',
  key: string,
  modifiers: Partial<
    Pick<KeyboardEventInit, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>
  > = {},
): KeyboardEvent {
  return new KeyboardEvent(type, { key, cancelable: true, ...modifiers });
}

function latestHandler(): KeyHandler {
  const handler = mockKeyHandlers.at(-1);
  if (handler === undefined) throw new Error('no key handler attached');
  return handler;
}

function mockPlatform(platform: string): void {
  jest.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
}

describe('getOrCreateInstance', () => {
  afterEach(() => {
    disposeInstance(TERMINAL_ID);
    mockKeyHandlers.length = 0;
    mockInput.mockClear();
    mockLoadAddon.mockClear();
    jest.restoreAllMocks();
  });

  it('loads the search addon and starts with the find chord unclaimed', () => {
    const entry = getOrCreateInstance(TERMINAL_ID);

    expect(entry.search).toEqual({ kind: 'search' });
    expect(mockLoadAddon).toHaveBeenCalledWith(entry.search);
    expect(entry.findShortcutClaimed).toBe(false);
    expect(entry.disposed).toBe(false);
  });

  it('marks a disposed entry so a find controller stops calling into it', () => {
    const entry = getOrCreateInstance(TERMINAL_ID);
    disposeInstance(TERMINAL_ID);

    expect(entry.disposed).toBe(true);
  });

  it('uses opaque #RRGGBB decoration colors, as the addon requires', () => {
    for (const color of Object.values(TERMINAL_FIND_DECORATIONS)) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('declines a claimed Ctrl+F on every event type so it reaches the window', () => {
    mockPlatform('Win32');
    const entry = getOrCreateInstance(TERMINAL_ID);
    entry.findShortcutClaimed = true;
    const handler = latestHandler();

    for (const type of ['keydown', 'keypress', 'keyup'] as const) {
      const event = keyEvent(type, 'f', { ctrlKey: true });
      expect(handler(event)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(mockInput).not.toHaveBeenCalled();
  });

  it('leaves Ctrl+F to the shell while no find controller claims it', () => {
    mockPlatform('Linux x86_64');
    getOrCreateInstance(TERMINAL_ID);

    expect(latestHandler()(keyEvent('keydown', 'f', { ctrlKey: true }))).toBe(
      true,
    );
  });

  it.each(['b', 'r'])('leaves claimed-terminal Ctrl+%s to the shell', (key) => {
    mockPlatform('Win32');
    const entry = getOrCreateInstance(TERMINAL_ID);
    entry.findShortcutClaimed = true;

    expect(latestHandler()(keyEvent('keydown', key, { ctrlKey: true }))).toBe(
      true,
    );
  });

  it('claims Cmd+F but leaves Ctrl+F to the shell on macOS', () => {
    mockPlatform('MacIntel');
    const entry = getOrCreateInstance(TERMINAL_ID);
    entry.findShortcutClaimed = true;
    const handler = latestHandler();

    expect(handler(keyEvent('keydown', 'f', { ctrlKey: true }))).toBe(true);
    expect(handler(keyEvent('keydown', 'f', { metaKey: true }))).toBe(false);
  });

  it('still sends Escape + carriage return for Shift+Enter', () => {
    const entry = getOrCreateInstance(TERMINAL_ID);
    entry.findShortcutClaimed = true;
    const event = keyEvent('keydown', 'Enter', { shiftKey: true });

    expect(latestHandler()(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(mockInput).toHaveBeenCalledWith('\u001b\r');
  });
});
