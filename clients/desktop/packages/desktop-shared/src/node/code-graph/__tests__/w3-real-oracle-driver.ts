import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import { CodeGraphEngine, type CodeGraphInternalBuildOptions } from '../engine';
import {
  openCodeGraphDatabase,
  getMetadataValue,
  requireRow,
  requireNumber,
  requireString,
  type CodeGraphDatabase,
} from '../store/database';
import {
  projectW3Oracle,
  listW3DependencyProjection,
  type W3OracleTargets,
} from './w3-oracle-projections';
import { SqliteResolutionDependencyWriter } from '../resolve/resolution-dependency-store';
import { z } from 'zod';
import {
  CODE_GRAPH_PARSE_STATUSES,
  type CodeGraphParseStatus,
} from '../../../types/code-graph';
import {
  CAPTURED_HOST_OPERATION_PREFIX,
  resolutionInputsChanged,
} from '../resolve/ts-module-resolver';
import {
  w3DiagnosticsSchema,
  type W3QualifiedDiagnostics,
} from './w3-real-oracle-qualification';

export interface W3RepositoryObservation {
  repoId: string;
  compatibleCapture: boolean;
  indexedFiles: readonly {
    id: string;
    relativePath: string;
    parseStatus: CodeGraphParseStatus;
    hasErrors: boolean;
  }[];
  changedResolutionInputs: readonly {
    key: string;
    kind:
      | 'host-read-directory'
      | 'host-other'
      | 'file-exists'
      | 'directory-exists'
      | 'file-content';
  }[];
}

const parseStatusSchema = z.enum(CODE_GRAPH_PARSE_STATUSES);
const resolutionInputsSchema = z.record(z.string(), z.string().nullable());
const hostOperationTagSchema = z.object({
  operation: z.enum([
    'readDirectory',
    'getDirectories',
    'realpath',
    'currentDirectory',
    'executingFilePath',
    'compilerHost',
  ]),
});

/** Probe PRE-BUILD fingerprints against the post-edit checkout, without writes. */
async function changedResolutionInputs(
  dbPath: string,
): Promise<
  ReadonlyMap<string, W3RepositoryObservation['changedResolutionInputs']>
> {
  const db = openCodeGraphDatabase(dbPath);
  try {
    const changes = new Map<
      string,
      W3RepositoryObservation['changedResolutionInputs']
    >();
    const repositories = db
      .prepare('SELECT repo_id, root_path FROM repositories ORDER BY repo_id')
      .all();
    for (const value of repositories) {
      const row = requireRow(value);
      const repoId = requireString(row, 'repo_id');
      const rootPath = requireString(row, 'root_path');
      const saved = getMetadataValue(db, `resolution_inputs:${repoId}`);
      const changed: Array<
        W3RepositoryObservation['changedResolutionInputs'][number]
      > = [];
      if (saved !== null) {
        const inputs = resolutionInputsSchema.parse(JSON.parse(saved));
        for (const [key, fingerprint] of Object.entries(inputs)) {
          if (
            !(await resolutionInputsChanged(
              rootPath,
              JSON.stringify({ [key]: fingerprint }),
            ))
          )
            continue;
          let kind: W3RepositoryObservation['changedResolutionInputs'][number]['kind'];
          if (key.startsWith(CAPTURED_HOST_OPERATION_PREFIX)) {
            const operation = hostOperationTagSchema.parse(
              JSON.parse(
                decodeURIComponent(
                  key.slice(CAPTURED_HOST_OPERATION_PREFIX.length),
                ),
              ),
            );
            kind =
              operation.operation === 'readDirectory'
                ? 'host-read-directory'
                : 'host-other';
          } else if (key.startsWith('file-exists:')) kind = 'file-exists';
          else if (key.startsWith('directory-exists:'))
            kind = 'directory-exists';
          else kind = 'file-content';
          changed.push({ key, kind });
        }
      }
      changes.set(repoId, changed);
    }
    return changes;
  } finally {
    db.close();
  }
}

export interface W3FixtureEdit {
  name: string;
  write?: Readonly<Record<string, string>>;
  remove?: readonly string[];
  rename?: readonly { from: string; to: string }[];
}
export interface W3DriverObservation {
  step: number;
  edit: string;
  mode: string;
  diagnostics: W3QualifiedDiagnostics | null;
  completeCapture: boolean;
  repositories: readonly W3RepositoryObservation[];
}
export interface W3DriverInput {
  edits: readonly W3FixtureEdit[];
  assertEqual: (actual: unknown, expected: unknown, context: string) => void;
  observe?: (value: W3DriverObservation) => void;
  computeDerived?: boolean;
}

const INITIAL: Readonly<Record<string, string>> = {
  'src/lib.ts': 'export function run(): number { return 1; }\n',
  'src/barrel-a.ts': "export * from './barrel-b';\n",
  'src/barrel-b.ts':
    "export * from './barrel-a'; export { run } from './lib';\n",
  'src/main.ts':
    "import { run } from './barrel-a'; export function main() { return run(); }\n",
  'src/main.test.ts':
    "import { run } from './barrel-a'; function checks() { run(); } checks();\n",
  'src/shadow.ts':
    "import { run } from './lib'; export function shadow(run: () => number) { return run(); }\n",
  'src/package.ts':
    "import { run } from 'local-package'; export function packageRun() { return run(); }\n",
  'src/路径.ts': 'export function unicodeRun() { return 1; }\n',
  'tsconfig.json':
    '{"extends":"./base","compilerOptions":{"baseUrl":".","paths":{"local-package":["src/lib.ts"]}}}',
  'docs/main.md': '[run](../src/lib.ts#run)\n[missing](missing.md)\n',
  '.github/workflows/main.yml':
    'name: fixture\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./action\n      - uses: owner/external@main\n',
  'src/ipc.ts':
    "export const IPC_CHANNELS = { fixture: 'fixture:run' };\nipcMain.handle(IPC_CHANNELS.fixture, () => 1);\nipcRenderer.invoke(IPC_CHANNELS.fixture);\n",
  'secondary/src/lib.ts': 'export function run() { return 99; }\n',
};
function write(root: string, relative: string, contents: string): void {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}
function apply(root: string, edit: W3FixtureEdit): void {
  for (const relative of edit.remove ?? [])
    rmSync(path.join(root, relative), { recursive: true, force: true });
  for (const pair of edit.rename ?? []) {
    mkdirSync(path.dirname(path.join(root, pair.to)), { recursive: true });
    renameSync(path.join(root, pair.from), path.join(root, pair.to));
  }
  for (const [relative, contents] of Object.entries(edit.write ?? {}))
    write(root, relative, contents);
}
function targets(db: CodeGraphDatabase): W3OracleTargets[] {
  return ['fixture', 'secondary'].map((repoId): W3OracleTargets => {
    const symbols = db
      .prepare(
        'SELECT s.qualified_name FROM symbols s JOIN repositories r ON r.id=s.repository_id WHERE r.repo_id=? ORDER BY s.qualified_name',
      )
      .all(repoId)
      .map((row): string => requireString(requireRow(row), 'qualified_name'));
    const files = db
      .prepare(
        'SELECT f.relative_path FROM files f JOIN repositories r ON r.id=f.repository_id WHERE r.repo_id=? ORDER BY f.relative_path',
      )
      .all(repoId)
      .map((row): string => requireString(requireRow(row), 'relative_path'));
    return {
      repoId,
      symbols,
      files,
      searches: ['run', 'main', '路径', 'fixture', 'missing'],
      ipc: ['fixture', 'fixture:run'],
      paths: [{ from: 'src/main.ts::main', to: 'src/lib.ts::run' }],
    };
  });
}
function project(
  dbPath: string,
  inputChanges: ReadonlyMap<
    string,
    W3RepositoryObservation['changedResolutionInputs']
  > = new Map<string, W3RepositoryObservation['changedResolutionInputs']>(),
): {
  semantic: unknown;
  dependencies: unknown;
  diagnostics: W3QualifiedDiagnostics | null;
  complete: boolean;
  repositories: readonly W3RepositoryObservation[];
} {
  const db = openCodeGraphDatabase(dbPath);
  try {
    const metadata = getMetadataValue(db, 'resolution_candidate_diagnostics');
    const diagnostics =
      metadata === null
        ? null
        : w3DiagnosticsSchema.parse(JSON.parse(metadata));
    const writer = new SqliteResolutionDependencyWriter(db);
    const repositories: W3RepositoryObservation[] = db
      .prepare(
        'SELECT id, repo_id, root_path FROM repositories ORDER BY repo_id',
      )
      .all()
      .map((value): W3RepositoryObservation => {
        const row = requireRow(value);
        const repoId = requireString(row, 'repo_id');
        const indexedFiles = db
          .prepare(
            'SELECT id, relative_path, parse_status, has_errors FROM files WHERE repository_id=? ORDER BY id',
          )
          .all(requireString(row, 'id'))
          .map((fileValue) => {
            const file = requireRow(fileValue);
            return {
              id: requireString(file, 'id'),
              relativePath: requireString(file, 'relative_path'),
              parseStatus: parseStatusSchema.parse(
                requireString(file, 'parse_status'),
              ),
              hasErrors: requireNumber(file, 'has_errors') === 1,
            };
          });
        return {
          repoId,
          compatibleCapture: writer.isCompatible({
            repoId,
            rootPath: requireString(row, 'root_path'),
          }),
          indexedFiles,
          changedResolutionInputs: inputChanges.get(repoId) ?? [],
        };
      });
    return {
      semantic: projectW3Oracle(db, targets(db)),
      dependencies: listW3DependencyProjection(db),
      diagnostics,
      // Retain the existing fixture-only field for local-runner compatibility.
      complete:
        repositories.find((repo) => repo.repoId === 'fixture')
          ?.compatibleCapture ?? false,
      repositories,
    };
  } finally {
    db.close();
  }
}

interface PriorCommunityHistory {
  communities: Array<{
    id: string;
    repositoryId: string;
    label: string;
    cohesion: number;
    size: number;
    fingerprint: string;
    extraJson: string;
  }>;
  memberships: Array<{ communityId: string; symbolId: string }>;
}

function readPriorCommunityHistory(dbPath: string): PriorCommunityHistory {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      communities: db
        .prepare('SELECT * FROM communities ORDER BY id')
        .all()
        .map((value) => {
          const row = requireRow(value);
          return {
            id: requireString(row, 'id'),
            repositoryId: requireString(row, 'repository_id'),
            label: requireString(row, 'label'),
            cohesion: requireNumber(row, 'cohesion'),
            size: requireNumber(row, 'size'),
            fingerprint: requireString(row, 'fingerprint'),
            extraJson: requireString(row, 'extra_json'),
          };
        }),
      memberships: db
        .prepare(
          'SELECT * FROM community_memberships ORDER BY community_id, symbol_id',
        )
        .all()
        .map((value) => {
          const row = requireRow(value);
          return {
            communityId: requireString(row, 'community_id'),
            symbolId: requireString(row, 'symbol_id'),
          };
        }),
    };
  } finally {
    db.close();
  }
}

/** Supply only pre-edit identity history; all graph facts are rebuilt cold. */
function seedPriorCommunityHistory(
  dbPath: string,
  history: PriorCommunityHistory,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const table of [
      'files',
      'symbols',
      'edges',
      'symbol_fts_rows',
      'symbol_fts',
      'symbol_fragment_fts',
      'resolution_dependencies',
      'communities',
      'community_memberships',
      'flows',
      'flow_memberships',
    ]) {
      const count = requireNumber(
        requireRow(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()),
        'n',
      );
      if (count !== 0)
        throw new Error(`Cold oracle already contains ${table} facts`);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const communityInsert = db.prepare(
        'INSERT INTO communities(id, repository_id, label, cohesion, size, fingerprint, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const community of history.communities) {
        communityInsert.run(
          community.id,
          community.repositoryId,
          community.label,
          community.cohesion,
          community.size,
          community.fingerprint,
          community.extraJson,
        );
      }
      const membershipInsert = db.prepare(
        'INSERT INTO community_memberships(community_id, symbol_id) VALUES (?, ?)',
      );
      for (const membership of history.memberships) {
        membershipInsert.run(membership.communityId, membership.symbolId);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

/**
 * Actual production engine/resolvers/SQLite overlay, NOT the closure model.
 * All candidates use identical checkout bytes and distinct PRIVATE fixture DBs.
 * The cold oracle starts fresh facts at EVERY intermediate edit, with only the
 * matched pre-edit community identity history when derived analysis is enabled.
 * No live app DB
 * or immutable published base is opened or changed. Caller retains reports.
 * This function is test source only; no execution occurred while drafting it.
 */
export async function runW3RealOracle(
  input: W3DriverInput,
): Promise<readonly W3DriverObservation[]> {
  const temporary = mkdtempSync(path.join(tmpdir(), 'w3-private-oracle-'));
  const root = path.join(temporary, 'checkout');
  mkdirSync(root, { recursive: true });
  for (const [relative, contents] of Object.entries(INITIAL))
    write(root, relative, contents);
  const repositories = [
    { repoId: 'fixture', rootPath: root },
    { repoId: 'secondary', rootPath: path.join(root, 'secondary') },
  ];
  const modes: readonly {
    name: string;
    options: CodeGraphInternalBuildOptions;
  }[] = [
    { name: 'full-reset', options: { resolutionMode: 'full-reset' } },
    {
      name: 'full-diff',
      options: {
        resolutionMode: 'full-diff',
        captureResolutionDependencies: true,
      },
    },
    {
      name: 'incremental',
      options: {
        resolutionMode: 'incremental',
        captureResolutionDependencies: true,
      },
    },
  ];
  const engines: {
    name: string;
    options: CodeGraphInternalBuildOptions;
    engine: CodeGraphEngine;
    dbPath: string;
  }[] = [];
  const observations: W3DriverObservation[] = [];
  try {
    for (const mode of modes) {
      const dbPath = path.join(temporary, mode.name, 'graph.db');
      engines.push({
        ...mode,
        dbPath,
        engine: await CodeGraphEngine.open({ dbPath, repositories }),
      });
    }
    const edits: readonly W3FixtureEdit[] = [
      { name: 'initial-complete-full-capture' },
      ...input.edits,
    ];
    for (const [step, edit] of Array.from(edits.entries())) {
      // The baseline preserves community identities across changed memberships.
      // Supply the same PRE-EDIT identity history to the independently rebuilt
      // cold graph, never current facts, bindings, FTS, flows or dependencies.
      const reset = engines.find(
        (candidate) => candidate.name === 'full-reset',
      );
      if (!reset) throw new Error('Missing independent reset oracle');
      const priorHistory =
        input.computeDerived === true
          ? readPriorCommunityHistory(reset.dbPath)
          : null;
      apply(root, edit);
      const incremental = engines.find(
        (candidate) => candidate.name === 'incremental',
      );
      if (incremental === undefined)
        throw new Error('Missing incremental engine');
      const inputChanges = await changedResolutionInputs(incremental.dbPath);
      for (const candidate of engines)
        await candidate.engine.buildOrUpdate({
          ...candidate.options,
          verifyContent: true,
          computeDerived: input.computeDerived ?? false,
        });
      const coldDb = path.join(temporary, 'cold', String(step), 'graph.db');
      const cold = await CodeGraphEngine.open({ dbPath: coldDb, repositories });
      try {
        if (priorHistory !== null)
          seedPriorCommunityHistory(coldDb, priorHistory);
        await cold.buildOrUpdate({
          verifyContent: true,
          computeDerived: input.computeDerived ?? false,
        });
      } finally {
        cold.close();
      }
      const expected = project(coldDb);
      let fullDependencies: unknown = undefined;
      for (const candidate of engines) {
        const actual = project(
          candidate.dbPath,
          candidate.name === 'incremental'
            ? inputChanges
            : new Map<
                string,
                W3RepositoryObservation['changedResolutionInputs']
              >(),
        );
        input.assertEqual(
          actual.semantic,
          expected.semantic,
          `${step}:${edit.name}:${candidate.name}:cold`,
        );
        if (candidate.name === 'full-diff')
          fullDependencies = actual.dependencies;
        if (candidate.name === 'incremental')
          input.assertEqual(
            actual.dependencies,
            fullDependencies,
            `${step}:${edit.name}:dependencies`,
          );
        const observation: W3DriverObservation = {
          step,
          edit: edit.name,
          mode: candidate.name,
          diagnostics: actual.diagnostics,
          completeCapture: actual.complete,
          repositories: actual.repositories,
        };
        observations.push(observation);
        input.observe?.(observation);
      }
    }
    return observations;
  } finally {
    for (const candidate of engines) candidate.engine.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Bounded ordinary CI edits; the larger seeded driver is deliberately opt-in. */
export const W3_ADVERSARIAL_EDITS: readonly W3FixtureEdit[] = [
  {
    name: 'alias-star-cycle-ambiguity',
    write: {
      'src/barrel-b.ts':
        "export * from './barrel-a'; export { run } from './lib'; export { run } from './alternate';",
      'src/alternate.ts': 'export function run() { return 2; }',
    },
  },
  {
    name: 'ambiguity-to-unresolved',
    write: {
      'src/lib.ts': 'export function other() { return 3; }',
      'src/alternate.ts': 'export function other() { return 4; }',
    },
  },
  {
    name: 'unresolved-to-resolvable',
    write: { 'src/lib.ts': 'export function run() { return 5; }' },
  },
  { name: 'delete-export-target', remove: ['src/lib.ts'] },
  {
    name: 'rename-recreated-target',
    write: { 'src/lib.ts': 'export function run() { return 6; }' },
  },
  {
    name: 'rename-production-to-test-target',
    rename: [{ from: 'src/lib.ts', to: 'src/lib.test.ts' }],
    write: {
      'src/barrel-b.ts': "export { run } from './lib.test';",
      'tsconfig.json':
        '{"compilerOptions":{"baseUrl":".","paths":{"local-package":["src/lib.test.ts"]}}}',
    },
  },
  {
    name: 'target-isTest-restored',
    rename: [{ from: 'src/lib.test.ts', to: 'src/lib.ts' }],
    write: {
      'src/barrel-b.ts':
        "export * from './barrel-a'; export { run } from './lib';",
      'tsconfig.json':
        '{"extends":"./base","compilerOptions":{"baseUrl":".","paths":{"local-package":["src/lib.ts"]}}}',
    },
  },
  {
    name: 'inherited-config-created',
    write: {
      'base.json': '{"compilerOptions":{"strict":true}}',
      'docs/missing.md': '# New missing target',
      'action/action.yml':
        'name: local\nruns:\n  using: composite\n  steps: []\n',
    },
  },
  {
    name: 'local-manifest-ambiguity-ipc-uniqueness',
    write: {
      'action/action.yaml':
        'name: duplicate\nruns:\n  using: composite\n  steps: []\n',
      'src/ipc-extra.ts':
        "export const IPC_CHANNELS = { fixture: 'fixture:other' };\nipcMain.handle(IPC_CHANNELS.fixture, () => 2);",
    },
  },
  {
    name: 'package-exports-map',
    write: {
      'tsconfig.json':
        '{"compilerOptions":{"moduleResolution":"bundler","module":"esnext"}}',
      'node_modules/local-package/package.json':
        '{"name":"local-package","exports":{".":"./index.ts"}}',
      'node_modules/local-package/index.ts':
        'export function run() { return 8; }',
    },
  },
  {
    name: 'node-modules-disappearance-ancestor-negative-config',
    remove: ['node_modules/local-package', 'base.json', 'action/action.yaml'],
    write: { '../tsconfig.json': '{"compilerOptions":{"allowJs":true}}' },
  },
  {
    name: 'parse-failure-and-freshness',
    write: {
      'src/broken.ts': 'export function broken( { ???',
      'src/路径.ts': 'export function unicodeRun() { return 7; }',
    },
  },
  {
    name: 'parse-recovery',
    write: { 'src/broken.ts': 'export function repaired() { return 10; }' },
  },
];

/** Fixed LCG, >=100 real intermediate edits; retained local qualification only. */
export function w3FixedSeedEdits(
  steps = 100,
  seed = 0x5733,
): readonly W3FixtureEdit[] {
  if (steps < 100)
    throw new Error('Local W3 qualification requires at least 100 steps');
  let state = seed >>> 0;
  const result: W3FixtureEdit[] = [];
  for (let step = 0; step < steps; step += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const variant = state % 6;
    const exportName = variant === 0 ? 'other' : 'run';
    result.push({
      name: `seed-${seed}-step-${step}-variant-${variant}`,
      write: {
        'src/lib.ts': `export function ${exportName}() { return ${step}; }`,
        'src/barrel-b.ts':
          variant === 1
            ? "export * from './barrel-a';"
            : variant === 2
              ? "export * from './barrel-a'; export * from './lib';"
              : "export { run } from './lib';",
        'src/alternate.ts':
          variant === 3
            ? 'export function run() { return 2; }'
            : 'export function alternate() { return 3; }',
        'src/main.ts':
          variant === 4
            ? "import { run as invoke } from './barrel-a'; export function main() { return invoke(); }"
            : "import { run } from './barrel-a'; export function main() { return run(); }",
        'base.json': JSON.stringify({
          compilerOptions: {
            strict: variant % 2 === 0,
            paths: {
              'local-package': [
                variant === 5 ? 'src/alternate.ts' : 'src/lib.ts',
              ],
            },
          },
        }),
      },
    });
  }
  return [...W3_ADVERSARIAL_EDITS, ...result];
}
