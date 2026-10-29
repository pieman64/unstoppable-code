/**
 * Document-start password-history trackers (phase 04b, decisions D2 to D4),
 * as plain JavaScript sources. Pure and browser-safe: the host registers
 * them with CDP for child frames, and the browser-view preload installs the
 * main-world one in every top document (the first document of a new view
 * included, which CDP-registered scripts miss). Neither takes a key from
 * the page: the host makes its own, the preload one per document.
 *
 * - The isolated-world tracker covers child-frame light DOM with the
 *   preload's rule (`previouslyPasswordInputs`). Page script cannot reach
 *   its world. In a top document it tracks nothing.
 * - The main-world tracker wraps `Element.prototype.attachShadow`, observes
 *   every root created through it for `type` changes and removals, and keeps a
 *   password-ever-seen flag per input. It captures every built-in it calls
 *   before page script runs and exposes one non-configurable resolver under
 *   its key. It installs only in the documents it is given (`top` for the
 *   preload, `child` for CDP), so a document has one wrapper.
 *
 * Both check that the document has no element yet; a late run tracks
 * nothing. A resolver answers `E` (ran at document start) or `L` (late),
 * then one character per element: `1` was a password, wherever the element
 * is now (history belongs to the element, D5); `0` never a password, only
 * for an element in the tracker's own scope that it has tracked; `2`
 * unknown. Called with no element, it answers the flag and whether it
 * remembers any password (`1`) or none (`0`). An input never attached in
 * an observed tree while it was a password, then inserted as text, still
 * answers `0` in scope: no user-typed password from that tree is at risk.
 */

/** Which documents a main-world tracker source installs in. */
export type TrackedDocuments = 'top' | 'child';

/** A resolver key: unpredictable to the page, so it cannot plant one. */
export const TRACKER_KEY_PATTERN = /^__canopyPageModelTracker_[0-9a-f]{32}$/;

const TRACKER_KEY_PREFIX = '__canopyPageModelTracker_';

/** A resolver key from 16 random bytes (the preload's `crypto`). */
export function trackerKeyFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('A tracker key needs 16 bytes.');
  let hex = '';
  for (const byte of Array.from(bytes))
    hex += byte.toString(16).padStart(2, '0');
  return `${TRACKER_KEY_PREFIX}${hex}`;
}

/**
 * The preload's witness of a top document's main-world tracker, in its
 * isolated world: `E<key>` when the preload ran before the document had
 * content and asked for the tracker with that key, `L` when it ran late.
 */
export const TRACKER_WITNESS_RESOLVER_KEY = '__canopyBrowserTrackerWitness_v1';

export type TrackerWitness = { early: true; key: string } | { early: false };

export function encodeTrackerWitness(witness: TrackerWitness): string {
  return witness.early ? `E${witness.key}` : 'L';
}

/** Undefined for anything malformed: an unknown document. */
export function decodeTrackerWitness(
  value: unknown,
): TrackerWitness | undefined {
  if (value === 'L') return { early: false };
  if (typeof value !== 'string' || !value.startsWith('E')) return undefined;
  const key = value.slice(1);
  return TRACKER_KEY_PATTERN.test(key) ? { early: true, key } : undefined;
}

export function isolatedTrackerSource(key: string): string {
  return `(() => {
  'use strict';
  const key = ${JSON.stringify(key)};
  if (Reflect.getOwnPropertyDescriptor(globalThis, key) !== undefined) return;
  const doc = document;
  const early = doc.documentElement === null;
  // location.ancestorOrigins, not window.top: reading another window from
  // this world would create empty contexts of this world in that frame.
  const origins = location.ancestorOrigins;
  const child = origins !== undefined && origins !== null && origins.length > 0;
  const tracking = early && child;
  const passwords = new WeakSet();
  let remembered = 0;
  const keep = (element) => {
    if (passwords.has(element)) return;
    passwords.add(element);
    remembered += 1;
  };
  const rememberRemoved = (node) => {
    if (node instanceof HTMLInputElement) {
      if (node.type === 'password') keep(node);
    } else if (node instanceof Element) {
      const inputs = node.getElementsByTagName('input');
      for (let index = 0; index < inputs.length; index += 1) {
        const input = inputs.item(index);
        if (input instanceof HTMLInputElement && input.type === 'password') keep(input);
      }
    }
  };
  // Same-task removal/retype, including a microtask before this callback,
  // retains the transient observer's old type=password record in browsers.
  // A later-task retype follows this callback, which remembers the removal.
  // Per record: O(1) attribute work + O(removed nodes + returned inputs),
  // plus native descendant tag lookup cost for removed elements (potentially
  // their subtree size). No JS tree walk or added-node/text scanning; shadow
  // roots are outside this light-DOM holder's scope.
  const remember = (records) => {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.type === 'childList') {
        for (let removed = 0; removed < record.removedNodes.length; removed += 1) {
          rememberRemoved(record.removedNodes.item(removed));
        }
        continue;
      }
      const old = record.oldValue;
      if (
        record.target instanceof HTMLInputElement &&
        typeof old === 'string' &&
        old.toLowerCase() === 'password'
      ) {
        keep(record.target);
      }
    }
  };
  const observer = tracking ? new MutationObserver(remember) : undefined;
  if (observer) {
    observer.observe(doc, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['type'],
      attributeOldValue: true,
    });
  }
  const answer = (...elements) => {
    if (observer) remember(observer.takeRecords());
    let out = early ? 'E' : 'L';
    if (elements.length === 0) return out + (remembered > 0 ? '1' : '0');
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (
        !tracking ||
        !(element instanceof HTMLInputElement) ||
        element.ownerDocument !== doc
      ) {
        out += '2';
        continue;
      }
      // Remembered wherever it is now, a shadow root of this document
      // included; "never" only in the light DOM this tracker observes.
      if (passwords.has(element)) {
        out += '1';
        continue;
      }
      if (element.getRootNode() !== doc) {
        out += '2';
        continue;
      }
      if (element.type === 'password') {
        keep(element);
        out += '1';
        continue;
      }
      out += '0';
    }
    return out;
  };
  Reflect.defineProperty(globalThis, key, {
    value: answer,
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();`;
}

export function mainWorldTrackerSource(
  key: string,
  options: { documents: TrackedDocuments },
): string {
  return `(() => {
  'use strict';
  const key = ${JSON.stringify(key)};
  const own = Reflect.getOwnPropertyDescriptor;
  const define = Reflect.defineProperty;
  const apply = Reflect.apply;
  if (own(globalThis, key) !== undefined) return;
  // One wrapper per document: the preload installs this tracker in top
  // documents and the CDP-registered script in child documents, whichever
  // runs first.
  const origins = location.ancestorOrigins;
  const child =
    origins !== undefined && origins !== null
      ? origins.length > 0
      : globalThis.parent !== globalThis;
  if (child !== ${JSON.stringify(options.documents === 'child')}) return;
  const doc = document;
  // Late: page script may already hold the original attachShadow or have
  // replaced the built-ins, so nothing is installed and all is unknown.
  if (doc.documentElement !== null) return;
  const elementPrototype = Element.prototype;
  const attach = elementPrototype.attachShadow;
  if (typeof attach !== 'function') return;
  const getter = (prototype, name) => {
    const descriptor = own(prototype, name);
    return descriptor === undefined ? undefined : descriptor.get;
  };
  const rootOf = Node.prototype.getRootNode;
  const nodeType = getter(Node.prototype, 'nodeType');
  const inputsOf = elementPrototype.getElementsByTagName;
  const nodeListLength = getter(NodeList.prototype, 'length');
  const nodeListItem = NodeList.prototype.item;
  const collectionLength = getter(HTMLCollection.prototype, 'length');
  const collectionItem = HTMLCollection.prototype.item;
  const ownerDocument = getter(Node.prototype, 'ownerDocument');
  const localName = getter(elementPrototype, 'localName');
  const namespace = getter(elementPrototype, 'namespaceURI');
  const inputType = getter(HTMLInputElement.prototype, 'type');
  const recordTarget = getter(MutationRecord.prototype, 'target');
  const recordOldValue = getter(MutationRecord.prototype, 'oldValue');
  const recordRemovedNodes = getter(MutationRecord.prototype, 'removedNodes');
  const lowerCase = String.prototype.toLowerCase;
  const has = WeakSet.prototype.has;
  const add = WeakSet.prototype.add;
  const observe = MutationObserver.prototype.observe;
  const takeRecords = MutationObserver.prototype.takeRecords;
  const iterator = Symbol.iterator;
  const roots = new WeakSet();
  const passwords = new WeakSet();
  let remembered = 0;
  const keep = (element) => {
    if (apply(has, passwords, [element])) return;
    apply(add, passwords, [element]);
    remembered += 1;
  };
  const isInput = (node) => {
    try {
      return (
        apply(localName, node, []) === 'input' &&
        apply(namespace, node, []) === 'http://www.w3.org/1999/xhtml'
      );
    } catch {
      return false;
    }
  };
  const rememberRemoved = (node) => {
    if (apply(nodeType, node, []) !== 1) return;
    if (isInput(node)) {
      if (apply(inputType, node, []) === 'password') keep(node);
      return;
    }
    const inputs = apply(inputsOf, node, ['input']);
    const count = apply(collectionLength, inputs, []);
    for (let index = 0; index < count; index += 1) {
      const input = apply(collectionItem, inputs, [index]);
      if (isInput(input) && apply(inputType, input, []) === 'password') keep(input);
    }
  };
  // Same-task removal/retype, including a microtask before this callback,
  // retains the transient observer's old type=password record in browsers.
  // A later-task retype follows this callback, which remembers the removal.
  // Per record: O(1) attribute work + O(removed nodes + returned inputs),
  // plus native descendant tag lookup cost for removed elements (potentially
  // their subtree size). No JS tree walk or added-node/text scanning. Shadow
  // roots inside removed hosts stay directly observed.
  const remember = (records) => {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const removed = apply(recordRemovedNodes, record, []);
      const count = apply(nodeListLength, removed, []);
      for (let index = 0; index < count; index += 1) {
        rememberRemoved(apply(nodeListItem, removed, [index]));
      }
      const old = apply(recordOldValue, record, []);
      const target = apply(recordTarget, record, []);
      if (
        typeof old === 'string' &&
        apply(lowerCase, old, []) === 'password' &&
        isInput(target)
      ) {
        keep(target);
      }
    }
  };
  const observer = new MutationObserver(remember);
  // WebIDL reads attributeFilter (a sequence) through the iteration
  // protocol at every observe(). An array would be read through the page's
  // Array.prototype[Symbol.iterator] and %ArrayIteratorPrototype%.next, so
  // a page could make the filter empty and leave every root unobserved. This
  // iterable, its iterator and its results are the tracker's own objects.
  const attributeFilter = {
    __proto__: null,
    [iterator]() {
      let done = false;
      return {
        __proto__: null,
        next() {
          if (done) return { __proto__: null, done: true, value: undefined };
          done = true;
          return { __proto__: null, done: false, value: 'type' };
        },
      };
    },
  };
  const options = {
    __proto__: null,
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter,
    attributeOldValue: true,
  };
  function attachShadow(init) {
    const root = apply(attach, this, [init]);
    try {
      apply(observe, observer, [root, options]);
      apply(add, roots, [root]);
    } catch {
      // An unobserved root stays untracked, so its inputs are unknown.
    }
    return root;
  }
  define(elementPrototype, 'attachShadow', {
    value: attachShadow,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  const answer = (...elements) => {
    remember(apply(takeRecords, observer, []));
    if (elements.length === 0) return remembered > 0 ? 'E1' : 'E0';
    let out = 'E';
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      let status = '2';
      try {
        if (isInput(element) && apply(ownerDocument, element, []) === doc) {
          // Remembered wherever it is now (light DOM or another root);
          // "never" only in a root created through the hook.
          if (apply(has, passwords, [element])) status = '1';
          else if (apply(has, roots, [apply(rootOf, element, [])])) {
            if (apply(inputType, element, []) === 'password') {
              keep(element);
              status = '1';
            } else status = '0';
          }
        }
      } catch {
        status = '2';
      }
      out += status;
    }
    return out;
  };
  define(globalThis, key, {
    value: answer,
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();`;
}
