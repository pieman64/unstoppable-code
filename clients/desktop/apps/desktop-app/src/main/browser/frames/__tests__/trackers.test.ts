/**
 * @jest-environment jsdom
 */
import {
  decodeTrackerAnswer,
  decodeTrackerSummary,
  isolatedTrackerSource,
  mainWorldTrackerSource,
  trackerCallDeclaration,
} from '../trackers';

const KEY = '__canopyPageModelTracker_test';

interface Realm {
  window: Window;
  document: Document;
  evaluate(source: string): unknown;
  answer(...elements: unknown[]): unknown;
}

/**
 * A fresh realm (an iframe window), optionally at document start: the
 * document has no element yet, as when an init script runs.
 */
function realm(options: { atStart: boolean; child: boolean }): Realm {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const view = frame.contentWindow;
  const frameDocument = frame.contentDocument;
  if (!view || !frameDocument) throw new Error('No iframe realm.');
  if (options.atStart) frameDocument.documentElement?.remove();
  Object.defineProperty(view.location, 'ancestorOrigins', {
    configurable: true,
    value: options.child ? ['http://parent.test'] : [],
  });
  const evaluate = (source: string): unknown => {
    const evaluator: unknown = Reflect.get(view, 'eval');
    if (typeof evaluator !== 'function') throw new Error('No eval');
    return Reflect.apply(evaluator, view, [source]);
  };
  return {
    window: view,
    document: frameDocument,
    evaluate,
    answer: (...elements: unknown[]): unknown => {
      const resolve: unknown = Reflect.get(view, KEY);
      if (typeof resolve !== 'function') return undefined;
      return Reflect.apply(resolve, undefined, elements);
    },
  };
}

/** A node of another realm that can be queried like a ParentNode. */
function isParentNode(value: unknown): value is ParentNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'querySelector') === 'function'
  );
}

/** The realm's `Element.prototype.attachShadow`, as page script sees it. */
function attachShadowOf(view: Window): unknown {
  const element: unknown = Reflect.get(view, 'Element');
  if (typeof element !== 'function') throw new Error('No Element');
  const prototype: unknown = Reflect.get(element, 'prototype');
  if (typeof prototype !== 'object' || prototype === null)
    throw new Error('No prototype');
  return Reflect.get(prototype, 'attachShadow');
}

/** Builds the page after the tracker ran: html, head and body. */
function addContent(target: Realm, html: string): void {
  const existing = target.document.body;
  if (existing) {
    existing.innerHTML = html;
    return;
  }
  const root = target.document.createElement('html');
  target.document.append(root);
  root.innerHTML = `<head></head><body>${html}</body>`;
}

function byId(target: Realm | ParentNode, id: string): Element {
  const scope = 'document' in target ? target.document : target;
  const found = scope.querySelector(`#${id}`);
  if (!found) throw new Error(`Missing #${id}`);
  return found;
}

/** Sets an input's type through its IDL attribute, as page script does. */
function setType(element: Element, type: string): void {
  if (!Reflect.set(element, 'type', type)) throw new Error('Not settable');
}

/** Lets MutationObserver callbacks run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('isolated-world tracker (child-frame light DOM)', () => {
  it('remembers inputs that were passwords from document start, like the preload', async () => {
    const page = realm({ atStart: true, child: true });
    page.evaluate(isolatedTrackerSource(KEY));
    addContent(
      page,
      '<input id="revealed" type="password"><input id="plain"><input id="later" type="PASSWORD"><input id="current" type="password">',
    );
    setType(byId(page, 'revealed'), 'text');
    await flush();
    // Revealed in the same task as the query: pending records count too.
    byId(page, 'later').setAttribute('type', 'text');
    expect(
      page.answer(
        byId(page, 'revealed'),
        byId(page, 'plain'),
        byId(page, 'later'),
        byId(page, 'current'),
      ),
    ).toBe('E1011');
  });

  it('answers unknown in the top frame, where the preload tracks', () => {
    const page = realm({ atStart: true, child: false });
    page.evaluate(isolatedTrackerSource(KEY));
    addContent(page, '<input id="field" type="password">');
    setType(byId(page, 'field'), 'text');
    expect(page.answer(byId(page, 'field'))).toBe('E2');
  });

  it('marks a late install, after the document had content, and answers unknown', () => {
    const page = realm({ atStart: false, child: true });
    addContent(page, '<input id="field">');
    page.evaluate(isolatedTrackerSource(KEY));
    expect(page.answer(byId(page, 'field'))).toBe('L2');
  });

  it('answers unknown for elements outside its document light DOM', () => {
    const page = realm({ atStart: true, child: true });
    page.evaluate(isolatedTrackerSource(KEY));
    addContent(page, '<div id="host"></div><input id="field">');
    const shadow = byId(page, 'host').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input id="inner">';
    const other = realm({ atStart: false, child: true });
    addContent(other, '<input id="foreign">');
    expect(
      page.answer(
        byId(shadow, 'inner'),
        byId(other, 'foreign'),
        'text',
        null,
        byId(page, 'field'),
      ),
    ).toBe('E22220');
  });

  it('keeps an element history after it moves into a shadow root (D5)', async () => {
    const page = realm({ atStart: true, child: true });
    page.evaluate(isolatedTrackerSource(KEY));
    addContent(page, '<input id="moved" type="password"><div id="host"></div>');
    setType(byId(page, 'moved'), 'text');
    await flush();
    const moved = byId(page, 'moved');
    const shadow = byId(page, 'host').attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<input id="other">';
    shadow.append(moved);
    // "was" wherever it is now; an unseen shadow input is outside its scope.
    expect(page.answer(moved, byId(shadow, 'other'))).toBe('E12');
  });

  it('installs once per document: a second registration changes nothing', async () => {
    const page = realm({ atStart: true, child: true });
    page.evaluate(isolatedTrackerSource(KEY));
    const first: unknown = Reflect.get(page.window, KEY);
    page.evaluate(isolatedTrackerSource(KEY));
    expect(Reflect.get(page.window, KEY)).toBe(first);
    addContent(page, '<input id="field" type="password">');
    setType(byId(page, 'field'), 'text');
    await flush();
    expect(page.answer(byId(page, 'field'))).toBe('E1');
    expect(Object.getOwnPropertyDescriptor(page.window, KEY)).toMatchObject({
      configurable: false,
      writable: false,
      enumerable: false,
    });
  });
});

describe('main-world tracker (shadow roots in every frame)', () => {
  it('tracks open and closed roots from creation, nested ones included', async () => {
    const page = realm({ atStart: true, child: false });
    page.evaluate(mainWorldTrackerSource(KEY, { documents: 'top' }));
    addContent(page, '<div id="open"></div><div id="closed"></div>');
    const open = byId(page, 'open').attachShadow({ mode: 'open' });
    open.innerHTML =
      '<input id="revealed" type="password"><input id="plain"><div id="nest"></div>';
    const closed = byId(page, 'closed').attachShadow({ mode: 'closed' });
    closed.innerHTML = '<input id="secret" type="password">';
    const nested = byId(open, 'nest').attachShadow({ mode: 'closed' });
    nested.innerHTML = '<input id="deep" type="password">';
    setType(byId(open, 'revealed'), 'text');
    byId(closed, 'secret').removeAttribute('type');
    await flush();
    setType(byId(nested, 'deep'), 'text');
    expect(
      page.answer(
        byId(open, 'revealed'),
        byId(open, 'plain'),
        byId(closed, 'secret'),
        byId(nested, 'deep'),
      ),
    ).toBe('E1011');
  });

  it('answers unknown for light DOM and for roots it did not see created', () => {
    const page = realm({ atStart: true, child: false });
    const original = attachShadowOf(page.window);
    if (typeof original !== 'function') throw new Error('No attachShadow');
    page.evaluate(mainWorldTrackerSource(KEY, { documents: 'top' }));
    addContent(page, '<input id="light"><div id="host"></div>');
    // A root made through a captured original (or declaratively) is untracked.
    const untracked: unknown = Reflect.apply(original, byId(page, 'host'), [
      { mode: 'open' },
    ]);
    if (!isParentNode(untracked)) throw new Error('No shadow root');
    Reflect.set(untracked, 'innerHTML', '<input id="inner">');
    expect(page.answer(byId(page, 'light'), byId(untracked, 'inner'))).toBe(
      'E22',
    );
  });

  it('installs nothing after the document had content', () => {
    const page = realm({ atStart: false, child: false });
    addContent(page, '<div id="host"></div>');
    const before = attachShadowOf(page.window);
    page.evaluate(mainWorldTrackerSource(KEY, { documents: 'top' }));
    expect(Reflect.get(page.window, KEY)).toBeUndefined();
    expect(attachShadowOf(page.window)).toBe(before);
  });

  it('keeps answering correctly after page script replaces the built-ins it uses', async () => {
    const page = realm({ atStart: true, child: false });
    page.evaluate(mainWorldTrackerSource(KEY, { documents: 'top' }));
    addContent(page, '<div id="host"></div>');
    const root = byId(page, 'host').attachShadow({ mode: 'open' });
    root.innerHTML =
      '<input id="revealed" type="password"><input id="plain"><input id="removed" type="password"><section id="container"><div><input id="nested" type="password"></div></section>';
    const removed = byId(root, 'removed');
    const nested = byId(root, 'nested');
    const container = byId(root, 'container');
    await flush();
    page.evaluate(`
      Reflect.apply = () => { throw new Error('tampered'); };
      WeakSet.prototype.has = () => false;
      WeakSet.prototype.add = function () { return this; };
      MutationObserver.prototype.takeRecords = () => [];
      Object.defineProperty(MutationRecord.prototype, 'oldValue', { get: () => null });
      Object.defineProperty(HTMLInputElement.prototype, 'type', { get: () => 'text', set() {} });
      Object.defineProperty(MutationRecord.prototype, 'removedNodes', { get: () => [] });
      Object.defineProperty(NodeList.prototype, 'length', { get: () => 0 });
      NodeList.prototype.item = () => null;
      Object.defineProperty(HTMLCollection.prototype, 'length', { get: () => 0 });
      HTMLCollection.prototype.item = () => null;
      Element.prototype.getElementsByTagName = () => [];
      Object.defineProperty(Node.prototype, 'nodeType', { get: () => 3 });
      Node.prototype.getRootNode = () => document;
      String.prototype.toLowerCase = function () { return 'nope'; };
    `);
    removed.remove();
    container.remove();
    byId(root, 'revealed').setAttribute('type', 'text');
    await flush();
    removed.setAttribute('type', 'text');
    nested.setAttribute('type', 'text');
    root.append(removed, container);
    expect(page.answer(removed, nested)).toBe('E11');
    expect(page.answer(byId(root, 'revealed'), byId(root, 'plain'))).toBe(
      'E10',
    );
  });

  it('cannot be replaced or redefined by page script', () => {
    const page = realm({ atStart: true, child: false });
    page.evaluate(mainWorldTrackerSource(KEY, { documents: 'top' }));
    const resolver: unknown = Reflect.get(page.window, KEY);
    expect(Object.getOwnPropertyDescriptor(page.window, KEY)).toMatchObject({
      configurable: false,
      writable: false,
      enumerable: false,
    });
    expect(
      Reflect.defineProperty(page.window, KEY, { value: () => 'E0' }),
    ).toBe(false);
    expect(Reflect.get(page.window, KEY)).toBe(resolver);
    // A second registration in the same document does not hook twice.
    const hooked = attachShadowOf(page.window);
    page.evaluate(mainWorldTrackerSource(KEY, { documents: 'top' }));
    expect(attachShadowOf(page.window)).toBe(hooked);
  });

  it('observes type changes when page script replaced array iteration after install', async () => {
    const page = realm({ atStart: true, child: false });
    page.evaluate(mainWorldTrackerSource(KEY, { documents: 'top' }));
    addContent(page, '<div id="host"></div>');
    // WebIDL reads a sequence (attributeFilter) through the iterator
    // protocol, so an array literal would be read through these.
    page.evaluate(`
      const arrayIterator = Object.getPrototypeOf([][Symbol.iterator]());
      arrayIterator.next = () => ({ done: true, value: undefined });
      Array.prototype[Symbol.iterator] = function* () {};
    `);
    const root = byId(page, 'host').attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="revealed" type="password"><input id="plain">';
    setType(byId(root, 'revealed'), 'text');
    await flush();
    expect(page.answer(byId(root, 'revealed'), byId(root, 'plain'))).toBe(
      'E10',
    );
  });

  it('keeps an element history wherever the element moves (D5)', async () => {
    const page = realm({ atStart: true, child: false });
    page.evaluate(mainWorldTrackerSource(KEY, { documents: 'top' }));
    addContent(
      page,
      '<div id="first"></div><div id="second"></div><div id="light"></div><input id="never-shadow">',
    );
    const first = byId(page, 'first').attachShadow({ mode: 'open' });
    const second = byId(page, 'second').attachShadow({ mode: 'closed' });
    first.innerHTML =
      '<input id="to-light" type="password"><input id="to-root" type="password"><input id="stays">';
    setType(byId(first, 'to-light'), 'text');
    setType(byId(first, 'to-root'), 'text');
    await flush();
    const toLight = byId(first, 'to-light');
    const toRoot = byId(first, 'to-root');
    byId(page, 'light').append(toLight);
    second.append(toRoot);
    // Remembered elements are "was" anywhere; "never" only in a tracked
    // root; light DOM it never saw is outside its scope.
    expect(
      page.answer(
        toLight,
        toRoot,
        byId(first, 'stays'),
        byId(page, 'never-shadow'),
      ),
    ).toBe('E1102');
  });

  it('leaves a root unknown, and still returns it, when observing it fails at attach', () => {
    const page = realm({ atStart: true, child: false });
    // observe() throws at every attach (a stand-in for a root the observer
    // rejects); the tracker captured this broken method at install.
    page.evaluate(
      `MutationObserver.prototype.observe = () => { throw new Error('rejected'); };`,
    );
    page.evaluate(mainWorldTrackerSource(KEY, { documents: 'top' }));
    addContent(page, '<div id="host"></div>');
    const root = byId(page, 'host').attachShadow({ mode: 'open' });
    expect(root).toBeTruthy();
    root.innerHTML = '<input id="field"><input id="secret" type="password">';
    setType(byId(root, 'secret'), 'text');
    expect(page.answer(byId(root, 'field'), byId(root, 'secret'))).toBe('E22');
  });

  it('keeps observing with the observe it captured after page script replaces it', () => {
    const page = realm({ atStart: true, child: false });
    page.evaluate(mainWorldTrackerSource(KEY, { documents: 'top' }));
    addContent(page, '<div id="host"></div>');
    page.evaluate(
      `MutationObserver.prototype.observe = () => { throw new Error('broken'); };`,
    );
    // The tracker captured observe before page script, so tracking works.
    const root = byId(page, 'host').attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="field">';
    expect(page.answer(byId(root, 'field'))).toBe('E0');
  });
});

describe('one attachShadow wrapper per document (E4)', () => {
  it('installs the CDP (child) source only in child documents and the preload (top) source only in top documents', () => {
    for (const [documents, child, installs] of [
      ['child', true, true],
      ['child', false, false],
      ['top', false, true],
      ['top', true, false],
    ] as const) {
      const page = realm({ atStart: true, child });
      const native = attachShadowOf(page.window);
      page.evaluate(mainWorldTrackerSource(KEY, { documents }));
      expect([
        documents,
        child,
        attachShadowOf(page.window) !== native,
      ]).toEqual([documents, child, installs]);
      expect([documents, child, page.answer() !== undefined]).toEqual([
        documents,
        child,
        installs,
      ]);
    }
  });

  it('leaves exactly one wrapper whichever installer runs first, in a top and in a child document', () => {
    const PRELOAD_KEY = '__canopyPageModelTracker_preload';
    for (const child of [false, true]) {
      for (const order of ['preload first', 'cdp first'] as const) {
        const page = realm({ atStart: true, child });
        const native = attachShadowOf(page.window);
        const preload = mainWorldTrackerSource(PRELOAD_KEY, {
          documents: 'top',
        });
        const cdp = mainWorldTrackerSource(KEY, { documents: 'child' });
        for (const source of order === 'preload first'
          ? [preload, cdp]
          : [cdp, preload])
          page.evaluate(source);
        addContent(page, '<div id="host"></div>');
        const wrapper = attachShadowOf(page.window);
        expect(wrapper).not.toBe(native);
        const owner = child ? KEY : PRELOAD_KEY;
        const other = child ? PRELOAD_KEY : KEY;
        expect([child, order, typeof Reflect.get(page.window, owner)]).toEqual([
          child,
          order,
          'function',
        ]);
        expect([child, order, Reflect.get(page.window, other)]).toEqual([
          child,
          order,
          undefined,
        ]);
      }
    }
  });
});

describe('the no-element summary', () => {
  it('says whether a tracker remembers any password, so out-of-scope asks can be skipped', async () => {
    const child = realm({ atStart: true, child: true });
    child.evaluate(isolatedTrackerSource(KEY));
    addContent(child, '<input id="field" type="password">');
    expect(child.answer()).toBe('E0');
    setType(byId(child, 'field'), 'text');
    await flush();
    expect(child.answer()).toBe('E1');

    const main = realm({ atStart: true, child: false });
    main.evaluate(mainWorldTrackerSource(KEY, { documents: 'top' }));
    addContent(main, '<div id="host"></div>');
    const root = byId(main, 'host').attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="field" type="password">';
    expect(main.answer()).toBe('E0');
    setType(byId(root, 'field'), 'text');
    // Pending records count: no flush.
    expect(main.answer()).toBe('E1');

    const late = realm({ atStart: false, child: true });
    addContent(late, '<input id="field">');
    late.evaluate(isolatedTrackerSource(KEY));
    expect(late.answer()).toBe('L0');
  });
});

describe('password history on removal (S7)', () => {
  it.each(['open', 'closed', 'light'] as const)(
    'remembers a removed input and container in %s before a later-task detached reveal',
    async (scope) => {
      const page = realm({ atStart: true, child: scope === 'light' });
      page.evaluate(
        scope === 'light'
          ? isolatedTrackerSource(KEY)
          : mainWorldTrackerSource(KEY, { documents: 'top' }),
      );
      addContent(page, '<div id="host"></div><div id="destination"></div>');
      const source =
        scope === 'light'
          ? byId(page, 'host')
          : byId(page, 'host').attachShadow({ mode: scope });
      const destination =
        scope === 'light'
          ? byId(page, 'destination')
          : byId(page, 'destination').attachShadow({ mode: scope });
      source.innerHTML =
        '<input id="direct" type="password"><section id="container"><div><input id="nested" type="password"></div><input id="plain"></section>';
      const direct = byId(source, 'direct');
      const nested = byId(source, 'nested');
      const plain = byId(source, 'plain');
      const container = byId(source, 'container');
      Reflect.set(direct, 'value', 'credential-direct');
      Reflect.set(nested, 'value', 'credential-nested');
      await flush();
      expect(page.answer()).toBe('E0'); // Added nodes do not remember passwords.
      direct.remove();
      container.remove();
      await flush(); // Removal callback must remember, without any per-input ask.
      const summaryAfterRemoval = page.answer();
      setType(direct, 'text');
      setType(nested, 'text');
      await flush();
      destination.append(direct, container);
      expect([
        summaryAfterRemoval,
        page.answer(direct, nested, plain),
        page.answer(),
      ]).toEqual(['E1', 'E110', 'E1']);
    },
  );

  it('documents jsdom does not deliver transient detached type records, even before the callback', async () => {
    const page = realm({ atStart: false, child: false });
    addContent(
      page,
      '<input id="sync" type="password"><input id="micro" type="password">',
    );
    page.evaluate(`
      globalThis.removalRecords = [];
      const observer = new MutationObserver(records => {
        for (const record of records) removalRecords.push([record.type, record.oldValue]);
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['type'] });
    `);
    const sync = byId(page, 'sync');
    const micro = byId(page, 'micro');
    // Queue the microtask before removal queues the observer callback.
    const beforeCallback = Promise.resolve().then(() => setType(micro, 'text'));
    sync.remove();
    micro.remove();
    setType(sync, 'text');
    await beforeCallback;
    await flush();
    expect(page.evaluate('removalRecords')).toEqual([
      ['childList', null],
      ['childList', null],
    ]);
    // Control: attached mutations do deliver old password values.
    page.evaluate(`
      const attached = document.createElement('input');
      attached.type = 'password';
      document.body.append(attached);
      attached.type = 'text';
    `);
    await flush();
    expect(page.evaluate('removalRecords.slice(2)')).toEqual([
      ['childList', null],
      ['attributes', 'password'],
    ]);
  });
});

describe('host-side helpers', () => {
  it('calls the resolver by syntax only, with one parameter per element', () => {
    const declaration = trackerCallDeclaration(KEY, 3);
    expect(declaration).toBe(
      `function(e0, e1, e2) { const resolve = this[${JSON.stringify(KEY)}]; return typeof resolve === 'function' ? resolve(e0, e1, e2) : undefined; }`,
    );
    expect(trackerCallDeclaration(KEY, 0)).toContain('resolve()');
  });

  it.each([
    ['E102', 3, { early: true, statuses: ['was', 'never', 'unknown'] }],
    ['L22', 2, { early: false, statuses: ['unknown', 'unknown'] }],
    // A late tracker's per-element answers are never trusted.
    ['L00', 2, { early: false, statuses: ['unknown', 'unknown'] }],
    ['E10', 3, undefined],
    // A no-element call is a summary, never an answer.
    ['E', 0, undefined],
    ['E1x', 2, undefined],
    ['X10', 2, undefined],
    [['E', '1'], 1, undefined],
    [undefined, 1, undefined],
  ])('decodes %p for %p elements', (value, count, expected) => {
    expect(decodeTrackerAnswer(value, count)).toEqual(expected);
  });

  it.each([
    ['E0', { early: true, remembers: false }],
    ['E1', { early: true, remembers: true }],
    // A late tracker's memory is not trusted.
    ['L1', { early: false, remembers: false }],
    ['E', undefined],
    ['E2', undefined],
    ['X1', undefined],
    [1, undefined],
  ])('decodes the summary %p', (value, expected) => {
    expect(decodeTrackerSummary(value)).toEqual(expected);
  });
});
