import { GOLDEN_BASE_TAG } from './fixture-repository';

export { GOLDEN_REPO_ID } from './fixture-repository';

export type GoldenQueryMethod =
  | 'callers'
  | 'callees'
  | 'importers'
  | 'imports'
  | 'children'
  | 'tests-for'
  | 'docs-for'
  | 'rationale-for'
  | 'file-summary'
  | 'scripts-for-file'
  | 'ipc-channel'
  | 'symbol-detail'
  | 'community-for-symbol'
  | 'flows-for-symbol'
  | 'derived-stats'
  | 'communities'
  | 'flows'
  | 'hubs'
  | 'search'
  | 'impact-radius'
  | 'call-path'
  | 'relationship-path';

export type GoldenGraphRead =
  | {
      op: 'query';
      method: GoldenQueryMethod;
      target?: string;
      to?: string;
      query?: string;
      limit?: number;
      maxDepth?: number;
      maxNodes?: number;
      /** Scope the read to the fixture repository. */
      scoped?: boolean;
    }
  | { op: 'status' }
  | { op: 'summary' }
  | { op: 'fingerprint-metadata' }
  | { op: 'detect-changed'; base: string }
  | { op: 'change-impact'; base: string; maxDepth?: number }
  | { op: 'base-identity'; identity: GoldenBaseIdentityVariant }
  | { op: 'validate-base'; identity: GoldenBaseIdentityVariant };

/**
 * Which identity a base read is asked to confirm: the one the base was built
 * with, or one differing in exactly one marker.
 */
export type GoldenBaseIdentityVariant =
  | 'built'
  | 'other-head'
  | 'other-root'
  | 'other-repo'
  | 'other-languages';

/**
 * `worktree` is the head build of the fixture; `base` is a finalized base
 * build; `missing` names no database; `empty` is a database that never
 * completed a build.
 */
export type GoldenGraph = 'worktree' | 'base' | 'missing' | 'empty';

export interface GoldenReadCase {
  name: string;
  graph: GoldenGraph;
  read: GoldenGraphRead;
}

const CALC = 'src/calc.ts';
const MAIN = 'src/main.ts';
const ADD = `${CALC}::add`;
const MULTIPLY = `${CALC}::multiply`;
const SUBTRACT = `${CALC}::subtract`;
const CALCULATOR = `${CALC}::Calculator`;
const RUN = `${MAIN}::run`;

function query(
  name: string,
  read: Omit<Extract<GoldenGraphRead, { op: 'query' }>, 'op'>,
  graph: GoldenGraph = 'worktree',
): GoldenReadCase {
  return { name, graph, read: { op: 'query', ...read } };
}

/** Every read family the graph serves, against every graph state that matters. */
export const GOLDEN_READ_CASES: readonly GoldenReadCase[] = [
  { name: 'status/worktree', graph: 'worktree', read: { op: 'status' } },
  { name: 'status/missing', graph: 'missing', read: { op: 'status' } },
  { name: 'status/empty', graph: 'empty', read: { op: 'status' } },
  { name: 'summary/worktree', graph: 'worktree', read: { op: 'summary' } },
  { name: 'summary/base', graph: 'base', read: { op: 'summary' } },
  { name: 'summary/missing', graph: 'missing', read: { op: 'summary' } },
  { name: 'summary/empty', graph: 'empty', read: { op: 'summary' } },
  {
    name: 'fingerprint-metadata/worktree',
    graph: 'worktree',
    read: { op: 'fingerprint-metadata' },
  },
  {
    name: 'fingerprint-metadata/empty',
    graph: 'empty',
    read: { op: 'fingerprint-metadata' },
  },
  {
    name: 'fingerprint-metadata/missing',
    graph: 'missing',
    read: { op: 'fingerprint-metadata' },
  },
  query('callers/add', { method: 'callers', target: ADD }),
  query('callers/add-scoped', { method: 'callers', target: ADD, scoped: true }),
  query('callers/unknown', { method: 'callers', target: `${CALC}::missing` }),
  query('callees/multiply', { method: 'callees', target: MULTIPLY }),
  query('callees/run', { method: 'callees', target: RUN }),
  query('importers/calc', { method: 'importers', target: CALC }),
  query('imports/main', { method: 'imports', target: MAIN }),
  query('children/calculator', { method: 'children', target: CALCULATOR }),
  query('children/calc-file', { method: 'children', target: CALC }),
  query('tests-for/add', { method: 'tests-for', target: ADD }),
  query('docs-for/main', { method: 'docs-for', target: MAIN }),
  query('rationale-for/add', { method: 'rationale-for', target: ADD }),
  query('rationale-for/register', {
    method: 'rationale-for',
    target: `${MAIN}::register`,
  }),
  query('rationale-for/calc-file', { method: 'rationale-for', target: CALC }),
  query('file-summary/calc', { method: 'file-summary', target: CALC }),
  query('file-summary/readme', { method: 'file-summary', target: 'README.md' }),
  query('file-summary/unknown', { method: 'file-summary', target: 'nope.ts' }),
  query('scripts-for-file/package', {
    method: 'scripts-for-file',
    target: 'package.json',
  }),
  query('ipc-channel/qualified', {
    method: 'ipc-channel',
    target: 'src/channels.ts::ipc.COMPUTE',
  }),
  query('ipc-channel/value', {
    method: 'ipc-channel',
    target: 'fixture:compute',
  }),
  query('ipc-channel/key', { method: 'ipc-channel', target: 'RESET' }),
  query('symbol-detail/subtract', {
    method: 'symbol-detail',
    target: SUBTRACT,
  }),
  query('symbol-detail/calculator-sum', {
    method: 'symbol-detail',
    target: `${CALCULATOR}.sum`,
  }),
  query('community-for-symbol/add', {
    method: 'community-for-symbol',
    target: ADD,
  }),
  query('flows-for-symbol/add', {
    method: 'flows-for-symbol',
    target: ADD,
    limit: 10,
  }),
  query('derived-stats', { method: 'derived-stats' }),
  query('derived-stats/scoped', { method: 'derived-stats', scoped: true }),
  query('communities', { method: 'communities', limit: 10 }),
  query('flows', { method: 'flows', limit: 10 }),
  query('hubs', { method: 'hubs', limit: 5 }),
  query('search/add', { method: 'search', query: 'add', limit: 10 }),
  query('search/prefix', { method: 'search', query: 'mult', limit: 10 }),
  query('search/no-match', { method: 'search', query: 'zzzz', limit: 10 }),
  query('impact-radius/add', { method: 'impact-radius', target: ADD }),
  query('impact-radius/add-bounded', {
    method: 'impact-radius',
    target: ADD,
    maxDepth: 1,
    maxNodes: 2,
  }),
  query('call-path/run-to-add', {
    method: 'call-path',
    target: RUN,
    to: ADD,
  }),
  query('call-path/add-to-run', {
    method: 'call-path',
    target: ADD,
    to: RUN,
  }),
  query('relationship-path/report-to-calc', {
    method: 'relationship-path',
    target: 'src/report.ts',
    to: CALC,
  }),
  query('callers/add-base', { method: 'callers', target: ADD }, 'base'),
  {
    name: 'detect-changed/base',
    graph: 'worktree',
    read: { op: 'detect-changed', base: GOLDEN_BASE_TAG },
  },
  {
    name: 'detect-changed/head',
    graph: 'worktree',
    read: { op: 'detect-changed', base: 'HEAD' },
  },
  {
    name: 'detect-changed/unsafe-ref',
    graph: 'worktree',
    read: { op: 'detect-changed', base: '--output=/tmp/x' },
  },
  {
    name: 'change-impact/base',
    graph: 'worktree',
    read: { op: 'change-impact', base: GOLDEN_BASE_TAG },
  },
  {
    name: 'change-impact/base-depth-1',
    graph: 'worktree',
    read: { op: 'change-impact', base: GOLDEN_BASE_TAG, maxDepth: 1 },
  },
  {
    name: 'change-impact/head',
    graph: 'worktree',
    read: { op: 'change-impact', base: 'HEAD' },
  },
  ...(
    [
      'built',
      'other-head',
      'other-root',
      'other-repo',
      'other-languages',
    ] as const
  ).flatMap((identity): GoldenReadCase[] => [
    {
      name: `base-identity/${identity}`,
      graph: 'base',
      read: { op: 'base-identity', identity },
    },
    {
      name: `validate-base/${identity}`,
      graph: 'base',
      read: { op: 'validate-base', identity },
    },
  ]),
  {
    name: 'base-identity/worktree',
    graph: 'worktree',
    read: { op: 'base-identity', identity: 'built' },
  },
  {
    name: 'base-identity/missing',
    graph: 'missing',
    read: { op: 'base-identity', identity: 'built' },
  },
  {
    name: 'validate-base/missing',
    graph: 'missing',
    read: { op: 'validate-base', identity: 'built' },
  },
];
