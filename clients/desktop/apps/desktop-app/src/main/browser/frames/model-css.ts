import { attributeForNode, cssEscape } from './model-semantics';
import type {
  BrowserPageModel,
  PageModelFrame,
  PageModelNode,
} from './model-types';

/**
 * One compound of a generated selector: `tag`, `#id`, `tag#id`,
 * `tag:nth-of-type(n)`, or `tag[data-testid="value"]` (frame owners).
 */
interface Compound {
  tag?: string;
  /** The id as written in the selector, still escaped. */
  id?: string;
  /** A test-id attribute whose value needs no escaping. */
  attribute?: { name: string; value: string };
  nth?: number;
}

interface FrameCssIndex {
  elements: number[];
  byTag: Map<string, number[]>;
  byId: Map<string, number[]>;
  /** Elements inside a secret select with an id, whose value is withheld. */
  unknownIds: number[];
  nthOfType: Map<number, number>;
}

const COMPOUND =
  /^([a-z][a-z0-9-]*)?(?:#((?:\\[0-9a-fA-F]{1,6} ?|\\[^0-9a-fA-F\r\n\f]|[^\\\s#:.>+~,[\]()'"])+))?(?:\[(data-testid|data-test|data-cy)="([^"\\\r\n\f]*)"\])?(?::nth-of-type\(([1-9][0-9]*)\))?$/;

const indexes = new WeakMap<BrowserPageModel, Map<string, FrameCssIndex>>();

/**
 * Parses the selector forms the model and the preload generate: compounds
 * joined by the child combinator. Anything else is unsupported.
 */
function parseGeneratedSelector(selector: string): Compound[] | undefined {
  const compounds: Compound[] = [];
  for (const part of selector.split(' > ')) {
    const match = COMPOUND.exec(part);
    if (!match) return undefined;
    const [, tag, id, attributeName, attributeValue, nth] = match;
    if (tag === undefined && id === undefined && attributeName === undefined) {
      return undefined;
    }
    compounds.push({
      ...(tag === undefined ? {} : { tag }),
      ...(id === undefined ? {} : { id }),
      ...(attributeName === undefined || attributeValue === undefined
        ? {}
        : { attribute: { name: attributeName, value: attributeValue } }),
      ...(nth === undefined ? {} : { nth: Number(nth) }),
    });
  }
  return compounds;
}

function isInFrame(node: PageModelNode, frame: PageModelFrame): boolean {
  return (
    node.frameRef === frame.frameRef &&
    node.identity.frameId === frame.frameId &&
    node.identity.sessionId === frame.sessionId
  );
}

function push(map: Map<string, number[]>, key: string, index: number): void {
  const list = map.get(key);
  if (list) list.push(index);
  else map.set(key, [index]);
}

function frameIndex(
  model: BrowserPageModel,
  frame: PageModelFrame,
): FrameCssIndex {
  let byFrame = indexes.get(model);
  if (!byFrame) {
    byFrame = new Map();
    indexes.set(model, byFrame);
  }
  const cached = byFrame.get(frame.frameRef);
  if (cached) return cached;
  const index: FrameCssIndex = {
    elements: [],
    byTag: new Map(),
    byId: new Map(),
    unknownIds: [],
    nthOfType: new Map(),
  };
  model.nodes.forEach((node, nodeIndex) => {
    if (!isInFrame(node, frame)) return;
    if (node.nodeType === 1) {
      index.elements.push(nodeIndex);
      push(index.byTag, node.tagName, nodeIndex);
      const id = attributeForNode(node, 'id');
      if (id !== undefined) {
        if (node.insideSecretSelect) index.unknownIds.push(nodeIndex);
        else push(index.byId, cssEscape(id), nodeIndex);
      }
    }
    // `:nth-of-type` counts element siblings of the same tag, under an
    // element, a document or a shadow root alike.
    const counts = new Map<string, number>();
    for (const childIndex of node.childIndexes) {
      const child = model.nodes[childIndex];
      if (!child || child.nodeType !== 1) continue;
      const position = (counts.get(child.tagName) ?? 0) + 1;
      counts.set(child.tagName, position);
      index.nthOfType.set(childIndex, position);
    }
  });
  byFrame.set(frame.frameRef, index);
  return index;
}

function matchesCompound(
  model: BrowserPageModel,
  index: FrameCssIndex,
  nodeIndex: number,
  compound: Compound,
): boolean {
  const node = model.nodes[nodeIndex];
  if (!node || node.nodeType !== 1) return false;
  if (compound.tag !== undefined && node.tagName !== compound.tag) return false;
  if (compound.id !== undefined) {
    const id = attributeForNode(node, 'id');
    if (id === undefined) return false;
    // Inside a secret select the value is withheld: any id may match.
    if (!node.insideSecretSelect && cssEscape(id) !== compound.id) {
      return false;
    }
  }
  if (compound.attribute !== undefined) {
    const value = attributeForNode(node, compound.attribute.name);
    if (value === undefined) return false;
    if (!node.insideSecretSelect && value !== compound.attribute.value) {
      return false;
    }
  }
  return (
    compound.nth === undefined ||
    index.nthOfType.get(nodeIndex) === compound.nth
  );
}

/**
 * What `DOM.querySelectorAll` returns across a frame's document and every
 * shadow root, for a selector the generators emit, as model node indexes.
 * Undefined for any other selector, so callers can treat it as unverifiable.
 * An element inside a secret select that has an id matches any id, since
 * the value is withheld from the model.
 */
export function matchGeneratedSelector(
  model: BrowserPageModel,
  frame: PageModelFrame,
  selector: string,
  includeSecretSelect: boolean,
): number[] | undefined {
  const compounds = parseGeneratedSelector(selector);
  const last = compounds?.[compounds.length - 1];
  if (!compounds || !last) return undefined;
  const index = frameIndex(model, frame);
  const candidates =
    last.id !== undefined
      ? [...(index.byId.get(last.id) ?? []), ...index.unknownIds]
      : last.tag !== undefined
        ? (index.byTag.get(last.tag) ?? [])
        : index.elements;
  const matches: number[] = [];
  for (const candidate of candidates) {
    const node = model.nodes[candidate];
    if (!node || (node.insideSecretSelect && !includeSecretSelect)) continue;
    let current = candidate;
    let matched = true;
    for (let offset = compounds.length - 1; offset >= 0; offset -= 1) {
      const compound = compounds[offset];
      if (!compound || !matchesCompound(model, index, current, compound)) {
        matched = false;
        break;
      }
      if (offset === 0) break;
      // The child combinator stays inside one tree: a parent that is a
      // document or shadow root ends the chain.
      const element = model.nodes[current];
      const parentIndex = element?.parentIndex;
      const parent =
        parentIndex === undefined ? undefined : model.nodes[parentIndex];
      if (
        parentIndex === undefined ||
        !parent ||
        parent.nodeType !== 1 ||
        parent.scopeNodeId !== element?.scopeNodeId
      ) {
        matched = false;
        break;
      }
      current = parentIndex;
    }
    if (matched) matches.push(candidate);
  }
  return Array.from(new Set(matches)).sort((first, second) => first - second);
}
