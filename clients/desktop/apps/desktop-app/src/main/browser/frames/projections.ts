import type {
  BrowserElementSnapshot,
  BrowserInputSnapshotFilter,
  BrowserInputSnapshotItem,
  BrowserInputSnapshotRequest,
  BrowserInputSnapshotResponse,
  BrowserLocatorCandidate,
  BrowserRectangle,
} from '@canopy/execution-engine/types/browser';
import {
  accessibleName,
  attributeForNode,
  compactText,
  MODEL_TEXT_LIMIT,
  domPathForNode,
  hasRedactedContent,
  inputTypeFor,
  isHiddenElement,
  isInteractiveElement,
  roleFor,
  safeOuterHtml,
} from './model-semantics';
import { isSingleScopeModel, locatorCandidatesFor } from './locator-candidates';
import type {
  BrowserPageModel,
  PageModelFrame,
  PageModelNode,
} from './model-types';
import type { NodeIdentity } from './frame-registry';

const DEFAULT_INPUT_SNAPSHOT_LIMIT = 25;
const MAX_INPUT_SNAPSHOT_LIMIT = 100;
const TEXT_LENGTH_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
]);
const NUMERIC_INPUT_TYPES = new Set([
  'number',
  'range',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
]);
/**
 * Input types that take no text: they are checked, chosen, or pressed, and
 * `browser.fill` refuses them, so their rows carry no `editable`.
 */
const NOT_FILLABLE_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'file',
  'submit',
  'reset',
  'button',
  'image',
  'hidden',
]);
/** The preload's `rectFor` rounds each component of the client rect. */
function roundedBounds(bounds: BrowserRectangle): BrowserRectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

const DISABLED_ATTRIBUTE_TAGS = new Set([
  'button',
  'input',
  'select',
  'textarea',
  'fieldset',
  'optgroup',
  'option',
]);
/** Projects a frozen model into the preload-compatible input snapshot DTO. */
export function projectInputSnapshot(
  model: BrowserPageModel,
  request: BrowserInputSnapshotRequest,
  page: { browserId: string; url: string; title: string },
  scope: { frames?: PageModelFrame[] } = {},
): BrowserInputSnapshotResponse {
  const frameRefs =
    scope.frames === undefined
      ? undefined
      : new Set(scope.frames.map((frame) => frame.frameRef));
  const filter = request.filter ?? {};
  const offset = Math.max(0, Math.floor(request.offset ?? 0));
  const limit = Math.max(
    1,
    Math.min(
      MAX_INPUT_SNAPSHOT_LIMIT,
      Math.floor(request.limit ?? DEFAULT_INPUT_SNAPSHOT_LIMIT),
    ),
  );
  const matches = model.nodes.filter(
    (node) =>
      node.nodeType === 1 &&
      (frameRefs === undefined || frameRefs.has(node.frameRef)) &&
      isInteractiveElement(node) &&
      !isHiddenElement(node) &&
      matchesInputSnapshotFilter(model, node, filter),
  );
  const rowMetadata = snapshotRowMetadata(model);
  const pageNodes = matches.slice(offset, offset + limit);
  const nextOffset = offset + pageNodes.length;
  const truncated = nextOffset < matches.length;

  return {
    browserId: page.browserId,
    ...(model.page.runtimeGeneration === undefined
      ? {}
      : { runtimeGeneration: model.page.runtimeGeneration }),
    url: page.url,
    title: page.title,
    capturedAt: model.capturedAt,
    ...(model.page.telemetry ?? {}),
    filter,
    offset,
    limit,
    total: matches.length,
    returned: pageNodes.length,
    truncated,
    ...(truncated ? { nextOffset } : {}),
    inputs: pageNodes.map((node) => projectInputItem(model, node, rowMetadata)),
    frames: model.coverage.map((coverage) => ({
      frameRef: coverage.frameRef,
      url: coverage.url,
      status: coverage.status,
      ...(coverage.reason === undefined ? {} : { reason: coverage.reason }),
    })),
  };
}

/** Projects the model's exact node identity into a safe element inspection. */
export async function projectInspect(
  model: BrowserPageModel,
  identity: NodeIdentity,
  deps: {
    /** Host opts in only after C3 password history succeeded for this document. */
    allowSensitiveEnrichment?: boolean;
    /**
     * The preload's inspection of the live element. `secretControls` are the
     * controls in its subtree the model classified as secret: the preload
     * keeps them redacted even if the page dropped their secret marker after
     * the capture.
     */
    enrich(
      identity: NodeIdentity,
      secretControls: NodeIdentity[],
    ): Promise<{
      locatorCandidates: BrowserLocatorCandidate[];
      preferredLocator?: BrowserLocatorCandidate;
      domPath: string[];
      outerHtml: string;
    } | null>;
  },
): Promise<BrowserElementSnapshot | undefined> {
  const node = model.nodes.find((candidate) =>
    hasIdentity(candidate.identity, identity),
  );
  if (!node || node.nodeType !== 1) return undefined;

  const candidates = safeInspectionCandidates(model, node);
  const hasSensitiveSubtree = hasRedactedContent(node);
  const frame = model.frames.find(
    (candidate) => candidate.frameRef === node.frameRef,
  );
  const secretControls = secretControlsAround(model, node);
  const canEnrich =
    frame !== undefined &&
    frame.parentFrameId === undefined &&
    !node.inShadowRoot &&
    secretControls !== undefined &&
    (!hasSensitiveSubtree || deps.allowSensitiveEnrichment === true);
  const enriched =
    canEnrich && secretControls !== undefined
      ? await deps.enrich(identity, secretControls)
      : null;
  // The preload judges uniqueness in the main document's light DOM only; on
  // a page with shadow roots or frames its candidates are checked as well.
  const singleScope = isSingleScopeModel(model);
  const locatorCandidates = !enriched
    ? candidates
    : singleScope
      ? enriched.locatorCandidates
      : locatorCandidatesFor(model, node, {
          candidates: enriched.locatorCandidates,
        });
  const preferredLocator =
    enriched && singleScope ? enriched.preferredLocator : locatorCandidates[0];

  const secret = node.secret || node.insideSecretSelect;
  // Inspect withholds at least what a snapshot row does.
  const redacted = hasRedactedAttributes(node);
  // A control whose live value the snapshot could not see is withheld too.
  const withheld = secret || node.valueUnknown === true;
  const control = ['input', 'textarea', 'select'].includes(
    node.tagName.toLowerCase(),
  );
  const safeText = hasSensitiveSubtree ? undefined : node.text || undefined;

  return {
    browserId: model.page.browserId,
    ...(model.page.runtimeGeneration === undefined
      ? {}
      : { runtimeGeneration: model.page.runtimeGeneration }),
    url: model.page.url,
    title: model.page.title,
    capturedAt: model.capturedAt,
    viewport: { ...model.page.viewport },
    themeMode: model.page.themeMode,
    tagName: node.tagName.toLowerCase(),
    role: redacted ? undefined : roleFor(node),
    ...(redacted
      ? {}
      : { accessibleName: accessibleName(model, node) || undefined }),
    ...(safeText ? { text: safeText } : {}),
    ...(control && !withheld && node.value !== undefined
      ? { value: node.value }
      : {}),
    ...(secret || (control && withheld) ? { valueRedacted: true } : {}),
    attributes: { ...node.attributes },
    bounds: roundedBounds(node.bounds),
    // Where the element is, only when there is something to say (E1): its
    // child frame, and that it is in a shadow root.
    ...whereItIs(model, node),
    ...(preferredLocator === undefined ? {} : { preferredLocator }),
    locatorCandidates,
    domPath: enriched ? enriched.domPath : domPathForNode(model, node),
    outerHtml: enriched
      ? enriched.outerHtml.slice(0, 10_000)
      : safeOuterHtml(model, node, 10_000),
  };
}

/**
 * A child frame's `frameRef` and `inShadowRoot: true`, each only when it
 * applies: the top document's light DOM, where the preload saw everything,
 * says nothing (E1). The snapshot's frame coverage lists every frame, the
 * top document included, so a locator can still be scoped to it.
 */
function whereItIs(
  model: BrowserPageModel,
  node: PageModelNode,
): { frameRef?: string; inShadowRoot?: true } {
  const frame = model.frames.find(
    (candidate) => candidate.frameRef === node.frameRef,
  );
  return {
    ...(frame === undefined || frame.parentFrameId === undefined
      ? {}
      : { frameRef: node.frameRef }),
    ...(node.inShadowRoot ? { inShadowRoot: true } : {}),
  };
}

function projectInputItem(
  model: BrowserPageModel,
  node: PageModelNode,
  metadata: SnapshotRowMetadata,
): BrowserInputSnapshotItem {
  const secret = node.secret || node.insideSecretSelect;
  const sensitiveText = hasRedactedContent(node);
  const redacted = hasRedactedAttributes(node);
  const candidates = locatorCandidatesFor(model, node, { first: true });
  const disabled =
    (DISABLED_ATTRIBUTE_TAGS.has(node.tagName.toLowerCase()) &&
      attributeForNode(node, 'disabled') !== undefined) ||
    attributeForNode(node, 'aria-disabled') === 'true';
  const item: BrowserInputSnapshotItem = {
    ref: model.registry.mintRef(node.identity),
    ...whereItIs(model, node),
    inViewport: node.inViewport,
    tagName: node.tagName.toLowerCase(),
    role: redacted ? undefined : roleFor(node),
    inputType: redacted ? undefined : inputTypeFor(node),
    name: redacted ? undefined : accessibleName(model, node) || undefined,
    text: sensitiveText ? undefined : node.text || undefined,
    placeholder: redacted
      ? undefined
      : attributeForNode(node, 'placeholder') || undefined,
    disabled,
    bounds: roundedBounds(node.bounds),
    locator: locatorForFirstCandidate(candidates),
  };

  if (['input', 'textarea', 'select'].includes(node.tagName.toLowerCase())) {
    if (secret || node.valueUnknown === true) {
      item.valueRedacted = true;
    } else if (node.value !== undefined) {
      item.value = compactText(node.value, 240);
    }
  }
  return { ...item, ...projectD15Fields(model, node, metadata, disabled) };
}

interface SnapshotRowMetadata {
  options: Map<PageModelNode, PageModelNode[]>;
  secretOptionContainers: Set<PageModelNode>;
  contentEditable: WeakMap<PageModelNode, boolean | undefined>;
}

interface SnapshotWalkTask {
  nodeIndex: number;
  optionContainer?: PageModelNode;
  inheritedContentEditable?: boolean;
}

/** Computes row-wide tree facts once, instead of rescanning each control subtree. */
function snapshotRowMetadata(model: BrowserPageModel): SnapshotRowMetadata {
  const options = new Map<PageModelNode, PageModelNode[]>();
  const secretOptionContainers = new Set<PageModelNode>();
  const contentEditable = new WeakMap<PageModelNode, boolean | undefined>();
  const visited = new Set<number>();
  const pending: SnapshotWalkTask[] = [];
  let fallbackIndex = 0;
  model.nodes.forEach((node, nodeIndex) => {
    if (
      node.parentIndex === undefined ||
      model.nodes[node.parentIndex] === undefined
    ) {
      pending.push({ nodeIndex });
    }
  });

  while (pending.length > 0 || visited.size < model.nodes.length) {
    if (pending.length === 0) {
      while (fallbackIndex < model.nodes.length && visited.has(fallbackIndex)) {
        fallbackIndex += 1;
      }
      if (fallbackIndex >= model.nodes.length) break;
      pending.push({ nodeIndex: fallbackIndex });
      fallbackIndex += 1;
    }

    const task = pending.pop();
    if (!task || visited.has(task.nodeIndex)) continue;
    visited.add(task.nodeIndex);
    const node = model.nodes[task.nodeIndex];
    if (!node) continue;

    const nextContainer = isOptionContainer(node) ? node : task.optionContainer;
    if (isOptionContainer(node)) options.set(node, []);
    if (isOptionNode(node) && task.optionContainer) {
      const containerOptions = options.get(task.optionContainer);
      if (containerOptions) {
        containerOptions.push(node);
        if (
          node.secret ||
          node.insideSecretSelect ||
          node.hasSecretDescendant
        ) {
          secretOptionContainers.add(task.optionContainer);
        }
      }
    }

    let effectiveContentEditable = task.inheritedContentEditable;
    const contentEditableAttribute = attributeForNode(node, 'contenteditable');
    if (contentEditableAttribute !== undefined) {
      const normalized = contentEditableAttribute.trim().toLowerCase();
      if (
        normalized === '' ||
        normalized === 'true' ||
        normalized === 'plaintext-only'
      ) {
        effectiveContentEditable = true;
      } else if (normalized === 'false') {
        effectiveContentEditable = false;
      }
    }
    contentEditable.set(node, effectiveContentEditable);

    for (let index = node.childIndexes.length - 1; index >= 0; index -= 1) {
      const childIndex = node.childIndexes[index];
      const child = model.nodes[childIndex];
      if (!child) continue;
      const sameScope = isSameModelScope(node, child);
      pending.push({
        nodeIndex: childIndex,
        ...(sameScope && nextContainer
          ? { optionContainer: nextContainer }
          : {}),
        ...(sameScope && effectiveContentEditable !== undefined
          ? { inheritedContentEditable: effectiveContentEditable }
          : {}),
      });
    }
  }

  return { options, secretOptionContainers, contentEditable };
}

function isSameModelScope(left: PageModelNode, right: PageModelNode): boolean {
  return (
    left.frameRef === right.frameRef && left.scopeNodeId === right.scopeNodeId
  );
}

function isOptionContainer(node: PageModelNode): boolean {
  return (
    node.nodeType === 1 &&
    (node.tagName.toLowerCase() === 'select' || roleFor(node) === 'listbox')
  );
}

function isOptionNode(node: PageModelNode): boolean {
  return (
    node.nodeType === 1 &&
    (node.tagName.toLowerCase() === 'option' ||
      node.isAriaOption === true ||
      roleFor(node) === 'option')
  );
}

function isSecretOptionNode(node: PageModelNode): boolean {
  return isOptionNode(node) && (node.secret || node.insideSecretSelect);
}

/**
 * A node whose attributes are all redacted: an option of a secret list, or
 * anything else inside a secret element. Nothing is read from them.
 */
function hasRedactedAttributes(node: PageModelNode): boolean {
  return isSecretOptionNode(node) || node.insideSecretSelect;
}

function projectD15Fields(
  model: BrowserPageModel,
  node: PageModelNode,
  metadata: SnapshotRowMetadata,
  disabled: boolean,
): Pick<
  BrowserInputSnapshotItem,
  | 'checked'
  | 'expanded'
  | 'selected'
  | 'pressed'
  | 'required'
  | 'invalid'
  | 'readOnly'
  | 'editable'
  | 'options'
  | 'optionCount'
  | 'optionsRedacted'
  | 'constraints'
  | 'format'
> {
  const tag = node.tagName.toLowerCase();
  const type = inputTypeFor(node);
  const redacted = hasRedactedAttributes(node);
  const checked = redacted ? undefined : checkedForNode(node, type);
  const expanded = redacted
    ? undefined
    : booleanAriaState(node, 'aria-expanded');
  const selected = redacted ? undefined : selectedForNode(node);
  const pressed = redacted ? undefined : pressedForNode(node);
  const required = redacted ? undefined : requiredForNode(node, tag, type);
  const invalid = redacted ? undefined : invalidForNode(node);
  const readOnly = redacted ? undefined : readOnlyForNode(node, tag, type);
  const inheritedContentEditable = metadata.contentEditable.get(node);
  const editable = redacted
    ? undefined
    : tag === 'input' &&
        type !== undefined &&
        NOT_FILLABLE_INPUT_TYPES.has(type)
      ? undefined
      : ['input', 'textarea'].includes(tag)
        ? !disabled && readOnly !== true
        : inheritedContentEditable === true
          ? !disabled && readOnly !== true
          : inheritedContentEditable === false
            ? false
            : undefined;
  const optionNodes = metadata.options.get(node);
  const isOptionList = optionNodes !== undefined;
  const secretOptions =
    isOptionList &&
    (node.secret ||
      node.insideSecretSelect ||
      metadata.secretOptionContainers.has(node));
  const options = secretOptions
    ? undefined
    : optionNodes
        ?.slice(0, 20)
        .map((option) => projectOption(model, node, option));
  const optionCount = isOptionList ? optionNodes.length : undefined;
  const constraints = redacted
    ? undefined
    : constraintsForNode(node, tag, type);
  const format = redacted ? undefined : formatForNode(node, type);

  return {
    ...(checked === undefined ? {} : { checked }),
    ...(expanded === undefined ? {} : { expanded }),
    ...(selected === undefined ? {} : { selected }),
    ...(pressed === undefined ? {} : { pressed }),
    ...(required === undefined ? {} : { required }),
    ...(invalid === undefined ? {} : { invalid }),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(editable === undefined ? {} : { editable }),
    ...(secretOptions ? { optionsRedacted: true } : options ? { options } : {}),
    ...(optionCount === undefined ? {} : { optionCount }),
    ...(constraints === undefined ? {} : { constraints }),
    ...(format === undefined ? {} : { format }),
  };
}

function checkedForNode(
  node: PageModelNode,
  type: string | undefined,
): boolean | 'mixed' | undefined {
  if (
    node.tagName.toLowerCase() === 'input' &&
    (type === 'checkbox' || type === 'radio') &&
    typeof node.checked === 'boolean'
  ) {
    return node.checked;
  }
  const value = attributeForNode(node, 'aria-checked')?.toLowerCase();
  return value === 'true' || value === 'false' || value === 'mixed'
    ? value === 'mixed'
      ? 'mixed'
      : value === 'true'
    : undefined;
}

function booleanAriaState(
  node: PageModelNode,
  attribute: string,
): boolean | undefined {
  const value = attributeForNode(node, attribute)?.toLowerCase();
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

function selectedForNode(node: PageModelNode): boolean | undefined {
  if (
    node.tagName.toLowerCase() === 'option' &&
    typeof node.selected === 'boolean'
  ) {
    return node.selected;
  }
  return booleanAriaState(node, 'aria-selected');
}

function pressedForNode(node: PageModelNode): boolean | 'mixed' | undefined {
  const value = attributeForNode(node, 'aria-pressed')?.toLowerCase();
  return value === 'true' || value === 'false' || value === 'mixed'
    ? value === 'mixed'
      ? 'mixed'
      : value === 'true'
    : undefined;
}

function requiredForNode(
  node: PageModelNode,
  tag: string,
  type: string | undefined,
): boolean | undefined {
  const supportsNativeRequired =
    tag === 'select' ||
    tag === 'textarea' ||
    (tag === 'input' &&
      type !== undefined &&
      !['hidden', 'button', 'submit', 'reset', 'image'].includes(type));
  if (
    supportsNativeRequired &&
    attributeForNode(node, 'required') !== undefined
  ) {
    return true;
  }
  const aria = attributeForNode(node, 'aria-required');
  if (aria !== undefined && aria !== '[redacted]') {
    return aria.toLowerCase() === 'true';
  }
  return undefined;
}

function invalidForNode(node: PageModelNode): boolean | undefined {
  const value = attributeForNode(node, 'aria-invalid');
  return value === undefined ? undefined : value.toLowerCase() !== 'false';
}

const READ_ONLY_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
  'number',
]);

function readOnlyForNode(
  node: PageModelNode,
  tag: string,
  type: string | undefined,
): boolean | undefined {
  if (
    (tag === 'textarea' ||
      (tag === 'input' &&
        type !== undefined &&
        READ_ONLY_INPUT_TYPES.has(type))) &&
    attributeForNode(node, 'readonly') !== undefined
  ) {
    return true;
  }
  const aria = attributeForNode(node, 'aria-readonly');
  if (aria !== undefined && aria !== '[redacted]') {
    return aria.toLowerCase() === 'true';
  }
  return undefined;
}

function constraintsForNode(
  node: PageModelNode,
  tag: string,
  type: string | undefined,
): BrowserInputSnapshotItem['constraints'] {
  const constraints: NonNullable<BrowserInputSnapshotItem['constraints']> = {};
  const isTextarea = tag === 'textarea';
  const isInput = tag === 'input';
  const isTextInput =
    isInput && type !== undefined && TEXT_LENGTH_INPUT_TYPES.has(type);
  const isLengthControl = isTextarea || isTextInput;

  if (isTextInput && !node.secret) {
    const pattern = attributeForNode(node, 'pattern');
    if (pattern !== undefined && pattern !== '[redacted]') {
      constraints.pattern = pattern;
    }
  }
  if (isInput && type !== undefined && NUMERIC_INPUT_TYPES.has(type)) {
    for (const name of ['min', 'max', 'step'] as const) {
      const value = attributeForNode(node, name);
      if (value !== undefined && value !== '[redacted]')
        constraints[name] = value;
    }
  }
  if (isLengthControl) {
    for (const [name, key] of [
      ['minlength', 'minLength'],
      ['maxlength', 'maxLength'],
    ] as const) {
      const value = attributeForNode(node, name);
      if (value === undefined || value === '[redacted]') continue;
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0) constraints[key] = parsed;
    }
  }
  if (isInput && type === 'file') {
    const accept = attributeForNode(node, 'accept');
    if (accept !== undefined && accept !== '[redacted]')
      constraints.accept = accept;
  }
  if (
    (tag === 'select' || (isInput && (type === 'file' || type === 'email'))) &&
    attributeForNode(node, 'multiple') !== undefined
  ) {
    constraints.multiple = true;
  }
  return Object.keys(constraints).length > 0 ? constraints : undefined;
}

function formatForNode(
  node: PageModelNode,
  type: string | undefined,
): string | undefined {
  if (node.tagName.toLowerCase() !== 'input') return undefined;
  switch (type) {
    case 'date':
      return 'YYYY-MM-DD';
    case 'time':
      return 'HH:MM';
    case 'datetime-local':
      return 'YYYY-MM-DDTHH:MM';
    case 'month':
      return 'YYYY-MM';
    case 'week':
      return 'YYYY-Www';
    case 'color':
      return '#RRGGBB';
    case 'range':
      return `${attributeForNode(node, 'min') ?? '0'} to ${attributeForNode(node, 'max') ?? '100'} in steps of ${attributeForNode(node, 'step') ?? '1'}`;
    default:
      return undefined;
  }
}

function projectOption(
  model: BrowserPageModel,
  container: PageModelNode,
  option: PageModelNode,
): NonNullable<BrowserInputSnapshotItem['options']>[number] {
  const tag = option.tagName.toLowerCase();
  const rawLabel =
    attributeForNode(option, 'label') ?? compactText(option.text);
  const label = compactText(rawLabel, 240);
  // A native option without a value attribute has its text as its value,
  // as HTMLOptionElement.value does; its label may differ. A value from an
  // attribute is given exactly, since select_option matches it exactly.
  const attributeValue =
    tag === 'option'
      ? attributeForNode(option, 'value')
      : (attributeForNode(option, 'data-value') ??
        attributeForNode(option, 'value'));
  const fromText = attributeValue === undefined;
  // A native option's own value keeps the whitespace the browser keeps; the
  // model's text is collapsed for display.
  const nativeTextValue =
    fromText && tag === 'option' ? option.optionValue : undefined;
  const fullValue =
    attributeValue ?? nativeTextValue ?? compactText(option.text, 240);
  // The model keeps only the start of a long text, so a value taken from it
  // may be cut short too.
  const valueTruncated =
    fullValue.length > 240 ||
    (fromText &&
      nativeTextValue === undefined &&
      option.text.trim().length >= MODEL_TEXT_LIMIT);
  return {
    value: fullValue.slice(0, 240),
    ...(valueTruncated ? { valueTruncated: true } : {}),
    label,
    selected: selectedForNode(option) === true,
    disabled: optionDisabled(model, container, option),
  };
}

function optionDisabled(
  model: BrowserPageModel,
  container: PageModelNode,
  option: PageModelNode,
): boolean {
  if (
    attributeForNode(option, 'disabled') !== undefined ||
    attributeForNode(option, 'aria-disabled') === 'true'
  ) {
    return true;
  }
  if (option.tagName.toLowerCase() !== 'option') return false;
  const seen = new Set<number>();
  let parentIndex = option.parentIndex;
  while (parentIndex !== undefined && !seen.has(parentIndex)) {
    seen.add(parentIndex);
    const parent = model.nodes[parentIndex];
    if (!parent || !isSameModelScope(option, parent)) break;
    if (
      parent.tagName.toLowerCase() === 'optgroup' &&
      attributeForNode(parent, 'disabled') !== undefined
    ) {
      return true;
    }
    if (parent === container) break;
    parentIndex = parent.parentIndex;
  }
  return false;
}

function locatorForFirstCandidate(
  candidates: BrowserLocatorCandidate[],
): string | undefined {
  const first = candidates[0];
  return first?.playwright ?? first?.value;
}

function matchesInputSnapshotFilter(
  model: BrowserPageModel,
  node: PageModelNode,
  filter: BrowserInputSnapshotFilter,
): boolean {
  const inputType = inputTypeFor(node)?.toLowerCase();
  if (filter.inputType?.trim()) {
    if (inputType !== filter.inputType.trim().toLowerCase()) return false;
  }

  const role = roleFor(node)?.toLowerCase();
  if (filter.role?.trim()) {
    if (role !== filter.role.trim().toLowerCase()) return false;
  }

  if (filter.name?.trim()) {
    const query = filter.name.trim().toLowerCase();
    if (!snapshotName(model, node).toLowerCase().includes(query)) return false;
  }
  return true;
}

function snapshotName(model: BrowserPageModel, node: PageModelNode): string {
  const sensitiveText = hasRedactedContent(node);
  return compactText(
    [
      node.insideSecretSelect ? undefined : accessibleName(model, node),
      attributeForNode(node, 'placeholder'),
      sensitiveText ? undefined : node.text,
    ]
      .filter(Boolean)
      .join(' '),
    240,
  );
}

function safeInspectionCandidates(
  model: BrowserPageModel,
  node: PageModelNode,
): BrowserLocatorCandidate[] {
  if (node.insideSecretSelect) return [];
  const generated = locatorCandidatesFor(model, node);
  if (hasRedactedContent(node)) return generated;

  const testId = generated.find((candidate) => candidate.kind === 'testId');
  const css = [...generated]
    .reverse()
    .find((candidate) => candidate.kind === 'css');
  return [testId, css].filter(
    (candidate): candidate is BrowserLocatorCandidate =>
      candidate !== undefined,
  );
}

/** Most secret controls handed to the preload with one inspection. */
export const MAX_ENRICHMENT_SECRET_CONTROLS = 200;

function isFormControl(node: PageModelNode): boolean {
  const tagName = node.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

/**
 * The form controls the model classified as secret that decide how a node is
 * redacted: those in its light subtree, itself included, and any that
 * enclose it, since an option's secrecy is its select's. A secret select
 * stands for its options. Undefined above the cap, or when a secret element
 * that is not a form control is in the subtree or encloses it: the caller
 * then uses the model-built output.
 */
function secretControlsAround(
  model: BrowserPageModel,
  node: PageModelNode,
): NodeIdentity[] | undefined {
  const controls: NodeIdentity[] = [];
  const seen = new Set<number>();
  for (
    let parentIndex = node.parentIndex;
    parentIndex !== undefined && !seen.has(parentIndex);
  ) {
    seen.add(parentIndex);
    const parent = model.nodes[parentIndex];
    if (!parent) break;
    if (hasSecretContent(parent)) return undefined;
    if (parent.secret && isFormControl(parent)) controls.push(parent.identity);
    parentIndex = parent.parentIndex;
  }
  const pending: PageModelNode[] = [node];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (hasSecretContent(current)) return undefined;
    if (current.secret && isFormControl(current)) {
      controls.push(current.identity);
      if (controls.length > MAX_ENRICHMENT_SECRET_CONTROLS) return undefined;
      if (current.tagName.toLowerCase() === 'select') continue;
    }
    for (const childIndex of current.childIndexes) {
      const child = model.nodes[childIndex];
      if (child?.nodeType === 1) pending.push(child);
    }
  }
  return controls;
}

/**
 * A secret element whose secret is its content, not a control's value: an
 * ARIA list or combobox, or an editing host. The preload redacts controls
 * only, so the node, and any node inside or around it, is built from the
 * model.
 */
function hasSecretContent(node: PageModelNode): boolean {
  if (!node.secret || node.tagName.toLowerCase() === 'select') return false;
  const role = roleFor(node);
  if (role === 'listbox' || role === 'combobox') return true;
  return !node.insideSecretSelect && !isFormControl(node);
}

function hasIdentity(left: NodeIdentity, right: NodeIdentity): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.frameId === right.frameId &&
    left.loaderId === right.loaderId &&
    left.backendNodeId === right.backendNodeId
  );
}
