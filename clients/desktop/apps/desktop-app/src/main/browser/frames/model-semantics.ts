import type { BrowserLocatorCandidate } from '@canopy/desktop-shared/types/browser';
import type { BrowserPageModel, PageModelNode } from './model-types';

const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test', 'data-cy'];
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

interface ScopedSemanticIndex {
  ids: Map<string, PageModelNode>;
  idCounts: Map<string, number>;
  labelsFor: Map<string, PageModelNode>;
  testIdCounts: Map<string, number>;
  uniqueLeafText: Map<string, PageModelNode | null>;
  rootTags: Map<string, number>;
}

interface SiblingPosition {
  index: number;
  count: number;
}

type MarkupTask =
  | { kind: 'node'; nodeIndex: number; textBlocked: boolean }
  | { kind: 'close'; nodeIndex: number }
  | { kind: 'text'; value: string };

interface SemanticIndex {
  attributes: WeakMap<PageModelNode, Map<string, string>>;
  nodeIndexes: WeakMap<PageModelNode, number>;
  scoped: Map<string, ScopedSemanticIndex>;
  siblingPositions: Map<number, SiblingPosition>;
}

const semanticIndexes = new WeakMap<BrowserPageModel, SemanticIndex>();
const normalizedAttributesByNode = new WeakMap<
  PageModelNode,
  Map<string, string>
>();
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** Compacts whitespace and bounds model text like the in-page preload helper. */
/** Longest node text the page model keeps. */
export const MODEL_TEXT_LIMIT = 120;

/** Stands in for an attribute value the page model withholds. */
export const REDACTED_ATTRIBUTE_VALUE = '[redacted]';

export function compactText(
  value: string | null | undefined,
  max = 120,
): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Reads one attribute by lowercase name. */
export type AttributeReader = (name: string) => string | undefined;

/** The preload's `roleFor`, over a tag name and its attributes. */
export function roleForAttributes(
  tagName: string,
  read: AttributeReader,
): string | undefined {
  const explicit = read('role')?.trim();
  if (explicit) return explicit;

  const tag = tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && read('href') !== undefined) return 'link';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = (read('type') ?? 'text').toLowerCase();
    if (['button', 'submit', 'reset'].includes(type)) return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'search') return 'searchbox';
    if (type === 'number') return 'spinbutton';
    if (type === 'range') return 'slider';
    return 'textbox';
  }
  // Beyond the preload: roles agents target that are not controls. Images
  // keep no role, so their locators stay getByAltText.
  if (/^h[1-6]$/.test(tag)) return 'heading';
  return IMPLICIT_LANDMARK_ROLES.get(tag);
}

// A Map, so a tag named like an Object.prototype member is never a role.
const IMPLICIT_LANDMARK_ROLES = new Map<string, string>([
  ['main', 'main'],
  ['nav', 'navigation'],
  ['aside', 'complementary'],
  ['dialog', 'dialog'],
  ['ul', 'list'],
  ['ol', 'list'],
  ['li', 'listitem'],
]);
const AUTHOR_NAMED_ROLES = new Set(IMPLICIT_LANDMARK_ROLES.values());

/** The deleted preload's `isInteractiveElement`, over a tag name and its attributes. */
export function isInteractiveAttributes(
  tagName: string,
  read: AttributeReader,
): boolean {
  const tag = tagName.toLowerCase();
  if (['input', 'textarea', 'select', 'button'].includes(tag)) return true;
  if (tag === 'a' && read('href') !== undefined) return true;
  const contentEditable = read('contenteditable')?.trim().toLowerCase();
  if (
    contentEditable === '' ||
    contentEditable === 'true' ||
    contentEditable === 'plaintext-only'
  ) {
    return true;
  }
  const tabIndex = read('tabindex');
  if (tabIndex !== undefined && tabIndex !== '-1') return true;
  const role = roleForAttributes(tag, read);
  return role !== undefined && INTERACTIVE_ROLES.has(role.toLowerCase());
}

/** Reads attributes case-insensitively, like `getAttribute` in HTML. */
export function attributeReader(
  attributes: Record<string, string>,
): AttributeReader {
  return (name: string): string | undefined => {
    const lower = name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(attributes, lower)) {
      return attributes[lower];
    }
    for (const [key, value] of Object.entries(attributes)) {
      if (key.toLowerCase() === lower) return value;
    }
    return undefined;
  };
}

/** Returns the preload-compatible semantic role for a frozen model node. */
export function roleFor(node: PageModelNode): string | undefined {
  return roleForAttributes(node.tagName, (name) => attribute(node, name));
}

/** Returns the preload-compatible HTML input type, when the node has one. */
export function inputTypeFor(node: PageModelNode): string | undefined {
  const tag = node.tagName.toLowerCase();
  if (tag === 'input') return (attribute(node, 'type') ?? 'text').toLowerCase();
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'button')
    return (attribute(node, 'type') ?? 'submit').toLowerCase();
  return undefined;
}

/** Returns true for the interactive element shapes recognized by the preload. */
export function isInteractiveElement(node: PageModelNode): boolean {
  return isInteractiveAttributes(node.tagName, (name) => attribute(node, name));
}

/**
 * Mirrors the deleted preload's self-node hidden test. Computed styles account
 * for inherited visibility, but ancestor attributes are deliberately ignored.
 * A node whose missing-layout style read was skipped counts as hidden.
 */
export function isHiddenElement(node: PageModelNode): boolean {
  if (node.styleUnknown === true) return true;
  if (attribute(node, 'hidden') !== undefined) return true;
  if (attribute(node, 'aria-hidden') === 'true') return true;
  return (
    node.computedStyles.display === 'none' ||
    node.computedStyles.visibility === 'hidden'
  );
}

/** Returns redaction-safe associated label text for an element. */
export function labelTextForControl(
  model: BrowserPageModel,
  node: PageModelNode,
): string | undefined {
  const index = indexFor(model);
  const scoped = index.scoped.get(scopeKey(node));
  const id = attribute(node, 'id');
  if (id && scoped) {
    const label = scoped.labelsFor.get(id);
    const text = labelTextForNode(label);
    if (text) return text;
  }

  let currentIndex = index.nodeIndexes.get(node);
  const seen = new Set<number>();
  while (currentIndex !== undefined && !seen.has(currentIndex)) {
    seen.add(currentIndex);
    const current = model.nodes[currentIndex];
    if (!current) break;
    if (current.tagName.toLowerCase() === 'label') {
      const text = labelTextForNode(current);
      return text || undefined;
    }
    if (!sameScope(node, current) || current.parentIndex === undefined) break;
    currentIndex = current.parentIndex;
  }
  return undefined;
}

const accessibleNames = new WeakMap<PageModelNode, string>();

/**
 * Returns the preload-compatible accessible name without reading live DOM.
 * A model is frozen once built, so each node's name is computed once.
 */
export function accessibleName(
  model: BrowserPageModel,
  node: PageModelNode,
): string {
  const cached = accessibleNames.get(node);
  if (cached !== undefined) return cached;
  const name = computeAccessibleName(model, node);
  accessibleNames.set(node, name);
  return name;
}

function computeAccessibleName(
  model: BrowserPageModel,
  node: PageModelNode,
): string {
  const aria = attribute(node, 'aria-label');
  if (aria?.trim()) return compactText(aria);

  const labelledBy = attribute(node, 'aria-labelledby');
  if (labelledBy) {
    const index = indexFor(model);
    const scoped = index.scoped.get(scopeKey(node));
    const text = labelledBy
      .split(/\s+/)
      .map((id) => nameTextForNode(scoped?.ids.get(id)))
      .join(' ');
    if (text.trim()) return compactText(text);
  }

  if (['input', 'textarea', 'select'].includes(node.tagName.toLowerCase())) {
    const label = labelTextForControl(model, node);
    if (label) return label;
  }

  if (isSecretValue(node) || node.hasSecretDescendant) return '';
  return compactText(
    attribute(node, 'alt') ?? attribute(node, 'title') ?? node.text,
  );
}

/** True when the node or its subtree contains data withheld from page text. */
export function hasRedactedContent(node: PageModelNode): boolean {
  return node.secret || node.insideSecretSelect || node.hasSecretDescendant;
}

/**
 * Returns locator candidates in preload order, as page-level strings. On a
 * page with shadow roots or frames they are scoped and verified by
 * `locatorCandidatesFor` before use.
 */
export function generateLocatorCandidates(
  model: BrowserPageModel,
  node: PageModelNode,
): BrowserLocatorCandidate[] {
  if (node.insideSecretSelect) return [];

  if (isSecretValue(node) || node.hasSecretDescendant) {
    const css = uniqueCssSelector(model, node);
    return [cssCandidate(model, node, css)];
  }

  const candidates: BrowserLocatorCandidate[] = [];
  const scoped = indexFor(model).scoped.get(scopeKey(node));
  for (const attr of TEST_ID_ATTRIBUTES) {
    const value = attribute(node, attr);
    if (value?.trim()) {
      const trimmed = value.trim();
      const count = scoped?.testIdCounts.get(valueKey(attr, trimmed)) ?? 0;
      candidates.push({
        kind: 'testId',
        value: trimmed,
        unique: count === 1,
        confidence: count === 1 ? 'high' : 'medium',
        playwright: `page.getByTestId(${quote(trimmed)})`,
      });
      break;
    }
  }

  const role = roleFor(node);
  const name = accessibleName(model, node);
  // Playwright names list and landmark roles only from author labels.
  const authorNamed =
    !!attribute(node, 'aria-label')?.trim() ||
    !!attribute(node, 'aria-labelledby')?.trim();
  if (role && name && (authorNamed || !AUTHOR_NAMED_ROLES.has(role))) {
    candidates.push({
      kind: 'role',
      value: role,
      name,
      unique: false,
      confidence: 'high',
      playwright: `page.getByRole(${quote(role)}, { name: ${quote(name)} })`,
    });
  }

  const label = labelTextForControl(model, node);
  if (label) {
    candidates.push({
      kind: 'label',
      value: label,
      unique: false,
      confidence: 'high',
      playwright: `page.getByLabel(${quote(label)})`,
    });
  }

  const placeholder = attribute(node, 'placeholder');
  if (placeholder?.trim()) {
    const value = placeholder.trim();
    candidates.push({
      kind: 'placeholder',
      value,
      unique: false,
      confidence: 'high',
      playwright: `page.getByPlaceholder(${quote(value)})`,
    });
  }

  const alt = attribute(node, 'alt');
  if (alt?.trim()) {
    const value = alt.trim();
    candidates.push({
      kind: 'alt',
      value,
      unique: false,
      confidence: 'medium',
      playwright: `page.getByAltText(${quote(value)})`,
    });
  }

  const title = attribute(node, 'title');
  if (title?.trim()) {
    candidates.push({
      kind: 'title',
      value: title.trim(),
      unique: false,
      confidence: 'medium',
    });
  }

  const id = attribute(node, 'id');
  if (id?.trim()) {
    const value = id.trim();
    const selector = `#${cssEscape(value)}`;
    const count = scoped?.idCounts.get(value) ?? 0;
    candidates.push({
      kind: 'css',
      value: selector,
      unique: count === 1,
      confidence: count === 1 ? 'high' : 'medium',
      playwright: `page.locator(${quote(selector)})`,
    });
  }

  const text = compactText(node.text);
  const uniqueLeaf = text ? scoped?.uniqueLeafText.get(text) === node : false;
  if (text && text.length <= 80 && uniqueLeaf) {
    candidates.push({
      kind: 'text',
      value: text,
      unique: true,
      confidence: 'high',
      playwright: `page.getByText(${quote(text)})`,
    });
  }

  const css = uniqueCssSelector(model, node);
  candidates.push(cssCandidate(model, node, css));

  const path = domPathSelector(model, node);
  const pathIsUnique = structuralPathIsUnique(model, node);
  candidates.push({
    kind: 'domPath',
    value: path,
    unique: pathIsUnique,
    confidence: 'low',
    playwright: `page.locator(${quote(path)})`,
  });

  return candidates;
}

/** Returns the node's generated structural CSS selector. */
export function uniqueCssSelector(
  model: BrowserPageModel,
  node: PageModelNode,
): string {
  const index = indexFor(model);
  const parts: string[] = [];
  let currentIndex = index.nodeIndexes.get(node);
  const seen = new Set<number>();

  while (currentIndex !== undefined && !seen.has(currentIndex)) {
    seen.add(currentIndex);
    const current = model.nodes[currentIndex];
    if (!current) break;
    const tag = current.tagName.toLowerCase();
    if (tag === 'html' && current !== node) break;

    const id = attribute(current, 'id');
    if (id) {
      parts.unshift(`${tag}#${cssEscape(id)}`);
      break;
    }

    parts.unshift(structuralSegment(index, currentIndex, current));
    const parentIndex = current.parentIndex;
    if (parentIndex === undefined || seen.has(parentIndex)) break;
    const parent = model.nodes[parentIndex];
    if (!parent || parent.nodeType !== 1 || !sameScope(node, parent)) break;
    if (parent.tagName.toLowerCase() === 'html') break;
    currentIndex = parentIndex;
  }

  const selector = parts.join(' > ');
  return selector || node.tagName.toLowerCase();
}

/** Returns the tag-only DOM path used by the preload inspection fallback. */
export function domPathForNode(
  model: BrowserPageModel,
  node: PageModelNode,
): string[] {
  const index = indexFor(model);
  const parts: string[] = [];
  let currentIndex = index.nodeIndexes.get(node);
  const seen = new Set<number>();
  while (currentIndex !== undefined && !seen.has(currentIndex)) {
    seen.add(currentIndex);
    const current = model.nodes[currentIndex];
    if (!current) break;
    if (current.nodeType === 1) parts.unshift(current.tagName.toLowerCase());
    const parentIndex = current.parentIndex;
    if (parentIndex === undefined || seen.has(parentIndex)) break;
    const parent = model.nodes[parentIndex];
    if (!parent || !sameScope(node, parent)) break;
    if (parent.nodeType !== 1) break;
    currentIndex = parentIndex;
  }
  return parts;
}

/**
 * Builds conservative outerHTML from already-redacted model data. No text is
 * written below an element that is secret or contains a secret control: a
 * page can mirror a secret value into nearby text.
 */
export function safeOuterHtml(
  model: BrowserPageModel,
  node: PageModelNode,
  max = 10_000,
): string {
  if (node.insideSecretSelect) return '';

  const index = indexFor(model);
  const rootIndex = index.nodeIndexes.get(node);
  if (rootIndex === undefined) return '';

  const chunks: string[] = [];
  let length = 0;
  const open: MarkupTask[] = [
    { kind: 'node', nodeIndex: rootIndex, textBlocked: false },
  ];
  const visited = new Set<number>();

  while (open.length > 0 && length < max) {
    const next = open.pop();
    if (!next) break;
    if (next.kind === 'text') {
      chunks.push(next.value);
      length += next.value.length;
      continue;
    }
    const current = model.nodes[next.nodeIndex];
    if (!current) continue;

    if (next.kind === 'close') {
      const closing = `</${current.tagName.toLowerCase()}>`;
      chunks.push(closing);
      length += closing.length;
      continue;
    }
    if (visited.has(next.nodeIndex) || current.nodeType !== 1) continue;
    visited.add(next.nodeIndex);
    if (current.insideSecretSelect) continue;

    const tag = safeTagName(current.tagName);
    if (!tag) continue;
    const openTag = safeOpeningTag(current, tag, index.attributes.get(current));
    chunks.push(openTag);
    length += openTag.length;
    if (isVoidElement(tag)) continue;
    open.push({ kind: 'close', nodeIndex: next.nodeIndex });

    if (tag === 'textarea' || (current.secret && tag === 'select')) continue;
    const textBlocked =
      next.textBlocked || current.secret || current.hasSecretDescendant;

    const hasTextChildren = current.childIndexes.some((childIndex) => {
      const child = model.nodes[childIndex];
      return child?.nodeType === 3;
    });
    for (
      let childPosition = current.childIndexes.length - 1;
      childPosition >= 0;
      childPosition -= 1
    ) {
      const childIndex = current.childIndexes[childPosition];
      if (childIndex === undefined) continue;
      const child = model.nodes[childIndex];
      if (!child || !sameScope(current, child) || child.insideSecretSelect)
        continue;
      if (child.nodeType === 3) {
        const text =
          textBlocked || child.secret ? '' : child.ownText || child.text;
        if (text) open.push({ kind: 'text', value: escapeHtmlText(text) });
      } else if (child.nodeType === 1) {
        open.push({ kind: 'node', nodeIndex: childIndex, textBlocked });
      }
    }

    if (!hasTextChildren && !textBlocked && current.ownText) {
      open.push({ kind: 'text', value: escapeHtmlText(current.ownText) });
    }
  }

  return chunks.join('').slice(0, max);
}

function indexFor(model: BrowserPageModel): SemanticIndex {
  const cached = semanticIndexes.get(model);
  if (cached) return cached;

  const attributes = new WeakMap<PageModelNode, Map<string, string>>();
  const nodeIndexes = new WeakMap<PageModelNode, number>();
  const scoped = new Map<string, ScopedSemanticIndex>();
  const siblingPositions = new Map<number, SiblingPosition>();

  const getScoped = (key: string): ScopedSemanticIndex => {
    const current = scoped.get(key);
    if (current) return current;
    const created: ScopedSemanticIndex = {
      ids: new Map(),
      idCounts: new Map(),
      labelsFor: new Map(),
      testIdCounts: new Map(),
      uniqueLeafText: new Map(),
      rootTags: new Map(),
    };
    scoped.set(key, created);
    return created;
  };

  model.nodes.forEach((node, nodeIndex) => {
    nodeIndexes.set(node, nodeIndex);
    const nodeAttributes = normalizedAttributesFor(node);
    attributes.set(node, nodeAttributes);

    const scopedIndex = getScoped(scopeKey(node));
    if (node.nodeType !== 1) return;

    const id = nodeAttributes.get('id');
    if (id) {
      if (!scopedIndex.ids.has(id)) scopedIndex.ids.set(id, node);
      scopedIndex.idCounts.set(id, (scopedIndex.idCounts.get(id) ?? 0) + 1);
    }

    if (node.tagName.toLowerCase() === 'label') {
      const forId = nodeAttributes.get('for');
      if (forId !== undefined && !scopedIndex.labelsFor.has(forId)) {
        scopedIndex.labelsFor.set(forId, node);
      }
    }

    for (const attr of TEST_ID_ATTRIBUTES) {
      const value = nodeAttributes.get(attr);
      if (!value?.trim()) continue;
      const key = valueKey(attr, value.trim());
      scopedIndex.testIdCounts.set(
        key,
        (scopedIndex.testIdCounts.get(key) ?? 0) + 1,
      );
    }

    const text = compactText(node.text);
    if (!text) return;
    const hasSameTextChild = node.childIndexes.some((childIndex) => {
      const child = model.nodes[childIndex];
      return (
        child !== undefined &&
        child.nodeType === 1 &&
        sameScope(node, child) &&
        compactText(child.text) === text
      );
    });
    if (!hasSameTextChild) {
      scopedIndex.uniqueLeafText.set(
        text,
        scopedIndex.uniqueLeafText.has(text) ? null : node,
      );
    }
  });

  model.nodes.forEach((parent) => {
    const counts = new Map<string, number>();
    for (const childIndex of parent.childIndexes) {
      const child = model.nodes[childIndex];
      if (!child || child.nodeType !== 1 || !sameScope(parent, child)) continue;
      const tag = child.tagName.toLowerCase();
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }

    const positions = new Map<string, number>();
    for (const childIndex of parent.childIndexes) {
      const child = model.nodes[childIndex];
      if (!child || child.nodeType !== 1 || !sameScope(parent, child)) continue;
      const tag = child.tagName.toLowerCase();
      const position = (positions.get(tag) ?? 0) + 1;
      positions.set(tag, position);
      siblingPositions.set(childIndex, {
        index: position,
        count: counts.get(tag) ?? 1,
      });
    }
    const scopedIndex = getScoped(scopeKey(parent));
    if (parent.nodeType !== 1) {
      for (const childIndex of parent.childIndexes) {
        const child = model.nodes[childIndex];
        if (!child || child.nodeType !== 1 || !sameScope(parent, child))
          continue;
        const tag = child.tagName.toLowerCase();
        scopedIndex.rootTags.set(tag, (scopedIndex.rootTags.get(tag) ?? 0) + 1);
      }
    }
  });

  const created: SemanticIndex = {
    attributes,
    nodeIndexes,
    scoped,
    siblingPositions,
  };
  semanticIndexes.set(model, created);
  return created;
}

function attribute(node: PageModelNode, name: string): string | undefined {
  return normalizedAttributesFor(node).get(name.toLowerCase());
}

/** Reads a frozen model attribute without re-decoding or consulting live DOM. */
export function attributeForNode(
  node: PageModelNode,
  name: string,
): string | undefined {
  return attribute(node, name);
}

function normalizedAttributesFor(node: PageModelNode): Map<string, string> {
  const cached = normalizedAttributesByNode.get(node);
  if (cached) return cached;
  const attributes = new Map<string, string>();
  for (const [name, value] of Object.entries(node.attributes)) {
    const normalizedName = name.toLowerCase();
    if (!attributes.has(normalizedName)) attributes.set(normalizedName, value);
  }
  normalizedAttributesByNode.set(node, attributes);
  return attributes;
}

function labelTextForNode(node: PageModelNode | undefined): string {
  if (!node || node.secret || node.insideSecretSelect) return '';
  return compactText(node.labelText);
}

function nameTextForNode(node: PageModelNode | undefined): string {
  if (!node || node.secret || node.insideSecretSelect) return '';
  return compactText(node.nameText ?? node.labelText);
}

function isSecretValue(node: PageModelNode): boolean {
  return node.secret || node.insideSecretSelect;
}

function sameScope(left: PageModelNode, right: PageModelNode): boolean {
  return (
    left.frameRef === right.frameRef && left.scopeNodeId === right.scopeNodeId
  );
}

function scopeKey(node: PageModelNode): string {
  return `${node.frameRef}\u0000${node.scopeNodeId}`;
}

function valueKey(attributeName: string, value: string): string {
  return `${attributeName}\u0000${value}`;
}

/** `CSS.escape`, with a spec port where the global is unavailable. */
export function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  let escaped = '';
  const characters: string[] = Array.from(value);
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === undefined) continue;
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint === 0) {
      escaped += '\uFFFD';
      continue;
    }
    if (
      (codePoint >= 1 && codePoint <= 31) ||
      codePoint === 127 ||
      (index === 0 && codePoint >= 48 && codePoint <= 57) ||
      (index === 1 &&
        characters[0] === '-' &&
        codePoint >= 48 &&
        codePoint <= 57)
    ) {
      escaped += `\\${codePoint.toString(16)} `;
      continue;
    }
    if (
      codePoint >= 128 ||
      character === '-' ||
      character === '_' ||
      (codePoint >= 48 && codePoint <= 57) ||
      (codePoint >= 65 && codePoint <= 90) ||
      (codePoint >= 97 && codePoint <= 122)
    ) {
      escaped += character;
      continue;
    }
    escaped += `\\${character}`;
  }
  return escaped;
}

/** Quotes a locator argument the way the preload does, line breaks included. */
export function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `'${escaped}'`;
}

function cssCandidate(
  model: BrowserPageModel,
  node: PageModelNode,
  selector: string,
): BrowserLocatorCandidate {
  const unique = structuralPathIsUnique(model, node);
  return {
    kind: 'css',
    value: selector,
    unique,
    confidence: unique ? 'high' : 'medium',
    playwright: `page.locator(${quote(selector)})`,
  };
}

function structuralSegment(
  index: SemanticIndex,
  nodeIndex: number,
  node: PageModelNode,
): string {
  const tag = node.tagName.toLowerCase();
  const position = index.siblingPositions.get(nodeIndex);
  if (!position || position.count <= 1) return tag;
  return `${tag}:nth-of-type(${position.index})`;
}

function structuralPathIsUnique(
  model: BrowserPageModel,
  node: PageModelNode,
): boolean {
  const index = indexFor(model);
  const nodeIndex = index.nodeIndexes.get(node);
  if (nodeIndex === undefined) return false;
  let currentIndex = nodeIndex;
  const seen = new Set<number>();
  while (!seen.has(currentIndex)) {
    seen.add(currentIndex);
    const current = model.nodes[currentIndex];
    if (!current) return false;
    const id = attribute(current, 'id');
    if (id) {
      const scoped = index.scoped.get(scopeKey(node));
      return (scoped?.idCounts.get(id) ?? 0) === 1;
    }
    const parentIndex = current.parentIndex;
    if (parentIndex === undefined) {
      const scoped = index.scoped.get(scopeKey(node));
      return (scoped?.rootTags.get(current.tagName.toLowerCase()) ?? 0) <= 1;
    }
    const parent = model.nodes[parentIndex];
    if (!parent || !sameScope(node, parent)) return false;
    if (parent.nodeType !== 1) {
      const scoped = index.scoped.get(scopeKey(node));
      return (scoped?.rootTags.get(current.tagName.toLowerCase()) ?? 0) <= 1;
    }
    currentIndex = parentIndex;
  }
  return false;
}

/** Returns the node's full structural path from its document or shadow root. */
export function domPathSelector(
  model: BrowserPageModel,
  node: PageModelNode,
): string {
  const index = indexFor(model);
  const parts: string[] = [];
  let currentIndex = index.nodeIndexes.get(node);
  const seen = new Set<number>();
  while (currentIndex !== undefined && !seen.has(currentIndex)) {
    seen.add(currentIndex);
    const current = model.nodes[currentIndex];
    if (!current) break;
    if (current.nodeType === 1) {
      parts.unshift(structuralSegment(index, currentIndex, current));
    }
    const parentIndex = current.parentIndex;
    if (parentIndex === undefined || seen.has(parentIndex)) break;
    const parent = model.nodes[parentIndex];
    if (!parent || !sameScope(node, parent) || parent.nodeType !== 1) break;
    currentIndex = parentIndex;
  }
  return parts.join(' > ') || node.tagName.toLowerCase();
}

function safeTagName(value: string): string | undefined {
  const normalized = value.toLowerCase();
  return /^[a-z][a-z0-9:-]*$/.test(normalized) ? normalized : undefined;
}

function safeOpeningTag(
  node: PageModelNode,
  tag: string,
  normalizedAttributes: Map<string, string> | undefined,
): string {
  const source = normalizedAttributes ?? new Map<string, string>();
  const attributes: string[] = [];
  const sourceNames: string[] = Array.from(source.keys());
  for (const name of sourceNames) {
    const value = source.get(name);
    if (value === undefined) continue;
    if (
      name === 'value' ||
      (node.insideSecretSelect && name === 'selected') ||
      (node.secret && tag === 'select' && name === 'selected') ||
      !/^[a-z_:][a-z0-9_.:-]*$/.test(name)
    ) {
      continue;
    }
    attributes.push(`${name}="${escapeHtmlAttribute(value)}"`);
  }
  return attributes.length > 0
    ? `<${tag} ${attributes.join(' ')}>`
    : `<${tag}>`;
}

function isVoidElement(tag: string): boolean {
  return VOID_ELEMENTS.has(tag);
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, '&quot;');
}
