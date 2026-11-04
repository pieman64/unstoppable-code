/** @jest-environment jsdom */
import {
  getAvailableFindModes,
  getFindScopes,
  useSurfaceFindStore,
  type FindController,
  type FindSurfaceMode,
} from '../surface-find-store';

interface MockFindController extends FindController {
  setQuery: jest.Mock<void, [string]>;
  next: jest.Mock<void, []>;
  previous: jest.Mock<void, []>;
  close: jest.Mock<void, []>;
  retry: jest.Mock<void, []>;
}

function makeController(
  mode: FindSurfaceMode,
  scopeKey: string,
  anchor: HTMLElement = document.body,
  title: string = scopeKey,
): MockFindController {
  return {
    mode,
    scopeKey,
    title,
    anchor,
    setQuery: jest.fn<void, [string]>(),
    next: jest.fn<void, []>(),
    previous: jest.fn<void, []>(),
    close: jest.fn<void, []>(),
    retry: jest.fn<void, []>(),
  };
}

const store = (): ReturnType<typeof useSurfaceFindStore.getState> =>
  useSurfaceFindStore.getState();

afterEach(() => {
  store().close();
  for (const entry of Object.values(store().controllers)) {
    store().unregisterController(entry.controller);
  }
  useSurfaceFindStore.setState({ rememberedQueries: {} });
  document.body.replaceChildren();
});

describe('surfaceFindStore', () => {
  it('restores the modal opener when retargeting an already-open background search', () => {
    const background = document.createElement('button');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const pdf = document.createElement('button');
    dialog.append(pdf);
    document.body.append(background, dialog);
    store().registerController(
      makeController('chat', 'background', background),
    );
    store().registerController(makeController('file', 'pdf', pdf));
    store().openFor('chat', 'background', background);
    store().openFor('file', 'pdf', pdf);
    store().close();
    expect(document.activeElement).toBe(pdf);
  });

  it('registers and unregisters controllers and lists available modes', () => {
    const chat = makeController('chat', 'c1');
    const file = makeController('file', 't1');
    store().registerController(chat);
    store().registerController(file);

    expect(store().hasController('chat', 'c1')).toBe(true);
    expect(getAvailableFindModes(store().controllers).sort()).toEqual([
      'chat',
      'file',
    ]);

    store().unregisterController(file);
    expect(getAvailableFindModes(store().controllers)).toEqual(['chat']);
  });

  it('ignores an unregister from a controller that was already replaced', () => {
    const first = makeController('chat', 'c1');
    const second = makeController('chat', 'c1');
    store().registerController(first);
    store().registerController(second);

    store().unregisterController(first);
    expect(store().controllers['chat:c1']?.controller).toBe(second);
  });

  it('keeps the bar open when an active controller is replaced in place', () => {
    const first = makeController('chat', 'c1');
    store().registerController(first);
    store().openFor('chat', 'c1');

    store().registerController(makeController('chat', 'c1'));
    expect(store().open).toBe(true);
    expect(first.close).not.toHaveBeenCalled();
  });

  it('does nothing when no controller exists for the target', () => {
    store().openFor('chat', 'missing');
    expect(store().open).toBe(false);
  });

  it('only bumps the focus nonce on a repeated open of the same scope', () => {
    const chat = makeController('chat', 'c1');
    store().registerController(chat);
    store().openFor('chat', 'c1');
    const nonce = store().focusNonce;

    store().openFor('chat', 'c1');
    expect(store().focusNonce).toBe(nonce + 1);
    expect(chat.setQuery).toHaveBeenCalledTimes(1);
    expect(chat.close).not.toHaveBeenCalled();
  });

  it('closes the previous scope and re-queries the new one', () => {
    const first = makeController('chat', 'c1');
    const second = makeController('chat', 'c2');
    store().registerController(first);
    store().registerController(second);
    store().openFor('chat', 'c1');
    store().setQuery('needle');

    store().openFor('chat', 'c2');
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.setQuery).toHaveBeenLastCalledWith('needle');
    expect(store().activeScope.chat).toBe('c2');
  });

  it('keeps the query across mode switches and uses the last scope per mode', () => {
    const chatA = makeController('chat', 'c1');
    const chatB = makeController('chat', 'c2');
    const file = makeController('file', 't1');
    store().registerController(chatA);
    store().registerController(chatB);
    store().registerController(file);
    store().openFor('chat', 'c1');
    store().setQuery('needle');

    store().switchMode('file');
    expect(store().mode).toBe('file');
    expect(file.setQuery).toHaveBeenLastCalledWith('needle');

    store().switchMode('chat');
    expect(store().activeScope.chat).toBe('c1');
    expect(chatA.setQuery).toHaveBeenLastCalledWith('needle');
  });

  it('falls back to the newest registered scope for a mode never used', () => {
    store().registerController(makeController('chat', 'c1'));
    store().registerController(makeController('file', 't1'));
    store().registerController(makeController('file', 't2'));
    store().openFor('chat', 'c1');

    store().switchMode('file');
    expect(store().activeScope.file).toBe('t2');
  });

  it("switches modes only within the searched surface's own window", () => {
    // A popped-out panel window registers controllers anchored in its own
    // document; the mode toggles of a bar open in the main window must not
    // move the bar there.
    const other = document.implementation.createHTMLDocument('aux');
    const chat = makeController('chat', 'c1');
    const auxBrowser = makeController('browser', 'b-aux', other.body);
    store().registerController(chat);
    store().registerController(auxBrowser);
    store().openFor('chat', 'c1');

    store().switchMode('browser');

    expect(store().mode).toBe('chat');
    expect(auxBrowser.setQuery).not.toHaveBeenCalled();
    expect(getAvailableFindModes(store().controllers, document)).toEqual([
      'chat',
    ]);
  });

  it('prefers a same-window scope over a newer one in another window', () => {
    const other = document.implementation.createHTMLDocument('aux');
    const chat = makeController('chat', 'c1');
    const mainBrowser = makeController('browser', 'b-main');
    const auxBrowser = makeController('browser', 'b-aux', other.body);
    store().registerController(chat);
    store().registerController(mainBrowser);
    store().registerController(auxBrowser);
    store().openFor('chat', 'c1');

    store().switchMode('browser');

    expect(store().mode).toBe('browser');
    expect(store().activeScope.browser).toBe('b-main');
  });

  it('restores the last query of a scope when it is searched again', () => {
    const chat = makeController('chat', 'c1');
    store().registerController(chat);
    store().openFor('chat', 'c1');
    store().setQuery('foo');
    store().close();
    expect(store().query).toBe('');

    store().openFor('chat', 'c1');

    expect(store().query).toBe('foo');
    expect(chat.setQuery).toHaveBeenLastCalledWith('foo');
  });

  it('remembers the query when the searched surface goes away', () => {
    // Switching worktree unmounts the chat, which unregisters and closes.
    const chat = makeController('chat', 'c1');
    store().registerController(chat);
    store().openFor('chat', 'c1');
    store().setQuery('bar');
    store().unregisterController(chat);
    expect(store().open).toBe(false);

    const again = makeController('chat', 'c1');
    store().registerController(again);
    store().openFor('chat', 'c1');

    expect(store().query).toBe('bar');
    expect(again.setQuery).toHaveBeenLastCalledWith('bar');
  });

  it("keeps each plan tab's query across the joined panel's tab switches", () => {
    // The joined plan panel registers one surface per shown tab under one
    // scope key: the plan on Document, the diagram on Diagram.
    const plan = makeController('plan', 'p/w/plan-1');
    store().registerController(plan);
    store().openFor('plan', 'p/w/plan-1');
    store().setQuery('baseline');
    store().unregisterController(plan);
    expect(store().open).toBe(false);

    const diagram = makeController('diagram', 'p/w/plan-1');
    store().registerController(diagram);
    store().openFor('diagram', 'p/w/plan-1');
    expect(store().query).toBe('');
    store().setQuery('task');
    store().unregisterController(diagram);

    const planAgain = makeController('plan', 'p/w/plan-1');
    store().registerController(planAgain);
    store().openFor('plan', 'p/w/plan-1');
    expect(store().query).toBe('baseline');
    expect(planAgain.setQuery).toHaveBeenLastCalledWith('baseline');
    store().unregisterController(planAgain);

    const diagramAgain = makeController('diagram', 'p/w/plan-1');
    store().registerController(diagramAgain);
    store().openFor('diagram', 'p/w/plan-1');
    expect(store().query).toBe('task');
  });

  it('remembers the query for the scope being left on a switch', () => {
    const chat = makeController('chat', 'c1');
    const browser = makeController('browser', 'b1');
    store().registerController(chat);
    store().registerController(browser);
    store().openFor('chat', 'c1');
    store().setQuery('foo');

    store().switchMode('browser');
    store().close();
    store().openFor('chat', 'c1');

    expect(store().query).toBe('foo');
    expect(chat.setQuery).toHaveBeenLastCalledWith('foo');
  });

  it('opens another scope with its own remembered query, empty at first', () => {
    const first = makeController('chat', 'c1');
    const second = makeController('chat', 'c2');
    store().registerController(first);
    store().registerController(second);
    store().openFor('chat', 'c1');
    store().setQuery('foo');
    store().close();

    store().openFor('chat', 'c2');

    expect(store().query).toBe('');
    expect(second.setQuery).toHaveBeenLastCalledWith('');
  });

  it('lists the surfaces of a mode in this window with their titles, in order', () => {
    const other = document.implementation.createHTMLDocument('aux');
    store().registerController(
      makeController('browser', 'b2', document.body, 'Local'),
    );
    store().registerController(
      makeController('browser', 'b1', document.body, 'Docs'),
    );
    store().registerController(
      makeController('browser', 'b-aux', other.body, 'Aux'),
    );
    store().registerController(makeController('chat', 'c1'));

    expect(getFindScopes(store().controllers, 'browser', document)).toEqual([
      { key: 'b2', title: 'Local' },
      { key: 'b1', title: 'Docs' },
    ]);
  });

  describe('scope order follows the on-screen layout', () => {
    // A panel anchor laid out at the given viewport rect.
    function anchorAt(
      left: number,
      top: number,
      width: number,
      height: number,
    ): HTMLElement {
      const anchor = document.createElement('div');
      document.body.appendChild(anchor);
      anchor.getBoundingClientRect = (): DOMRect =>
        new DOMRect(left, top, width, height);
      return anchor;
    }

    const keysFor = (mode: FindSurfaceMode): string[] =>
      getFindScopes(store().controllers, mode, document).map(
        (scope) => scope.key,
      );

    it('numbers stacked panels top first, before the column beside them', () => {
      // Two chats stacked on the left, one full height on the right. The
      // top chat registered last (it was hidden, then shown again).
      store().registerController(
        makeController('chat', 'right', anchorAt(400, 0, 400, 800)),
      );
      store().registerController(
        makeController('chat', 'bottom-left', anchorAt(0, 400, 400, 400)),
      );
      store().registerController(
        makeController('chat', 'top-left', anchorAt(0, 0, 400, 400)),
      );

      expect(keysFor('chat')).toEqual(['top-left', 'bottom-left', 'right']);
    });

    it('numbers a row left to right, before the panel below it', () => {
      store().registerController(
        makeController('file', 'bottom', anchorAt(0, 400, 800, 400)),
      );
      store().registerController(
        makeController('file', 'top-right', anchorAt(400, 0, 400, 400)),
      );
      store().registerController(
        makeController('file', 'top-left', anchorAt(0, 0, 400, 400)),
      );

      expect(keysFor('file')).toEqual(['top-left', 'top-right', 'bottom']);
    });
  });

  it('switches to a chosen surface of a mode', () => {
    const chat = makeController('chat', 'c1');
    const first = makeController('browser', 'b1');
    const second = makeController('browser', 'b2');
    store().registerController(chat);
    store().registerController(first);
    store().registerController(second);
    store().openFor('browser', 'b1');
    store().setQuery('needle');

    store().switchMode('browser', 'b2');

    expect(store().activeScope.browser).toBe('b2');
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.setQuery).toHaveBeenLastCalledWith('needle');
  });

  it('retitles a registered surface without re-registering it', () => {
    const browser = makeController('browser', 'b1', document.body, 'Loading…');
    store().registerController(browser);
    store().openFor('browser', 'b1');

    store().setControllerTitle('browser', 'b1', 'Docs');

    expect(getFindScopes(store().controllers, 'browser')).toEqual([
      { key: 'b1', title: 'Docs' },
    ]);
    expect(store().open).toBe(true);
    expect(store().controllers['browser:b1']?.controller).toBe(browser);
  });

  it('forwards next and previous only with a query', () => {
    const chat = makeController('chat', 'c1');
    store().registerController(chat);
    store().openFor('chat', 'c1');

    store().next();
    store().previous();
    expect(chat.next).not.toHaveBeenCalled();
    expect(chat.previous).not.toHaveBeenCalled();

    store().setQuery('a');
    store().next();
    store().previous();
    expect(chat.next).toHaveBeenCalledTimes(1);
    expect(chat.previous).toHaveBeenCalledTimes(1);
  });

  it('closes the bar when the active controller unregisters, not another one', () => {
    const chat = makeController('chat', 'c1');
    const file = makeController('file', 't1');
    store().registerController(chat);
    store().registerController(file);
    store().openFor('chat', 'c1');

    store().unregisterController(file);
    expect(store().open).toBe(true);

    store().unregisterController(chat);
    expect(store().open).toBe(false);
    expect(chat.close).toHaveBeenCalledTimes(1);
  });

  it('leaves focus where the user moved it when the active controller unregisters', () => {
    const opener = document.createElement('button');
    const elsewhere = document.createElement('button');
    document.body.append(opener, elsewhere);
    const chat = makeController('chat', 'c1');
    store().registerController(chat);
    store().openFor('chat', 'c1', opener);
    elsewhere.focus();

    store().unregisterController(chat);
    expect(store().open).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('restores focus when the active controller unregisters while the bar holds it', () => {
    const opener = document.createElement('button');
    const bar = document.createElement('div');
    bar.dataset.testid = 'surface-find-bar';
    const input = document.createElement('input');
    bar.append(input);
    document.body.append(opener, bar);
    const chat = makeController('chat', 'c1');
    store().registerController(chat);
    store().openFor('chat', 'c1', opener);
    input.focus();

    store().unregisterController(chat);
    expect(document.activeElement).toBe(opener);
  });

  it('resets the query and restores focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    const chat = makeController('chat', 'c1');
    store().registerController(chat);
    store().openFor('chat', 'c1', opener);
    store().setQuery('needle');

    store().close();
    expect(store().query).toBe('');
    expect(store().open).toBe(false);
    expect(chat.close).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it('restores focus to the anchor when the opener is gone', () => {
    const anchor = document.createElement('div');
    anchor.tabIndex = -1;
    const opener = document.createElement('button');
    document.body.append(anchor, opener);
    store().registerController(makeController('chat', 'c1', anchor));
    store().openFor('chat', 'c1', opener);
    opener.remove();

    store().close();
    expect(document.activeElement).toBe(anchor);
  });

  it('never records the bar itself as the element to restore', () => {
    const opener = document.createElement('button');
    const bar = document.createElement('div');
    bar.dataset.testid = 'surface-find-bar';
    const input = document.createElement('input');
    bar.append(input);
    document.body.append(opener, bar);
    store().registerController(makeController('chat', 'c1'));
    store().registerController(makeController('chat', 'c2'));

    store().openFor('chat', 'c1', opener);
    store().openFor('chat', 'c2', input);
    expect(store().returnFocus).toBe(opener);

    store().close();
    store().openFor('chat', 'c1', input);
    expect(store().returnFocus).toBeNull();
  });

  it("restores focus in the new window's opener after a retarget across windows", () => {
    // The bar is open in the main window when Cmd/Ctrl+F is pressed in a
    // popped-out panel window: closing must not reach back into the window
    // the user left.
    const other = document.implementation.createHTMLDocument('aux');
    const mainOpener = document.createElement('button');
    document.body.append(mainOpener);
    const auxOpener = other.createElement('button');
    other.body.append(auxOpener);
    store().registerController(makeController('chat', 'c-main'));
    store().registerController(makeController('chat', 'c-aux', other.body));
    store().openFor('chat', 'c-main', mainOpener);

    store().openFor('chat', 'c-aux', auxOpener);
    expect(store().returnFocus).toBe(auxOpener);

    store().close();
    expect(document.activeElement).not.toBe(mainOpener);
  });

  it('keeps the original opener across a retarget within one window', () => {
    const opener = document.createElement('button');
    const other = document.createElement('button');
    document.body.append(opener, other);
    store().registerController(makeController('chat', 'c1'));
    store().registerController(makeController('chat', 'c2'));
    store().openFor('chat', 'c1', opener);

    store().openFor('chat', 'c2', other);
    expect(store().returnFocus).toBe(opener);
  });

  it('skips identical controller state updates', () => {
    store().registerController(makeController('chat', 'c1'));
    const state = { currentIndex: 1, totalCount: 3, error: null };
    store().updateControllerState('chat', 'c1', state);
    const before = store().controllerStates;

    store().updateControllerState('chat', 'c1', { ...state });
    expect(store().controllerStates).toBe(before);
  });
});
