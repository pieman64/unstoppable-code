/** @jest-environment jsdom */
import {
  resolveFallbackFindTarget,
  resolveFindTarget,
  runFindShortcut,
  type FindShortcutEvent,
} from '../find-shortcut';
import {
  useSurfaceFindStore,
  type FindController,
  type FindSurfaceMode,
} from '../surface-find-store';

function register(
  mode: FindSurfaceMode,
  scopeKey: string,
  anchor: HTMLElement = document.body,
): FindController {
  const controller: FindController = {
    mode,
    scopeKey,
    title: scopeKey,
    anchor,
    setQuery: jest.fn(),
    next: jest.fn(),
    previous: jest.fn(),
    close: jest.fn(),
  };
  useSurfaceFindStore.getState().registerController(controller);
  return controller;
}

function cmdF(
  target: EventTarget | null,
  overrides: Partial<FindShortcutEvent> = {},
): FindShortcutEvent & { preventDefault: jest.Mock } {
  return {
    // jsdom reports a non-mac platform, so the primary modifier is Ctrl.
    key: 'f',
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    target,
    preventDefault: jest.fn(),
    ...overrides,
  };
}

function surface(mode: string, scope: string): HTMLDivElement {
  const element = document.createElement('div');
  element.setAttribute('data-find-surface', mode);
  element.setAttribute('data-find-scope', scope);
  return element;
}

afterEach(() => {
  const store = useSurfaceFindStore.getState();
  store.close();
  for (const entry of Object.values(store.controllers)) {
    store.unregisterController(entry.controller);
  }
  document.body.replaceChildren();
});

describe('resolveFindTarget', () => {
  it('resolves browser chrome, chat, and file markers', () => {
    const browser = document.createElement('div');
    browser.setAttribute('data-browser-surface', '');
    browser.setAttribute('data-browser-id', 'b1');
    const button = document.createElement('button');
    browser.append(button);
    const chat = surface('chat', 'c1');
    const composer = document.createElement('textarea');
    chat.append(composer);
    const file = surface('file', 't1');
    document.body.append(browser, chat, file);

    const none = (): null => null;
    expect(resolveFindTarget(button, none)).toEqual({
      mode: 'browser',
      scopeKey: 'b1',
    });
    expect(resolveFindTarget(composer, none)).toEqual({
      mode: 'chat',
      scopeKey: 'c1',
    });
    expect(resolveFindTarget(file, none)).toEqual({
      mode: 'file',
      scopeKey: 't1',
    });
  });

  it('resolves plan and diagram markers and rejects unknown ones', () => {
    const plan = surface('plan', 'p/w/plan-1');
    const paragraph = document.createElement('p');
    plan.append(paragraph);
    const diagram = surface('diagram', 'p/w');
    const node = document.createElement('div');
    diagram.append(node);
    const unknown = surface('canvas', 'x1');
    const inner = document.createElement('span');
    unknown.append(inner);
    document.body.append(plan, diagram, unknown);

    const none = (): null => null;
    expect(resolveFindTarget(paragraph, none)).toEqual({
      mode: 'plan',
      scopeKey: 'p/w/plan-1',
    });
    expect(resolveFindTarget(node, none)).toEqual({
      mode: 'diagram',
      scopeKey: 'p/w',
    });
    expect(resolveFindTarget(inner, none)).toBeNull();
  });

  it("resolves a terminal marker from xterm's helper textarea", () => {
    const pane = surface('terminal', 'term-1');
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const textarea = document.createElement('textarea');
    xterm.append(textarea);
    pane.append(xterm);
    document.body.append(pane);

    expect(resolveFindTarget(textarea, () => null)).toEqual({
      mode: 'terminal',
      scopeKey: 'term-1',
    });
  });

  it('repeats the open scope for a keydown inside the bar', () => {
    register('file', 't1');
    useSurfaceFindStore.getState().openFor('file', 't1');
    const bar = document.createElement('div');
    bar.setAttribute('data-testid', 'surface-find-bar');
    const input = document.createElement('input');
    bar.append(input);
    document.body.append(bar);

    expect(resolveFindTarget(input, () => null)).toEqual({
      mode: 'file',
      scopeKey: 't1',
    });
  });

  it('uses the fallback for unowned targets', () => {
    const fallback = { mode: 'chat' as const, scopeKey: 'c9' };
    expect(resolveFindTarget(document.body, () => fallback)).toBe(fallback);
  });
});

describe('resolveFallbackFindTarget', () => {
  it('picks the registered surface in the active group', () => {
    const groupA = document.createElement('div');
    groupA.setAttribute('data-testid', 'panel-group-a');
    groupA.append(surface('chat', 'hidden'), surface('chat', 'c1'));
    const groupB = document.createElement('div');
    groupB.setAttribute('data-testid', 'panel-group-b');
    groupB.append(surface('file', 't1'));
    document.body.append(groupA, groupB);
    register('chat', 'c1');
    register('file', 't1');

    expect(resolveFallbackFindTarget(document, 'a')).toEqual({
      mode: 'chat',
      scopeKey: 'c1',
    });
    expect(resolveFallbackFindTarget(document, 'b')).toEqual({
      mode: 'file',
      scopeKey: 't1',
    });
  });

  it('finds a registered plan marker in the active group', () => {
    const groupA = document.createElement('div');
    groupA.setAttribute('data-testid', 'panel-group-a');
    groupA.append(surface('plan', 'p/w/plan-1'));
    const groupB = document.createElement('div');
    groupB.setAttribute('data-testid', 'panel-group-b');
    groupB.append(surface('diagram', 'p/w'));
    document.body.append(groupA, groupB);
    register('plan', 'p/w/plan-1');
    register('diagram', 'p/w');

    expect(resolveFallbackFindTarget(document, 'a')).toEqual({
      mode: 'plan',
      scopeKey: 'p/w/plan-1',
    });
    expect(resolveFallbackFindTarget(document, 'b')).toEqual({
      mode: 'diagram',
      scopeKey: 'p/w',
    });
  });

  it('finds nothing when the active group has no searchable surface', () => {
    // Focus sits in the active group (say, a terminal or an empty chat);
    // a browser in another group must not take the chord.
    const groupA = document.createElement('div');
    groupA.setAttribute('data-testid', 'panel-group-a');
    const groupB = document.createElement('div');
    groupB.setAttribute('data-testid', 'panel-group-b');
    const browser = document.createElement('div');
    browser.setAttribute('data-browser-surface', '');
    browser.setAttribute('data-browser-id', 'b1');
    groupB.append(browser);
    document.body.append(groupA, groupB);
    register('browser', 'b1');

    expect(resolveFallbackFindTarget(document, 'a')).toBeNull();
  });

  it('uses the only registered surface without an active group', () => {
    document.body.append(surface('chat', 'c1'));
    register('chat', 'c1');
    expect(resolveFallbackFindTarget(document, null)).toEqual({
      mode: 'chat',
      scopeKey: 'c1',
    });

    document.body.append(surface('file', 't1'));
    register('file', 't1');
    expect(resolveFallbackFindTarget(document, null)).toBeNull();
  });
});

describe('runFindShortcut', () => {
  it('opens the bar for the focused surface and records the opener', () => {
    const chat = surface('chat', 'c1');
    const composer = document.createElement('textarea');
    chat.append(composer);
    document.body.append(chat);
    register('chat', 'c1');
    composer.focus();

    const event = cmdF(composer);
    expect(runFindShortcut(event, () => null)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(useSurfaceFindStore.getState().mode).toBe('chat');
    expect(useSurfaceFindStore.getState().returnFocus).toBe(composer);
  });

  it.each([
    ['an already handled event', { defaultPrevented: true }],
    ['a different chord', { shiftKey: true }],
  ])('ignores %s', (_name, overrides) => {
    const chat = surface('chat', 'c1');
    document.body.append(chat);
    register('chat', 'c1');

    const event = cmdF(chat, overrides);
    expect(runFindShortcut(event, () => null)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(useSurfaceFindStore.getState().open).toBe(false);
  });

  it('ignores a target inside a dialog', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const chat = surface('chat', 'c1');
    dialog.append(chat);
    document.body.append(dialog);
    register('chat', 'c1');

    const event = cmdF(chat);
    expect(runFindShortcut(event, () => null)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('leaves the chord alone for a surface without a controller', () => {
    const file = surface('file', 'image-tab');
    document.body.append(file);

    const event = cmdF(file);
    expect(runFindShortcut(event, () => null)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('reads the opener from the target document', () => {
    const other = document.implementation.createHTMLDocument('aux');
    const chat = other.createElement('div');
    chat.setAttribute('data-find-surface', 'chat');
    chat.setAttribute('data-find-scope', 'c1');
    const button = other.createElement('button');
    chat.append(button);
    other.body.append(chat);
    button.focus();
    register('chat', 'c1');

    expect(runFindShortcut(cmdF(button), () => null)).toBe(true);
    const { returnFocus } = useSurfaceFindStore.getState();
    expect(returnFocus).toBe(other.activeElement);
    expect(returnFocus).not.toBe(document.activeElement);
  });
});
