import type {
  BrowserActionTargetState,
  BrowserRectangle,
} from '@canopy/desktop-shared/types/browser';
import {
  hostWorldContext,
  type ActionTargetDeps,
  type ResolvedActionTarget,
} from './action-targets';
import {
  decodeFrameOwnerBackendNodeId,
  isCDPRecord,
  readCDPFiniteNumber,
  readCDPString,
} from './cdp-decode';
import type { NodeIdentity } from './frame-registry';
import { HOST_WORLD_NAME, remoteValue, resolveNodeObject } from './host-cdp';
import {
  accessibleName,
  attributeReader,
  REDACTED_ATTRIBUTE_VALUE,
  roleForAttributes,
} from './model-semantics';
import type { BrowserPageModel } from './model-types';

/**
 * The deleted preload's `fillElement` and `setNativeInputValue`, unchanged, run on
 * the target in the frame's host world (D8): page overrides of `value`,
 * `InputEvent` or `dispatchEvent` in the main world cannot change it.
 */
export const FILL_FUNCTION = `function(text) {
  const element = this;
  const owner = element.ownerDocument;
  if (!element.isConnected || !owner || !owner.defaultView || owner.defaultView.document !== owner) return 'target_stale';
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return 'not_fillable';
  element.focus();
  const ownDescriptor = Object.getOwnPropertyDescriptor(element, 'value');
  const prototype = Object.getPrototypeOf(element);
  const prototypeDescriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : undefined;
  if (prototypeDescriptor && prototypeDescriptor.set && prototypeDescriptor.set !== (ownDescriptor && ownDescriptor.set)) {
    prototypeDescriptor.set.call(element, text);
  } else if (ownDescriptor && ownDescriptor.set) {
    ownDescriptor.set.call(element, text);
  } else {
    element.value = text;
  }
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return 'filled';
}`;

/**
 * An editing host's text, with a line break between blocks and at each `<br>`,
 * the way pressing Enter makes them; `textContent` runs the lines together. An
 * empty block is an empty line, and a `<br>` that ends a block only holds it
 * open, so a trailing line the user typed is kept.
 */
export const EDITOR_TEXT_FUNCTION = `function() {
  const root = this;
  const blocks = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL']);
  const skipped = new Set(['SCRIPT', 'STYLE', 'TEMPLATE']);
  const lines = [{ text: '', present: false }];
  let marks = 0;
  const current = () => lines[lines.length - 1];
  const mark = () => {
    current().present = true;
    marks += 1;
  };
  const endLine = () => {
    if (current().present) lines.push({ text: '', present: false });
  };
  const hasContentAfter = node => {
    for (let at = node; at && at !== root; at = at.parentNode) {
      for (let next = at.nextSibling; next; next = next.nextSibling) {
        if (next.nodeType === 3 ? next.data !== '' : next.nodeType === 1 && !skipped.has(next.tagName)) return true;
      }
      const parent = at.parentNode;
      if (parent === root || (parent && parent.nodeType === 1 && blocks.has(parent.tagName))) return false;
    }
    return false;
  };
  const walk = node => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        if (child.data === '') continue;
        current().text += child.data;
        mark();
      } else if (child.nodeType !== 1 || skipped.has(child.tagName)) continue;
      else if (child.tagName === 'BR') {
        mark();
        // A <br> with nothing after it in its block holds the line open.
        if (hasContentAfter(child)) lines.push({ text: '', present: false });
      } else if (blocks.has(child.tagName)) {
        endLine();
        const before = marks;
        walk(child);
        if (marks === before) mark();
        endLine();
      } else walk(child);
    }
  };
  walk(root);
  return lines.filter(line => line.present).map(line => line.text).join('\\n').replace(/\\u00a0/g, ' ');
}`;

/**
 * What the deleted preload's `preparedTargetState` read from the element, in the
 * host world. `focused` is within the element's document, through the
 * hosts of the shadow roots it is in.
 */
/**
 * The option elements a list root holds: the root itself when it is an
 * option, since a combobox can name one directly, and its descendants
 * otherwise. The action and the receipt read a list by this one rule.
 */
export const ARIA_OPTION_ELEMENTS_FUNCTION = `(root) => root.matches('[role="option"]')
  ? [root]
  : Array.from(root.querySelectorAll('[role="option"]'))`;

export const DESCRIBE_FUNCTION = `function(secret) {
  const element = this;
  const owner = element.ownerDocument;
  const view = owner ? owner.defaultView : null;
  if (!element.isConnected || !view || view.document !== owner) return { connected: false };
  const attributes = {};
  for (const name of ['role', 'type', 'href', 'aria-checked', 'aria-controls', 'aria-owns', 'aria-invalid', 'contenteditable']) {
    const value = element.getAttribute(name);
    if (value !== null) attributes[name] = value;
  }
  let focused = false;
  for (let node = element; node; ) {
    const root = node.getRootNode();
    if (!root || root.activeElement !== node) break;
    if (root === owner) { focused = true; break; }
    node = root.host;
  }
  const rect = element.getBoundingClientRect();
  const description = {
    connected: true,
    tagName: element.tagName.toLowerCase(),
    attributes,
    disabled: element.matches(':disabled') || element.closest('[aria-disabled="true" i]') !== null,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport: { width: view.innerWidth, height: view.innerHeight },
    focused,
  };
  if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
    description.checked = element.indeterminate ? 'mixed' : element.checked;
  }
  const role = (element.getAttribute('role') || '').toLowerCase();
  const controlledIds = [element.getAttribute('aria-controls'), element.getAttribute('aria-owns')]
    .filter((value) => value !== null)
    .join(' ')
    .split(/\\s+/)
    .filter((value) => value.length > 0);
  const listRoots = role === 'listbox'
    ? [element]
    : controlledIds
        .map((id) => {
          const scope = element.getRootNode();
          return typeof scope.getElementById === 'function' ? scope.getElementById(id) : null;
        })
        .filter((node) => node !== null);
  const isNativeSelect = element instanceof HTMLSelectElement;
  const isSelectable = isNativeSelect || role === 'listbox' || role === 'combobox' || listRoots.length > 0;
  const isEditable = element.isContentEditable || element.getAttribute('contenteditable') === '' || element.getAttribute('contenteditable') === 'true' || element.getAttribute('contenteditable') === 'plaintext-only';
  const isNativeValue = element instanceof HTMLTextAreaElement || isNativeSelect || (element instanceof HTMLInputElement && !['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'reset', 'submit'].includes(element.type));
  if (secret) {
    description.valueRedacted = true;
    if (isSelectable) description.optionsRedacted = true;
  } else {
    if (isNativeValue) description.value = element.value;
    else if (isEditable) description.value = (${EDITOR_TEXT_FUNCTION}).call(element);
    if (isNativeSelect) {
      description.selectedOptions = Array.from(element.selectedOptions).slice(0, 50).map((option) => ({ value: option.value, label: option.label }));
    } else if (isSelectable) {
      const selected = [];
      const seen = new Set();
      for (const root of listRoots) {
        for (const option of (${ARIA_OPTION_ELEMENTS_FUNCTION})(root)) {
          if (selected.length >= 50) break;
          if (seen.has(option) || (option.getAttribute('aria-selected') || '').toLowerCase() !== 'true') continue;
          seen.add(option);
          const label = (option.textContent || '').replace(/\\s+/g, ' ').trim();
          const dataValue = option.getAttribute('data-value');
          const attributeValue = option.getAttribute('value');
          const value =
            dataValue !== null
              ? dataValue
              : attributeValue !== null
                ? attributeValue
                : label;
          selected.push({ value, label });
        }
      }
      description.selectedOptions = selected;
    }
  }
  const isNativeControl = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
  const ariaInvalid = element.getAttribute('aria-invalid');
  const invalid =
    (isNativeControl && !element.validity.valid) ||
    (ariaInvalid !== null && ariaInvalid.toLowerCase() !== 'false');
  if (isNativeControl || ariaInvalid !== null) description.invalid = invalid;
  if (invalid && !secret && isNativeControl) description.validationMessage = element.validationMessage;
  return description;
}`;

/** An ancestor document's frame owner is that document's active element. */
const OWNER_FOCUSED_FUNCTION = `function() {
  const owner = this.ownerDocument;
  for (let node = this; node; ) {
    const root = node.getRootNode();
    if (!root || root.activeElement !== node) return false;
    if (root === owner) return true;
    node = root.host;
  }
  return false;
}`;

export type FillOutcome = 'filled' | 'not_fillable' | 'target_stale';

interface Description {
  tagName: string;
  attributes: Record<string, string>;
  checked?: boolean | 'mixed';
  value?: string;
  valueRedacted?: boolean;
  selectedOptions?: Array<{ value: string; label: string }>;
  optionsRedacted?: boolean;
  invalid?: boolean;
  validationMessage?: string;
  disabled: boolean;
  rect: BrowserRectangle;
  viewport: { width: number; height: number };
  focused: boolean;
}

function rectangleOf(value: unknown): BrowserRectangle | undefined {
  if (!isCDPRecord(value)) return undefined;
  const x = readCDPFiniteNumber(value.x);
  const y = readCDPFiniteNumber(value.y);
  const width = readCDPFiniteNumber(value.width);
  const height = readCDPFiniteNumber(value.height);
  return x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
    ? undefined
    : { x, y, width, height };
}

function sizeOf(value: unknown): { width: number; height: number } | undefined {
  if (!isCDPRecord(value)) return undefined;
  const width = readCDPFiniteNumber(value.width);
  const height = readCDPFiniteNumber(value.height);
  return width === undefined || height === undefined
    ? undefined
    : { width, height };
}

function decodeDescription(value: unknown): Description | undefined {
  if (!isCDPRecord(value) || value.connected !== true) return undefined;
  const tagName = readCDPString(value.tagName);
  const rect = rectangleOf(value.rect);
  const viewport = sizeOf(value.viewport);
  if (
    tagName === undefined ||
    !rect ||
    !viewport ||
    typeof value.disabled !== 'boolean' ||
    typeof value.focused !== 'boolean' ||
    !isCDPRecord(value.attributes) ||
    (value.checked !== undefined &&
      typeof value.checked !== 'boolean' &&
      value.checked !== 'mixed') ||
    (value.value !== undefined && typeof value.value !== 'string') ||
    (value.valueRedacted !== undefined &&
      typeof value.valueRedacted !== 'boolean') ||
    (value.optionsRedacted !== undefined &&
      typeof value.optionsRedacted !== 'boolean') ||
    (value.invalid !== undefined && typeof value.invalid !== 'boolean') ||
    (value.validationMessage !== undefined &&
      typeof value.validationMessage !== 'string')
  ) {
    return undefined;
  }
  const attributes: Record<string, string> = {};
  for (const name of [
    'role',
    'type',
    'href',
    'aria-checked',
    'aria-controls',
    'aria-owns',
    'aria-invalid',
    'contenteditable',
  ]) {
    const attribute = value.attributes[name];
    if (attribute === undefined) continue;
    if (typeof attribute !== 'string') return undefined;
    attributes[name] = attribute;
  }
  let selectedOptions: Array<{ value: string; label: string }> | undefined;
  if (value.selectedOptions !== undefined) {
    if (
      !Array.isArray(value.selectedOptions) ||
      value.selectedOptions.length > 50
    )
      return undefined;
    selectedOptions = [];
    for (const option of value.selectedOptions) {
      if (
        !isCDPRecord(option) ||
        typeof option.value !== 'string' ||
        typeof option.label !== 'string'
      )
        return undefined;
      selectedOptions.push({ value: option.value, label: option.label });
    }
  }
  return {
    tagName,
    attributes,
    ...(typeof value.checked === 'boolean' || value.checked === 'mixed'
      ? { checked: value.checked }
      : {}),
    ...(typeof value.value === 'string' ? { value: value.value } : {}),
    ...(value.valueRedacted === true ? { valueRedacted: true } : {}),
    ...(selectedOptions === undefined ? {} : { selectedOptions }),
    ...(value.optionsRedacted === true ? { optionsRedacted: true } : {}),
    ...(typeof value.invalid === 'boolean' ? { invalid: value.invalid } : {}),
    ...(typeof value.validationMessage === 'string'
      ? { validationMessage: value.validationMessage }
      : {}),
    disabled: value.disabled,
    rect,
    viewport,
    focused: value.focused,
  };
}

/** The node as an object of its frame's host world, in `objectGroup`. */
export async function hostWorldObject(
  deps: ActionTargetDeps,
  identity: NodeIdentity,
  objectGroup: string,
): Promise<string | undefined> {
  const resolveIn = (contextId: number): Promise<string | undefined> =>
    resolveNodeObject(
      deps.send,
      identity.sessionId,
      identity.backendNodeId,
      objectGroup,
      contextId,
    ).catch(() => undefined);
  const existing = deps.contexts.named(
    identity.frameId,
    identity.sessionId,
    HOST_WORLD_NAME,
  )[0];
  if (existing !== undefined) {
    const objectId = await resolveIn(existing);
    if (objectId) return objectId;
  }
  const created = await hostWorldContext(
    deps,
    identity.frameId,
    identity.sessionId,
    true,
  );
  return created === undefined ? undefined : resolveIn(created);
}

function sameDocument(first: NodeIdentity, second: NodeIdentity): boolean {
  return (
    first.sessionId === second.sessionId &&
    first.frameId === second.frameId &&
    first.loaderId === second.loaderId
  );
}

function hasSecretNodeInSubtree(
  model: BrowserPageModel,
  rootIndex: number,
): boolean {
  const isInSubtree = (candidateIndex: number): boolean => {
    let currentIndex: number | undefined = candidateIndex;
    while (currentIndex !== undefined) {
      if (currentIndex === rootIndex) return true;
      currentIndex = model.nodes[currentIndex]?.parentIndex;
    }
    return false;
  };
  return model.nodes.some(
    (node, index) =>
      isInSubtree(index) && (node.secret || node.insideSecretSelect),
  );
}

function idReferences(node: BrowserPageModel['nodes'][number]): string[] {
  return ['aria-controls', 'aria-owns']
    .flatMap((name) => node.attributes[name]?.split(/\s+/) ?? [])
    .filter((id) => id.length > 0);
}

/**
 * Redacts a live readback from the model's authoritative secrecy markers.
 * Controlled ARIA lists are linked by ids in the already-built model; this
 * lookup intentionally performs no live page value read.
 */
export function isActionTargetSecret(
  model: BrowserPageModel,
  target: ResolvedActionTarget,
): boolean {
  const targetIndex = model.nodes.findIndex(
    (candidate) =>
      sameDocument(candidate.identity, target.identity) &&
      candidate.identity.backendNodeId === target.identity.backendNodeId,
  );
  const node = model.nodes[targetIndex];
  if (!node) return true;
  if (
    node.secret ||
    node.insideSecretSelect ||
    hasSecretNodeInSubtree(model, targetIndex)
  )
    return true;
  // Anything inside a secret element is secret: a child of a secret editing
  // host shows part of the host's text.
  const seen = new Set<number>();
  for (
    let parentIndex = node.parentIndex;
    parentIndex !== undefined && !seen.has(parentIndex);
    parentIndex = model.nodes[parentIndex]?.parentIndex
  ) {
    seen.add(parentIndex);
    if (model.nodes[parentIndex]?.secret) return true;
  }

  // IDs resolve within the target's own tree scope, its document or its
  // shadow root, as the page does: another component can reuse an id.
  const sameScopeNodes = model.nodes
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate }) =>
        sameDocument(candidate.identity, node.identity) &&
        candidate.scopeNodeId === node.scopeNodeId,
    );
  const id = node.attributes.id;
  const controlledIds = new Set(idReferences(node));
  const controlledLists = sameScopeNodes.filter(({ candidate }) =>
    controlledIds.has(candidate.attributes.id ?? ''),
  );
  const foundIds = new Set(
    controlledLists.map(({ candidate }) => candidate.attributes.id),
  );
  // A list that mounts only when it opens is not secret for being absent:
  // select_option asks again once it opens, and the receipt is described
  // from the page after the action. The model withholds the ids inside a
  // secret subtree, though, so an id it cannot find may be one of those.
  if (
    foundIds.size < controlledIds.size &&
    sameScopeNodes.some(
      ({ candidate }) => candidate.attributes.id === REDACTED_ATTRIBUTE_VALUE,
    )
  )
    return true;
  if (
    controlledLists.some(
      ({ candidate, index }) =>
        candidate.secret ||
        candidate.insideSecretSelect ||
        hasSecretNodeInSubtree(model, index),
    )
  )
    return true;

  // A call on the list itself is just as sensitive as a call on its
  // combobox. Also cover a target whose linked control marks its list secret.
  if (id !== undefined) {
    const controls = sameScopeNodes.filter(({ candidate }) =>
      idReferences(candidate).includes(id),
    );
    if (
      controls.some(({ candidate }) =>
        idReferences(candidate).some((controlledId) => {
          const list = sameScopeNodes.find(
            ({ candidate: related }) => related.attributes.id === controlledId,
          );
          return (
            list !== undefined &&
            (list.candidate.secret ||
              list.candidate.insideSecretSelect ||
              hasSecretNodeInSubtree(model, list.index))
          );
        }),
      )
    )
      return true;
  }
  return false;
}

/** Whether every ancestor document's active element is the frame's owner. */
async function ownersFocused(
  deps: ActionTargetDeps,
  identity: NodeIdentity,
  objectGroup: string,
): Promise<boolean> {
  let frame = deps.registry.getFrame(identity.frameId);
  for (let level = 0; frame?.parentId !== undefined && level < 10; level += 1) {
    const parent = deps.registry.getFrame(frame.parentId);
    if (!parent?.loaderId) return false;
    const ownerBackendNodeId = decodeFrameOwnerBackendNodeId(
      await deps
        .send('DOM.getFrameOwner', { frameId: frame.frameId }, parent.sessionId)
        .catch(() => undefined),
    );
    if (ownerBackendNodeId === undefined) return false;
    const objectId = await hostWorldObject(
      deps,
      {
        sessionId: parent.sessionId,
        frameId: parent.frameId,
        loaderId: parent.loaderId,
        backendNodeId: ownerBackendNodeId,
      },
      objectGroup,
    );
    if (!objectId) return false;
    const focused = remoteValue(
      await deps
        .send(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: OWNER_FOCUSED_FUNCTION,
            returnByValue: true,
          },
          parent.sessionId,
        )
        .catch(() => undefined),
    );
    if (focused !== true) return false;
    frame = parent;
  }
  return true;
}

function intersects(
  first: BrowserRectangle,
  second: BrowserRectangle,
): boolean {
  return (
    first.x < second.x + second.width &&
    second.x < first.x + first.width &&
    first.y < second.y + second.height &&
    second.y < first.y + first.height
  );
}

function inputTypeFrom(
  tagName: string,
  read: (name: string) => string | undefined,
): string | undefined {
  if (tagName === 'input') return (read('type') ?? 'text').toLowerCase();
  if (tagName === 'textarea') return 'textarea';
  if (tagName === 'select') return 'select';
  if (tagName === 'button') return (read('type') ?? 'submit').toLowerCase();
  return undefined;
}

/**
 * The `BrowserActionTargetState` of a resolved target, read from its
 * retained node without re-running a locator: live state from the host
 * world; `ref`, the name and its secrecy from the model; `bounds` and
 * `inViewport` in top-level coordinates through the frame's transform at
 * the model's capture. Undefined when the node left its document or
 * cannot be read.
 */
export async function describeActionTarget(
  deps: ActionTargetDeps,
  model: BrowserPageModel,
  target: ResolvedActionTarget,
  options: { secret?: boolean } = {},
): Promise<BrowserActionTargetState | undefined> {
  const { identity } = target;
  const node = model.nodes.find(
    (candidate) =>
      sameDocument(candidate.identity, identity) &&
      candidate.identity.backendNodeId === identity.backendNodeId,
  );
  // A target that was secret before the action stays secret: a page can
  // drop the marker that made it so.
  const secret = options.secret === true || isActionTargetSecret(model, target);
  const objectId = await hostWorldObject(deps, identity, target.objectGroup);
  if (!objectId) return undefined;
  const description = decodeDescription(
    remoteValue(
      await deps
        .send(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: DESCRIBE_FUNCTION,
            arguments: [{ value: secret }],
            returnByValue: true,
          },
          identity.sessionId,
        )
        .catch(() => undefined),
    ),
  );
  if (!description) return undefined;
  const read = attributeReader(description.attributes);
  const frame = model.frames.find(
    (candidate) =>
      candidate.frameId === identity.frameId &&
      candidate.sessionId === identity.sessionId,
  );
  const transform = frame?.viewportTransform ?? {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
  };
  const local = description.rect;
  const top = {
    x: transform.x + transform.scaleX * local.x,
    y: transform.y + transform.scaleY * local.y,
    width: transform.scaleX * local.width,
    height: transform.scaleY * local.height,
  };
  // The preload's rule in the element's own viewport, then, inside a
  // frame, the frame's visible part of the top-level viewport.
  const inFrameViewport =
    local.width > 0 &&
    local.height > 0 &&
    local.y + local.height > 0 &&
    local.x + local.width > 0 &&
    local.y < description.viewport.height &&
    local.x < description.viewport.width;
  const inViewport =
    inFrameViewport &&
    (frame === undefined ||
      frame.parentFrameId === undefined ||
      intersects(top, frame.clip));
  const focused =
    description.focused &&
    (await ownersFocused(deps, identity, target.objectGroup));
  const modelRole = node?.attributes.role?.toLowerCase();
  const suppressName =
    node !== undefined &&
    (node.insideSecretSelect ||
      (secret &&
        (node.tagName.toLowerCase() === 'select' ||
          modelRole === 'combobox' ||
          modelRole === 'listbox' ||
          modelRole === 'option')));
  const name = node && !suppressName ? accessibleName(model, node) : '';
  const ariaChecked = read('aria-checked');
  const checked: boolean | 'mixed' | undefined =
    description.checked !== undefined
      ? description.checked
      : ariaChecked === 'mixed'
        ? 'mixed'
        : ariaChecked === 'true'
          ? true
          : ariaChecked === 'false'
            ? false
            : undefined;
  const role = roleForAttributes(description.tagName, read);
  const inputType = inputTypeFrom(description.tagName, read);
  let ref = target.ref;
  if (ref === undefined) {
    try {
      ref = deps.registry.mintRef(identity);
    } catch {
      ref = undefined;
    }
  }
  return {
    tagName: description.tagName,
    ...(role === undefined ? {} : { role }),
    ...(name ? { name } : {}),
    ...(inputType === undefined ? {} : { inputType }),
    disabled: description.disabled,
    focused,
    inViewport,
    bounds: {
      x: Math.round(top.x),
      y: Math.round(top.y),
      width: Math.round(top.width),
      height: Math.round(top.height),
    },
    ...(checked === undefined ? {} : { checked }),
    ...(secret
      ? { valueRedacted: true }
      : description.value === undefined
        ? {}
        : { value: description.value }),
    ...(secret
      ? description.optionsRedacted === true ||
        description.selectedOptions !== undefined ||
        inputType === 'select' ||
        read('role') === 'combobox' ||
        read('role') === 'listbox' ||
        read('aria-controls') !== undefined ||
        read('aria-owns') !== undefined ||
        node?.tagName.toLowerCase() === 'select' ||
        node?.attributes.role?.toLowerCase() === 'combobox' ||
        node?.attributes.role?.toLowerCase() === 'listbox' ||
        (node !== undefined && idReferences(node).length > 0)
        ? { optionsRedacted: true }
        : {}
      : description.selectedOptions === undefined
        ? {}
        : { selectedOptions: description.selectedOptions }),
    ...(description.invalid === undefined
      ? {}
      : { invalid: description.invalid }),
    ...(secret ||
    description.invalid !== true ||
    description.validationMessage === undefined
      ? {}
      : { validationMessage: description.validationMessage }),
    ...(ref === undefined ? {} : { ref }),
  };
}

/**
 * Fills a resolved `input` or `textarea` (D8). A CDP failure, such as a
 * dialog the page opened from an `input` listener, propagates to the
 * caller's dispatch handling. Once `signal` aborts, it rejects instead of
 * writing: the check runs immediately before the setter is sent, because
 * resolving the host world can take long enough for the action to be
 * cancelled meanwhile.
 */
export async function fillActionTarget(
  deps: ActionTargetDeps,
  target: ResolvedActionTarget,
  text: string,
  signal?: AbortSignal,
): Promise<FillOutcome> {
  signal?.throwIfAborted();
  const objectId = await hostWorldObject(
    deps,
    target.identity,
    target.objectGroup,
  );
  if (!objectId) return 'target_stale';
  signal?.throwIfAborted();
  const outcome = remoteValue(
    await deps.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: FILL_FUNCTION,
        arguments: [{ value: text }],
        userGesture: true,
        returnByValue: true,
        objectGroup: target.objectGroup,
      },
      target.identity.sessionId,
    ),
  );
  return outcome === 'filled' || outcome === 'not_fillable'
    ? outcome
    : 'target_stale';
}
