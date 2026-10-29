/**
 * The committed parity golden and the host differences it records.
 *
 * `golden.json` holds, per fixture, the projection both hosts must produce.
 * Where the hosts differ on purpose, or through a registered gap, the golden
 * holds `{ "hostDifference": <finding>, "desktop": …, "cloud": … }` at that
 * path instead, with a host's key left out when that host has no value
 * there. `HOST_DIFFERENCES` lists every such path with its reason and its
 * `docs/parity/registry.yaml` entry; nothing else may differ.
 *
 * Run a host's parity test with `PARITY_GOLDEN_UPDATE=1` to rewrite its side
 * of the golden: the desktop test writes the shared values and its
 * difference slots, the cloud test only its difference slots.
 */
import type { ParityFixtureName } from './fixtures';

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type ParityHost = 'desktop' | 'cloud';

/** A key, an array index, or the array element whose `id` matches. */
export type GoldenPathSegment = string | number | { readonly id: string };

export interface HostDifference {
  /** The CAN-4051 finding letter. */
  readonly finding: string;
  readonly fixture: ParityFixtureName;
  readonly path: readonly GoldenPathSegment[];
  /** The `docs/parity/registry.yaml` feature that records it. */
  readonly registry: string;
  readonly reason: string;
}

const COMPLETE: Omit<HostDifference, 'fixture'> = {
  finding: 'C',
  path: ['tree', 'complete'],
  registry: 'subagent-viewer',
  reason:
    'Desktop reads the root chat and its managed tree in full; the web builds the tree from the loaded part of an open chat.',
};

const CLAUDE_NODES = [
  'toolu_01CheckAuth',
  'toolu_01ExploreRoutes',
  'toolu_01FixDateTest',
  'toolu_01WatchLogs',
] as const;

export const HOST_DIFFERENCES: readonly HostDifference[] = [
  { ...COMPLETE, fixture: 'claude' },
  { ...COMPLETE, fixture: 'codex-v2' },
  { ...COMPLETE, fixture: 'codex-v1' },
  ...CLAUDE_NODES.map(
    (id): HostDifference => ({
      finding: 'D',
      fixture: 'claude',
      path: ['tree', 'nodes', { id }, 'createdAt'],
      registry: 'subagent-viewer',
      reason:
        "Core records when a task was queued; desktop's Claude transcript has no queue time. Shown only when a node has no start time.",
    }),
  ),
  ...CLAUDE_NODES.map(
    (id): HostDifference => ({
      finding: 'E',
      fixture: 'claude',
      path: ['tree', 'nodes', { id }, 'modelLabel'],
      registry: 'subagent-viewer',
      reason:
        "Desktop gap: a desktop Claude node has no model label, because the persisted transcript keeps no subagent's model; cloud reads it from the task.",
    }),
  ),
  {
    finding: 'A',
    fixture: 'claude',
    path: ['transcripts', 'toolu_01ExploreRoutes', 3],
    registry: 'agent-block-card',
    reason:
      'Desktop gap (follow-up: nested Claude agent cards on desktop): mergeToolResults keeps a nested Agent call as a tool row; cloud folds it into a nested agent card.',
  },
  {
    finding: 'O',
    fixture: 'codex-v2',
    path: ['transcripts', '019b4051-0000-7000-8000-00000000000a', 0, 'label'],
    registry: 'subagent-viewer',
    reason:
      'Cloud gap: the shared tool card labels the runner\'s Codex `bash` call "Bash" where desktop\'s Codex `command` row reads "Command"; icon, output and error match.',
  },
  {
    finding: 'L',
    fixture: 'codex-v2',
    path: ['transcripts', '019b4051-0000-7000-8000-00000000000b'],
    registry: 'subagent-viewer',
    reason:
      'Cloud gap: desktop records a failed Codex child turn as an "Error:" row; Core sends no failure frame for a child turn, so cloud shows the failure only on the node.',
  },
  ...[
    '019b4051-0000-7000-8000-00000000010a',
    '019b4051-0000-7000-8000-00000000010b',
  ].map(
    (id): HostDifference => ({
      finding: 'N',
      fixture: 'codex-v1',
      path: ['transcripts', id],
      registry: 'subagent-viewer',
      reason:
        "Cloud gap: a multi-receiver Codex card's child rows carry no receiver, so a receiver's chat on cloud shows only its prompt.",
    }),
  ),
];

function isRecord(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function indexOf(list: readonly Json[], segment: GoldenPathSegment): number {
  if (typeof segment === 'number') return segment;
  if (typeof segment === 'string') return -1;
  return list.findIndex((item) => isRecord(item) && item['id'] === segment.id);
}

/** The value at `path`, or undefined when any step is missing. */
export function getAt(
  value: Json | undefined,
  path: readonly GoldenPathSegment[],
): Json | undefined {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = indexOf(current, segment);
      current = index < 0 ? undefined : current[index];
    } else if (isRecord(current) && typeof segment === 'string') {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** A copy of `value` with `path` set to `next`, or removed when undefined. */
export function setAt(
  value: Json,
  path: readonly GoldenPathSegment[],
  next: Json | undefined,
): Json {
  const [head, ...rest] = path;
  if (head === undefined) return next ?? null;
  if (Array.isArray(value)) {
    const index = indexOf(value, head);
    if (index < 0) throw new Error(`No element for ${JSON.stringify(head)}`);
    const copy = [...value];
    const child = copy[index];
    if (rest.length === 0 && next === undefined) copy.splice(index, 1);
    else copy[index] = setAt(child ?? null, rest, next);
    return copy;
  }
  if (!isRecord(value) || typeof head !== 'string')
    throw new Error(`Cannot follow ${JSON.stringify(head)}`);
  const copy = { ...value };
  if (rest.length === 0 && next === undefined) delete copy[head];
  else copy[head] = setAt(copy[head] ?? {}, rest, next);
  return copy;
}

const MARK = 'hostDifference';

/** A golden fixture as `host` must produce it. */
export function expectedFor(
  host: ParityHost,
  fixture: ParityFixtureName,
  golden: Json,
): Json {
  let expected = golden;
  for (const difference of HOST_DIFFERENCES) {
    if (difference.fixture !== fixture) continue;
    const slot = getAt(golden, difference.path);
    if (!isRecord(slot) || slot[MARK] !== difference.finding)
      throw new Error(
        `golden.json has no ${difference.finding} slot at ${JSON.stringify(difference.path)}`,
      );
    expected = setAt(expected, difference.path, slot[host]);
  }
  return expected;
}

/**
 * The golden fixture rewritten with `host`'s projection: the desktop host
 * owns the shared values, and each host owns its difference slots.
 */
export function goldenWith(
  host: ParityHost,
  fixture: ParityFixtureName,
  actual: Json,
  previous: Json | undefined,
): Json {
  let next: Json = host === 'desktop' ? actual : (previous ?? actual);
  for (const difference of HOST_DIFFERENCES) {
    if (difference.fixture !== fixture) continue;
    const old = getAt(previous, difference.path);
    const slot: { [key: string]: Json } = isRecord(old)
      ? { ...old }
      : { [MARK]: difference.finding };
    slot[MARK] = difference.finding;
    const value = getAt(actual, difference.path);
    if (value === undefined) delete slot[host];
    else slot[host] = value;
    next = setAt(next, difference.path, slot);
  }
  return next;
}
