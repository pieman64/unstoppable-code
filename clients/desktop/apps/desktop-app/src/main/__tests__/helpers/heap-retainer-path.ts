import { readFileSync } from 'node:fs';

interface SnapshotMeta {
  nodeFieldCount: number;
  nodeTypes: string[];
  edgeFieldCount: number;
  edgeTypes: string[];
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const ZERO = 0x30;
const NINE = 0x39;
const EPHEMERON_EDGE = Buffer.from('part of key');

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function readMeta(buffer: Buffer, nodesKey: number): SnapshotMeta {
  const header = `${buffer
    .subarray(0, nodesKey)
    .toString()
    .replace(/,\s*$/, '')}}`;
  const parsed: unknown = JSON.parse(header);
  const meta: unknown = Reflect.get(
    Reflect.get(Object(parsed), 'snapshot') ?? {},
    'meta',
  );
  const nodeFields: unknown = Reflect.get(Object(meta), 'node_fields');
  const edgeFields: unknown = Reflect.get(Object(meta), 'edge_fields');
  const nodeTypes: unknown = Reflect.get(Object(meta), 'node_types');
  const edgeTypes: unknown = Reflect.get(Object(meta), 'edge_types');
  const nodeTypeNames: unknown = Array.isArray(nodeTypes)
    ? nodeTypes[0]
    : undefined;
  const edgeTypeNames: unknown = Array.isArray(edgeTypes)
    ? edgeTypes[0]
    : undefined;
  if (
    !isStringArray(nodeFields) ||
    !isStringArray(edgeFields) ||
    !isStringArray(nodeTypeNames) ||
    !isStringArray(edgeTypeNames) ||
    nodeFields[4] !== 'edge_count' ||
    edgeFields[2] !== 'to_node'
  ) {
    throw new Error('Unsupported heap snapshot layout');
  }
  return {
    nodeFieldCount: nodeFields.length,
    nodeTypes: nodeTypeNames,
    edgeFieldCount: edgeFields.length,
    edgeTypes: edgeTypeNames,
  };
}

function readIntegers(
  buffer: Buffer,
  start: number,
): { values: Uint32Array; end: number } {
  let values = new Uint32Array(1 << 20);
  let length = 0;
  let current = 0;
  let inNumber = false;
  let index = buffer.indexOf(OPEN_BRACKET, start) + 1;
  for (; ; index += 1) {
    const byte = buffer[index];
    if (byte === undefined) throw new Error('Truncated heap snapshot');
    if (byte >= ZERO && byte <= NINE) {
      current = current * 10 + (byte - ZERO);
      inNumber = true;
      continue;
    }
    if (inNumber) {
      if (length === values.length) {
        const grown = new Uint32Array(values.length * 2);
        grown.set(values);
        values = grown;
      }
      values[length] = current;
      length += 1;
      current = 0;
      inNumber = false;
    }
    if (byte === CLOSE_BRACKET) break;
  }
  return { values: values.subarray(0, length), end: index };
}

/** Locates every string without decoding the table, which can exceed V8's string limit. */
function indexStrings(
  buffer: Buffer,
  start: number,
): { starts: Uint32Array; ends: Uint32Array } {
  const starts: number[] = [];
  const ends: number[] = [];
  let index = buffer.indexOf(OPEN_BRACKET, start) + 1;
  while (index < buffer.length) {
    const byte = buffer[index];
    if (byte === CLOSE_BRACKET) break;
    if (byte !== QUOTE) {
      index += 1;
      continue;
    }
    const open = index;
    index += 1;
    while (index < buffer.length && buffer[index] !== QUOTE) {
      index += buffer[index] === BACKSLASH ? 2 : 1;
    }
    starts.push(open);
    ends.push(index + 1);
    index += 1;
  }
  return { starts: Uint32Array.from(starts), ends: Uint32Array.from(ends) };
}

/**
 * Describes the shortest strong path from the GC roots to each object that
 * owns `markerProperty` in a V8 heap snapshot. Weak and WeakMap (ephemeron)
 * edges are skipped, so the path names what actually keeps the object alive.
 */
export function describeRetainerPath(
  snapshotPath: string,
  markerProperty: string,
  maxSteps = 40,
): string {
  const buffer = readFileSync(snapshotPath);
  const nodesKey = buffer.indexOf('"nodes":');
  if (nodesKey < 0) throw new Error('Heap snapshot has no nodes');
  const meta = readMeta(buffer, nodesKey);
  const nodesRead = readIntegers(buffer, nodesKey);
  const nodes = nodesRead.values;
  const edgesKey = buffer.indexOf('"edges":', nodesRead.end);
  const edgesRead = readIntegers(buffer, edgesKey);
  const edges = edgesRead.values;
  const strings = indexStrings(
    buffer,
    buffer.indexOf('"strings":', edgesRead.end),
  );
  const fullText = (stringIndex: number): string => {
    const start = strings.starts[stringIndex];
    const end = strings.ends[stringIndex];
    if (start === undefined || end === undefined) return '?';
    const decoded: unknown = JSON.parse(buffer.subarray(start, end).toString());
    return typeof decoded === 'string' ? decoded : '?';
  };
  const text = (stringIndex: number): string =>
    fullText(stringIndex).slice(0, 80);
  const rawEquals = (stringIndex: number, raw: Buffer): boolean => {
    const start = strings.starts[stringIndex] ?? 0;
    const end = strings.ends[stringIndex] ?? 0;
    return buffer.subarray(start, end).equals(raw);
  };
  const rawIncludes = (stringIndex: number, raw: Buffer): boolean => {
    const start = strings.starts[stringIndex] ?? 0;
    const end = strings.ends[stringIndex] ?? 0;
    return buffer.subarray(start, end).includes(raw);
  };

  const nodeFields = meta.nodeFieldCount;
  const edgeFields = meta.edgeFieldCount;
  const nodeCount = nodes.length / nodeFields;
  const firstEdge = new Uint32Array(nodeCount + 1);
  for (let node = 0, edge = 0; node < nodeCount; node += 1) {
    firstEdge[node] = edge;
    edge += (nodes[node * nodeFields + 4] ?? 0) * edgeFields;
    firstEdge[node + 1] = edge;
  }
  const weakType = meta.edgeTypes.indexOf('weak');
  const internalType = meta.edgeTypes.indexOf('internal');
  const propertyType = meta.edgeTypes.indexOf('property');
  const elementType = meta.edgeTypes.indexOf('element');
  const hiddenType = meta.edgeTypes.indexOf('hidden');
  const marker = Buffer.from(JSON.stringify(markerProperty));
  // Key and table edges of one WeakMap entry differ only in their index prefix.
  const ephemeronNames = new Map<number, string>();
  for (let index = 0; index < strings.starts.length; index += 1) {
    if (!rawIncludes(index, EPHEMERON_EDGE)) continue;
    const name = fullText(index);
    ephemeronNames.set(index, name.slice(name.indexOf('part of key')));
  }

  // A WeakMap value is listed under both its key and the map's table; it is
  // alive only once both of those are.
  const ephemeronKey = (name: number, target: number): string =>
    `${ephemeronNames.get(name) ?? ''}:${String(target)}`;
  const ephemeronSources = new Map<string, number>();
  for (let edge = 0; edge < edges.length; edge += edgeFields) {
    const name = edges[edge + 1] ?? 0;
    if (edges[edge] !== internalType || !ephemeronNames.has(name)) continue;
    const key = ephemeronKey(name, (edges[edge + 2] ?? 0) / nodeFields);
    ephemeronSources.set(key, (ephemeronSources.get(key) ?? 0) + 1);
  }

  const parent = new Int32Array(nodeCount).fill(-1);
  const parentEdge = new Int32Array(nodeCount).fill(-1);
  const queue = new Uint32Array(nodeCount);
  parent[0] = 0;
  let head = 0;
  let tail = 1;
  while (head < tail) {
    const node = queue[head] ?? 0;
    head += 1;
    for (let edge = firstEdge[node] ?? 0; edge < (firstEdge[node + 1] ?? 0); ) {
      const type = edges[edge] ?? 0;
      const name = edges[edge + 1] ?? 0;
      const target = (edges[edge + 2] ?? 0) / nodeFields;
      let strong = type !== weakType;
      if (type === internalType && ephemeronNames.has(name)) {
        const key = ephemeronKey(name, target);
        const remaining = (ephemeronSources.get(key) ?? 1) - 1;
        ephemeronSources.set(key, remaining);
        strong = remaining === 0;
      }
      if (strong && parent[target] === -1) {
        parent[target] = node;
        parentEdge[target] = edge;
        queue[tail] = target;
        tail += 1;
      }
      edge += edgeFields;
    }
  }

  const describeNode = (node: number): string =>
    `${meta.nodeTypes[nodes[node * nodeFields] ?? 0] ?? '?'} ${text(nodes[node * nodeFields + 1] ?? 0)}`;
  const describeEdge = (edge: number): string => {
    const type = edges[edge] ?? 0;
    const name = edges[edge + 1] ?? 0;
    return type === elementType || type === hiddenType
      ? `[${String(name)}]`
      : `.${text(name)}`;
  };

  const reports: string[] = [];
  for (let node = 0; node < nodeCount; node += 1) {
    let marked = false;
    for (
      let edge = firstEdge[node] ?? 0;
      edge < (firstEdge[node + 1] ?? 0);
      edge += edgeFields
    ) {
      if (
        edges[edge] === propertyType &&
        rawEquals(edges[edge + 1] ?? 0, marker)
      ) {
        marked = true;
        break;
      }
    }
    if (!marked) continue;
    if (parent[node] === -1) {
      reports.push(`${describeNode(node)}: unreachable`);
      continue;
    }
    const steps: string[] = [];
    for (
      let current = node;
      current !== 0 && steps.length < maxSteps;
      current = parent[current] ?? 0
    ) {
      steps.push(
        `${describeEdge(parentEdge[current] ?? 0)} -> ${describeNode(current)}`,
      );
    }
    reports.push(steps.reverse().join('\n'));
  }
  return reports.length > 0
    ? reports.join('\n\n')
    : `No object owns ${markerProperty}`;
}
