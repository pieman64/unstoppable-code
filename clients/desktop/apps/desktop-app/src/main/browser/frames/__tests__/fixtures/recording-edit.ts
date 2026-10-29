/**
 * Edits a copy of a recorded CDP fixture to replay a scenario a browser
 * produces only under a race (a page changing between `DOM.getDocument` and
 * `DOMSnapshot.captureSnapshot`) or that the recorded pages lack. Edits keep
 * Chromium's shapes: tree nodes are plain CDP `Node` records and snapshot
 * fields stay string-table indexes.
 */
import type { Recording, RecordedResponse } from './recorded-cdp';

export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cloneRecording(recording: Recording): Recording {
  return {
    ...recording,
    responses: recording.responses.map(
      (entry): RecordedResponse => ({
        ...entry,
        response: structuredClone(entry.response),
      }),
    ),
  };
}

export function recordedResponseRecord(
  recording: Recording,
  method: string,
  sessionId = '',
): JsonRecord {
  const entry = recording.responses.find(
    (candidate) =>
      candidate.method === method && candidate.sessionId === sessionId,
  );
  if (!entry || !isJsonRecord(entry.response)) {
    throw new Error(`Missing recorded ${method}.`);
  }
  return entry.response;
}

export function treeRoot(recording: Recording, sessionId = ''): JsonRecord {
  const response = recordedResponseRecord(
    recording,
    'DOM.getDocument',
    sessionId,
  );
  if (!isJsonRecord(response.root)) throw new Error('Missing document root.');
  return response.root;
}

export function childList(node: JsonRecord, key = 'children'): JsonRecord[] {
  const value = node[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonRecord);
}

function setChildList(node: JsonRecord, children: JsonRecord[]): void {
  node.children = children;
  node.childNodeCount = children.length;
}

/** Depth-first search over light children, shadow roots and frame documents. */
export function findTreeNode(
  root: JsonRecord,
  predicate: (node: JsonRecord) => boolean,
): JsonRecord {
  const pending: JsonRecord[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    if (predicate(node)) return node;
    pending.push(...childList(node), ...childList(node, 'shadowRoots'));
    if (isJsonRecord(node.contentDocument)) pending.push(node.contentDocument);
  }
  throw new Error('No matching tree node.');
}

export function hasAttribute(
  node: JsonRecord,
  name: string,
  value: string,
): boolean {
  const attributes = node.attributes;
  if (!Array.isArray(attributes)) return false;
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    if (attributes[index] === name && attributes[index + 1] === value) {
      return true;
    }
  }
  return false;
}

/** A CDP element record; IDs must be unused in the recording. */
export function elementRecord(
  id: number,
  tagName: string,
  attributes: Record<string, string>,
  children: JsonRecord[],
): JsonRecord {
  return {
    nodeId: id,
    backendNodeId: id,
    nodeType: 1,
    nodeName: tagName.toUpperCase(),
    localName: tagName,
    nodeValue: '',
    childNodeCount: children.length,
    children,
    attributes: Object.entries(attributes).flat(),
  };
}

export function textRecord(id: number, value: string): JsonRecord {
  return {
    nodeId: id,
    backendNodeId: id,
    nodeType: 3,
    nodeName: '#text',
    localName: '',
    nodeValue: value,
  };
}

/** Replaces `child` in its parent's children with `replacement`. */
export function replaceChild(
  parent: JsonRecord,
  child: JsonRecord,
  replacement: JsonRecord,
): void {
  setChildList(
    parent,
    childList(parent).map((entry) => (entry === child ? replacement : entry)),
  );
}

export function appendChild(parent: JsonRecord, child: JsonRecord): void {
  setChildList(parent, [...childList(parent), child]);
}

/** The parent record of `child`, searching from `root`. */
export function parentOf(root: JsonRecord, child: JsonRecord): JsonRecord {
  return findTreeNode(root, (node) =>
    [...childList(node), ...childList(node, 'shadowRoots')].includes(child),
  );
}

interface SnapshotEditor {
  /** Index of the node with this backend ID in the first document. */
  indexOf(backendNodeId: number): number;
  stringIndex(value: string): number;
  /** Appends an attribute to a node's attribute list. */
  addAttribute(backendNodeId: number, name: string, value: string): void;
  /** Sets or adds a rare string field (`inputValue`, `textValue`). */
  setRareString(field: string, backendNodeId: number, value: string): void;
}

export function snapshotEditor(
  recording: Recording,
  sessionId = '',
): SnapshotEditor {
  const snapshot = recordedResponseRecord(
    recording,
    'DOMSnapshot.captureSnapshot',
    sessionId,
  );
  const strings = snapshot.strings;
  const documents = snapshot.documents;
  if (!Array.isArray(strings) || !Array.isArray(documents)) {
    throw new Error('Unexpected snapshot.');
  }
  const first: unknown = documents[0];
  if (!isJsonRecord(first) || !isJsonRecord(first.nodes)) {
    throw new Error('Unexpected snapshot document.');
  }
  const nodes = first.nodes;
  const stringIndex = (value: string): number => {
    const known = strings.indexOf(value);
    if (known >= 0) return known;
    strings.push(value);
    return strings.length - 1;
  };
  const indexOf = (backendNodeId: number): number => {
    const ids = nodes.backendNodeId;
    const index = Array.isArray(ids) ? ids.indexOf(backendNodeId) : -1;
    if (index < 0) throw new Error(`No snapshot node ${backendNodeId}.`);
    return index;
  };
  return {
    indexOf,
    stringIndex,
    addAttribute: (backendNodeId, name, value): void => {
      const attributes = nodes.attributes;
      if (!Array.isArray(attributes)) throw new Error('No attributes.');
      const list: unknown = attributes[indexOf(backendNodeId)];
      if (!Array.isArray(list)) throw new Error('No attribute list.');
      list.push(stringIndex(name), stringIndex(value));
    },
    setRareString: (field, backendNodeId, value): void => {
      const rare = nodes[field];
      if (
        !isJsonRecord(rare) ||
        !Array.isArray(rare.index) ||
        !Array.isArray(rare.value)
      ) {
        throw new Error(`No rare field ${field}.`);
      }
      const index = indexOf(backendNodeId);
      const position = rare.index.indexOf(index);
      if (position >= 0) rare.value[position] = stringIndex(value);
      else {
        rare.index.push(index);
        rare.value.push(stringIndex(value));
      }
    },
  };
}

/** Reads a numeric field of a tree record. */
export function numberField(node: JsonRecord, key: string): number {
  const value = node[key];
  if (typeof value !== 'number') throw new Error(`No numeric ${key}.`);
  return value;
}
