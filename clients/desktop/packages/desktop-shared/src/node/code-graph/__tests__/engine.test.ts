import {
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import { CodeGraphEngine } from '../engine';
import { cloneCompletedCodeGraphDatabase } from '../base-graph';
import {
  CODE_GRAPH_MAX_FILE_BYTES,
  CODE_GRAPH_SCHEMA_VERSION,
} from '../../../types/code-graph';
import {
  deleteMetadataValue,
  openCodeGraphDatabase,
  requireRow,
  requireString,
  setMetadataValue,
} from '../store/database';
import { CodeGraphStore } from '../store/graph-store';
import { fileQualifiedName, fileRowId, symbolRowId } from '../ids';
import { CodeGraphParserRuntime } from '../parser/runtime';

const LIB = `export function doWork(): number {
  return 42;
}
`;
const MAIN = `import { doWork } from './lib';

export function run(): number {
  return doWork();
}
`;
const TEST = `import { doWork } from '../lib';

function checksDoWork(): void {
  doWork();
}
checksDoWork();
`;

// Compare semantic facts, including raw refs, confidence, provenance and test
// links. Derived IDs/timestamps and absolute checkout paths are deliberately absent.
function canonicalFacts(dbPath: string): unknown {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      symbols: db
        .prepare(
          'SELECT id, repository_id, file_id, kind, name, qualified_name, parent_symbol_id, line_start, line_end, byte_start, byte_end, signature, exported, is_test, extra_json FROM symbols ORDER BY id',
        )
        .all()
        .map((row) => {
          const extraJson: unknown = JSON.parse(String(row.extra_json));
          return { ...row, extra_json: extraJson };
        }),
      edges: db
        .prepare('SELECT * FROM edges ORDER BY id')
        .all()
        .map((row) => {
          const evidenceJson: unknown = JSON.parse(String(row.evidence_json));
          return { ...row, evidence_json: evidenceJson };
        }),
    };
  } finally {
    db.close();
  }
}

function semanticFtsState(dbPath: string): Record<string, unknown[]> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      primary: db
        .prepare(
          'SELECT symbol_id, name, qualified_name, signature, file_path FROM symbol_fts ORDER BY symbol_id',
        )
        .all(),
      fragments: db
        .prepare(
          'SELECT symbol_id, name_folded, qualified_name_folded FROM symbol_fragment_fts ORDER BY symbol_id',
        )
        .all(),
      mapping: db
        .prepare(
          'SELECT symbol_id, file_id, repository_id FROM symbol_fts_rows ORDER BY symbol_id',
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

describe('CodeGraphEngine end to end', () => {
  let root: string;
  let dbPath: string;
  let engine: CodeGraphEngine;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-engine-'));
    mkdirSync(path.join(root, 'src', '__tests__'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'lib.ts'), LIB);
    writeFileSync(path.join(root, 'src', 'main.ts'), MAIN);
    writeFileSync(path.join(root, 'src', '__tests__', 'lib.test.ts'), TEST);
    dbPath = path.join(root, '.graph', 'graph.db');
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
    });
  });
  afterEach(() => {
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('never resolves an unknown Prisma field type to a same-named value field', async () => {
    writeFileSync(
      path.join(root, 'schema.prisma'),
      'model User {\n ref Missing\n Missing String\n}',
    );
    await engine.buildOrUpdate();
    const db = new DatabaseSync(dbPath);
    try {
      expect(
        db
          .prepare(
            "SELECT target_symbol_id FROM edges WHERE kind = 'REFERENCES' AND target_ref = 'Missing'",
          )
          .get(),
      ).toMatchObject({ target_symbol_id: null });
    } finally {
      db.close();
    }
  });

  it('links relative config extends arrays and invalidates retargeted links', async () => {
    writeFileSync(path.join(root, 'tsconfig.base.json'), '{}');
    writeFileSync(path.join(root, 'tsconfig.other.json'), '{}');
    writeFileSync(
      path.join(root, 'tsconfig.json'),
      '{ // shared settings\n "extends": ["./tsconfig.base",],\n}',
    );
    await engine.buildOrUpdate();
    const query = (to: string): string =>
      engine.queries().getRelationshipPath({
        target: 'tsconfig.json::config',
        to,
        mode: 'relationship-path',
        repoId: 'fixture',
      }).status;
    expect(query('tsconfig.base.json::config')).toBe('found');
    writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ extends: ['./tsconfig.other.json'] }),
    );
    await engine.buildOrUpdate({ verifyContent: true });
    expect(query('tsconfig.base.json::config')).toBe('no-path');
    expect(query('tsconfig.other.json::config')).toBe('found');
  });

  it('rebinds untouched consumers after an alias changes and matches a cold build', async () => {
    writeFileSync(path.join(root, 'src', 'other.ts'), LIB);
    const config = (target: string): string =>
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@audit': [target] },
        },
      });
    writeFileSync(path.join(root, 'tsconfig.json'), config('src/lib.ts'));
    writeFileSync(
      path.join(root, 'src', 'main.ts'),
      "import { doWork } from '@audit'; export function run(){ return doWork(); }\n",
    );
    writeFileSync(
      path.join(root, 'src', '__tests__', 'lib.test.ts'),
      "import { doWork } from '@audit'; function check(){ doWork(); } check();\n",
    );
    await engine.buildOrUpdate();
    writeFileSync(path.join(root, 'tsconfig.json'), config('src/other.ts'));
    await engine.buildOrUpdate();
    const cold = await CodeGraphEngine.open({
      dbPath: path.join(root, '.cold', 'graph.db'),
      repositories: [{ repoId: 'fixture', rootPath: root }],
    });
    try {
      await cold.buildOrUpdate();
      expect(canonicalFacts(dbPath)).toEqual(
        canonicalFacts(path.join(root, '.cold', 'graph.db')),
      );
      for (const name of ['src/lib.ts::doWork', 'src/other.ts::doWork']) {
        expect(engine.queries().getCallers(name)).toEqual(
          cold.queries().getCallers(name),
        );
        expect(engine.queries().getTestsFor(name)).toEqual(
          cold.queries().getTestsFor(name),
        );
      }
    } finally {
      cold.close();
    }
  });

  it.each([
    'inherited-config',
    'package-imports',
    'package-exports',
    'missing-package-install',
    'file-precedence',
    'deletion',
    'ipc-ambiguity',
    'action-ambiguity',
  ])(
    'matches cold and cloned-seed facts after %s changes',
    async (scenario) => {
      const put = (name: string, content: string): void => {
        mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        writeFileSync(path.join(root, name), content);
      };
      const config = (target: string): string =>
        JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@audit': [target] } },
        });
      let change: () => void;
      if (scenario === 'inherited-config') {
        put('base.json', config('src/lib.ts'));
        put('tsconfig.json', JSON.stringify({ extends: './base.json' }));
        put('src/other.ts', LIB);
        put(
          'src/main.ts',
          "import { doWork } from '@audit'; export function run(){ doWork(); }",
        );
        change = (): void => put('base.json', config('src/other.ts'));
      } else if (
        scenario === 'package-imports' ||
        scenario === 'package-exports'
      ) {
        const manifest = (target: string): string =>
          JSON.stringify({
            type: 'module',
            name: 'audit-package',
            ...(scenario === 'package-imports'
              ? { imports: { '#audit': target } }
              : { exports: { '.': { import: target, require: target } } }),
          });
        put('package.json', manifest('./src/lib.ts'));
        put(
          'tsconfig.json',
          JSON.stringify({
            compilerOptions: {
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
            },
          }),
        );
        put('src/other.ts', LIB);
        put(
          'src/main.ts',
          `import { doWork } from '${scenario === 'package-imports' ? '#audit' : 'audit-package'}'; export function run(){ doWork(); }`,
        );
        change = (): void => put('package.json', manifest('./src/other.ts'));
      } else if (scenario === 'missing-package-install') {
        put(
          'src/main.ts',
          "import { installed } from 'audit-installed-later'; export function run(){ installed(); }",
        );
        change = (): void => {
          put(
            'node_modules/audit-installed-later/package.json',
            JSON.stringify({
              name: 'audit-installed-later',
              version: '1.0.0',
              types: 'index.d.ts',
            }),
          );
          put(
            'node_modules/audit-installed-later/index.d.ts',
            'export declare function installed(): void;\n',
          );
        };
      } else if (scenario === 'file-precedence') {
        put('src/entry/index.ts', LIB);
        put(
          'src/main.ts',
          "import { doWork } from './entry'; export function run(){ doWork(); }",
        );
        change = (): void => put('src/entry.ts', LIB);
      } else if (scenario === 'deletion') {
        change = (): void => unlinkSync(path.join(root, 'src/lib.ts'));
      } else if (scenario === 'ipc-ambiguity') {
        const channels =
          "export const IPC_CHANNELS = { audit: 'audit:load' } as const;";
        put('src/shared/channels.ts', channels);
        put(
          'src/main/register.ts',
          'export function registerHandlers(){ registerIpcHandler(IPC_CHANNELS.audit, () => {}); }',
        );
        change = (): void => put('src/shared/duplicate.ts', channels);
      } else {
        const action =
          'name: Local\nruns:\n  using: node20\n  main: index.js\n';
        put(
          '.github/workflows/ci.yml',
          'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/local\n',
        );
        put('.github/actions/local/action.yml', action);
        change = (): void => put('.github/actions/local/action.yaml', action);
      }
      await engine.buildOrUpdate();
      if (scenario.startsWith('package-') || scenario === 'inherited-config') {
        expect(
          engine
            .queries()
            .getCallers('src/lib.ts::doWork')
            .map((hit) => hit.qualifiedName),
        ).toContain('src/main.ts::run');
      }
      const seededPath = path.join(root, '.seeded/graph.db');
      expect(
        (
          await cloneCompletedCodeGraphDatabase({
            sourceDbPath: dbPath,
            targetDbPath: seededPath,
            repositories: [{ repoId: 'fixture', rootPath: root }],
          })
        ).installed,
      ).toBe(true);
      change();
      await engine.buildOrUpdate({ verifyContent: true });
      if (scenario.startsWith('package-') || scenario === 'inherited-config') {
        expect(
          engine
            .queries()
            .getCallers('src/other.ts::doWork')
            .map((hit) => hit.qualifiedName),
        ).toContain('src/main.ts::run');
        expect(
          engine
            .queries()
            .getCallers('src/lib.ts::doWork')
            .map((hit) => hit.qualifiedName),
        ).not.toContain('src/main.ts::run');
      }
      const seeded = await CodeGraphEngine.open({
        dbPath: seededPath,
        repositories: [{ repoId: 'fixture', rootPath: root }],
      });
      const coldPath = path.join(root, '.cold/graph.db');
      const cold = await CodeGraphEngine.open({
        dbPath: coldPath,
        repositories: [{ repoId: 'fixture', rootPath: root }],
      });
      try {
        await seeded.buildOrUpdate({ verifyContent: true });
        await cold.buildOrUpdate();
        expect(canonicalFacts(dbPath)).toEqual(canonicalFacts(coldPath));
        expect(canonicalFacts(seededPath)).toEqual(canonicalFacts(coldPath));
        const beforeNoOp = canonicalFacts(dbPath);
        expect((await engine.buildOrUpdate()).filesParsed).toBe(0);
        expect(canonicalFacts(dbPath)).toEqual(beforeNoOp);
      } finally {
        seeded.close();
        cold.close();
      }
    },
  );

  it('keeps nested helper bindings in their lexical scope and honors parameter shadows', async () => {
    writeFileSync(
      path.join(root, 'src', 'scope.ts'),
      `export function first(){
      function helper(){ return 1; }
      return helper();
    }
    export function second(){
      function helper(){ return 2; }
      return helper();
    }
    function helper(){ return 3; }
    export function shadow(helper: () => number){ return helper(); }
    `,
    );
    await engine.buildOrUpdate();
    expect(
      engine
        .queries()
        .getCallers('src/scope.ts::first.helper')
        .map((c) => c.qualifiedName),
    ).toEqual(['src/scope.ts::first']);
    expect(
      engine
        .queries()
        .getCallers('src/scope.ts::second.helper')
        .map((c) => c.qualifiedName),
    ).toEqual(['src/scope.ts::second']);
    expect(engine.queries().getCallers('src/scope.ts::helper')).toEqual([]);
  });

  it('honors namespace, catch, loop and local-value shadows without guessing member receivers', async () => {
    writeFileSync(
      path.join(root, 'src', 'shadows.ts'),
      `
      import * as lib from './lib';
      import { doWork } from './lib';
      export function namespace(){ return lib.doWork(); }
      export function shadow(lib: { doWork(): number }){ return lib.doWork(); }
      export function caught(){ try {} catch(doWork){ doWork(); } }
      export function loop(items: any[]){ for(const doWork of items){ doWork(); } }
      export function varLoop(items: any[]){ for(var doWork of items){} doWork(); }
      export function local(){ const doWork = 1; doWork(); }
      export class A { doWork(){}; run(){ this.doWork(); } }
      export class B { doWork(){}; run(){ this.doWork(); } }
    `,
    );
    await engine.buildOrUpdate();
    expect(
      engine
        .queries()
        .getCallers('src/lib.ts::doWork')
        .map((c) => c.qualifiedName)
        .filter((name) => name.startsWith('src/shadows')),
    ).toEqual(['src/shadows.ts::namespace']);
    expect(engine.queries().getCallers('src/shadows.ts::A.doWork')).toEqual([]);
    expect(engine.queries().getCallers('src/shadows.ts::B.doWork')).toEqual([]);
  });

  it('keeps non-call argument references off the receiver and binds named class expressions locally', async () => {
    writeFileSync(
      path.join(root, 'src', 'types.ts'),
      `export class Bar {}
      export class Inner {}
      `,
    );
    writeFileSync(
      path.join(root, 'src', 'reference-scopes.ts'),
      `import { Bar, Inner } from './types';
      declare const lib: { run(callback: unknown): void };
      export function consume(){ lib.run((value: Bar) => value); }
      export const Factory = class Inner {
        static make(){ return new Inner(); }
      };
      `,
    );

    await engine.buildOrUpdate();
    const verificationDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const barResolution = verificationDb
        .prepare(
          `SELECT target.qualified_name, edge.evidence_json
           FROM edges edge
           JOIN files source_file ON source_file.id = edge.source_file_id
           LEFT JOIN symbols target ON target.id = edge.target_symbol_id
           WHERE source_file.relative_path = ? AND edge.target_ref = ?`,
        )
        .get('src/reference-scopes.ts', 'Bar');
      expect(JSON.stringify(barResolution)).toContain('src/types.ts::Bar');
      expect(JSON.stringify(barResolution)).not.toContain('"memberCall":true');

      const innerResolution = verificationDb
        .prepare(
          `SELECT target.qualified_name, edge.evidence_json
           FROM edges edge
           JOIN files source_file ON source_file.id = edge.source_file_id
           LEFT JOIN symbols target ON target.id = edge.target_symbol_id
           WHERE source_file.relative_path = ? AND edge.target_ref = ?`,
        )
        .get('src/reference-scopes.ts', 'Inner');
      expect(JSON.stringify(innerResolution)).toContain(
        'src/reference-scopes.ts::Inner',
      );
      expect(JSON.stringify(innerResolution)).not.toContain(
        'src/types.ts::Inner',
      );
    } finally {
      verificationDb.close();
    }
  });

  it('attributes same-line calls by source span, including Unicode prefixes', async () => {
    writeFileSync(
      path.join(root, 'src', 'span.ts'),
      'const 名 = "é"; export function outer(){ function inner(){ return 1; } return inner(); }\n',
    );
    await engine.buildOrUpdate();
    expect(
      engine
        .queries()
        .getCallers('src/span.ts::outer.inner')
        .map((c) => c.qualifiedName),
    ).toEqual(['src/span.ts::outer']);
  });

  it('verifies same-stat content on an explicit verification build', async () => {
    const sourcePath = path.join(root, 'src', 'stat.ts');
    writeFileSync(sourcePath, 'export function oldName(){ return 1; }\n');
    utimesSync(sourcePath, 1700000000, 1700000000);
    await engine.buildOrUpdate();
    writeFileSync(sourcePath, 'export function newName(){ return 1; }\n');
    utimesSync(sourcePath, 1700000000, 1700000000);
    const options = { computeDerived: false, verifyContent: true };
    await engine.buildOrUpdate(options);
    expect(
      engine.queries().getSymbolDetail('src/stat.ts::newName'),
    ).not.toBeNull();
    expect(engine.queries().getSymbolDetail('src/stat.ts::oldName')).toBeNull();
  });

  it('verifies unchanged content without hydrating every file record', async () => {
    for (let i = 0; i < 64; i++) {
      writeFileSync(path.join(root, 'src', `unchanged${i}.ts`), LIB);
    }
    await engine.buildOrUpdate();
    const before = canonicalFacts(dbPath);
    const reads = jest.spyOn(CodeGraphStore.prototype, 'getFileById');
    try {
      const result = await engine.buildOrUpdate({ verifyContent: true });
      expect(result.filesParsed).toBe(0);
      expect(reads.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      reads.mockRestore();
    }
    expect(canonicalFacts(dbPath)).toEqual(before);
  });

  it.each([
    ['content verification', { verifyContent: true }],
    ['forced reparse', { forceReparse: true }],
  ])(
    'downgrades %s freshness when a scanned file becomes unreadable',
    async (_label, options) => {
      const sourcePath = path.join(root, 'src', 'unreadable.ts');
      writeFileSync(sourcePath, 'export function staleName(){ return 1; }\n');
      await engine.buildOrUpdate();
      writeFileSync(sourcePath, 'export function freshName(){ return 1; }\n');

      const originalReadFile = fs.readFile.bind(fs);
      const readFile = jest
        .spyOn(fs, 'readFile')
        .mockImplementation(async (...args) => {
          if (
            typeof args[0] === 'string' &&
            path.resolve(args[0]) === sourcePath
          ) {
            throw new Error('simulated mid-build read failure');
          }
          return await originalReadFile(...args);
        });
      try {
        await engine.buildOrUpdate(options);
      } finally {
        readFile.mockRestore();
      }

      expect(engine.getStatus().diagnostics?.freshness).toBe('stat');
      expect(
        engine.queries().getSymbolDetail('src/unreadable.ts::staleName'),
      ).not.toBeNull();
      expect(
        engine.queries().getSymbolDetail('src/unreadable.ts::freshName'),
      ).toBeNull();
    },
  );

  it('resolves named and default forwarding without guessing conflicting star exports', async () => {
    writeFileSync(
      path.join(root, 'src', 'barrel.ts'),
      "export { doWork as forwarded } from './lib';\n",
    );
    writeFileSync(
      path.join(root, 'src', 'default.ts'),
      'export default function original(){ return 1; }\n',
    );
    writeFileSync(
      path.join(root, 'src', 'consumer.ts'),
      "import { forwarded } from './barrel'; import local from './default'; export function consume(){ forwarded(); local(); }\n",
    );
    await engine.buildOrUpdate();
    expect(
      engine
        .queries()
        .getCallers('src/lib.ts::doWork')
        .map((c) => c.qualifiedName),
    ).toContain('src/consumer.ts::consume');
    expect(
      engine
        .queries()
        .getCallers('src/default.ts::original')
        .map((c) => c.qualifiedName),
    ).toEqual(['src/consumer.ts::consume']);
  });

  it('resolves exported ambient declarations across modules', async () => {
    writeFileSync(
      path.join(root, 'src', 'ambient.ts'),
      [
        'export declare function ambientCall(): void;',
        'export declare class AmbientClass {}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(root, 'src', 'ambient-consumer.ts'),
      [
        "import { AmbientClass, ambientCall } from './ambient';",
        'export function consumeAmbient(): AmbientClass {',
        '  ambientCall();',
        '  return new AmbientClass();',
        '}',
        '',
      ].join('\n'),
    );
    await engine.buildOrUpdate();

    expect(
      engine.queries().getSymbolDetail('src/ambient.ts::ambientCall')?.exported,
    ).toBe(true);
    expect(
      engine.queries().getSymbolDetail('src/ambient.ts::AmbientClass')
        ?.exported,
    ).toBe(true);
    expect(
      engine
        .queries()
        .getCallers('src/ambient.ts::ambientCall')
        .map((caller) => caller.qualifiedName),
    ).toContain('src/ambient-consumer.ts::consumeAmbient');
  });

  it('resolves recursive calls from overloaded implementations', async () => {
    writeFileSync(
      path.join(root, 'src', 'overloaded.ts'),
      [
        'export function overloaded(value: string): string;',
        'export function overloaded(value: number): number;',
        'export function overloaded(value: string | number): string | number {',
        "  return typeof value === 'string' ? overloaded(value.length) : value;",
        '}',
        '',
      ].join('\n'),
    );

    await engine.buildOrUpdate();

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const recursiveCall = store
        .listEdges({
          kind: 'CALLS',
          repoId: 'fixture',
          sourceFileId: fileRowId('fixture', 'src/overloaded.ts'),
        })
        .find((edge) => edge.targetRef === 'overloaded');
      const overloadedId = symbolRowId(
        'fixture',
        'src/overloaded.ts::overloaded',
      );
      expect(recursiveCall).toMatchObject({
        sourceSymbolId: overloadedId,
        targetSymbolId: overloadedId,
        resolverId: 'local-scope',
      });
      expect(recursiveCall?.evidence.shadowed).not.toBe(true);
    } finally {
      db.close();
    }
  });

  it('does not invent named exports for default declarations or nested helpers', async () => {
    writeFileSync(
      path.join(root, 'src/default-only.ts'),
      'export default function hidden(){ function nested(){} return nested(); }',
    );
    writeFileSync(
      path.join(root, 'src/default-consumer.ts'),
      "import { hidden } from './default-only'; export function invalid(){ hidden(); }",
    );
    await engine.buildOrUpdate();
    expect(engine.queries().getCallers('src/default-only.ts::hidden')).toEqual(
      [],
    );
    expect(
      engine.queries().getSymbolDetail('src/default-only.ts::hidden.nested')
        ?.exported,
    ).toBe(false);
  });

  it('leaves conflicting stars and unresolved explicit exports unbound while terminating cycles', async () => {
    const put = (name: string, source: string): void =>
      writeFileSync(path.join(root, 'src', name), source);
    put('one.ts', 'export function shared(){ return 1; }\n');
    put('two.ts', 'export function shared(){ return 2; }\n');
    put('stars.ts', "export * from './one'; export * from './two';\n");
    put(
      'missing.ts',
      "export { shared } from './absent'; export * from './one';\n",
    );
    put(
      'cycle.ts',
      "export * from './cycle'; export { shared } from './one';\n",
    );
    put(
      'consumers.ts',
      "import { shared as ambiguous } from './stars'; import { shared as missing } from './missing'; import { shared as safe } from './cycle'; export function run(){ ambiguous(); missing(); safe(); }\n",
    );
    await engine.buildOrUpdate();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT target_ref, target_symbol_id FROM edges WHERE kind = 'CALLS' AND target_ref IN ('ambiguous','missing','safe') ORDER BY target_ref",
        )
        .all();
      expect(rows.slice(0, 2)).toEqual([
        { target_ref: 'ambiguous', target_symbol_id: null },
        { target_ref: 'missing', target_symbol_id: null },
      ]);
      expect(rows[2]?.target_ref).toBe('safe');
      expect(typeof rows[2]?.target_symbol_id).toBe('string');
    } finally {
      db.close();
    }
  });

  it('persists corpus and analysis diagnostics across a reopen and no-op build', async () => {
    writeFileSync(path.join(root, 'unclassified.xyz'), 'unclassified');
    await engine.buildOrUpdate();
    engine.close();
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
    });
    const checkDiagnostics = (): void => {
      const diagnostics = engine.getStatus().diagnostics;
      expect(diagnostics?.repositories[0].examples).toContain(
        'unclassified.xyz',
      );
      expect(diagnostics?.repositories[0].unsupportedFiles).toBeGreaterThan(0);
      expect(diagnostics?.repositories[0].communityStatus).toBe('complete');
    };
    checkDiagnostics();
    await engine.buildOrUpdate();
    checkDiagnostics();
  });

  it('builds, resolves imports and calls, links tests, and reports status', async () => {
    const result = await engine.buildOrUpdate();
    expect(result.filesParsed).toBe(3);
    expect(result.filesUnchanged).toBe(0);
    expect(result.parseFailures).toBe(0);
    expect(result.symbolCount).toBeGreaterThanOrEqual(6); // 3 file symbols + doWork + run + checksDoWork

    const status = engine.getStatus();
    expect(status.schemaVersion).toBe(CODE_GRAPH_SCHEMA_VERSION);
    expect(status.repositories[0].fileCount).toBe(3);
    expect(status.lastBuildAt).not.toBeNull();

    const queries = engine.queries();
    const callers = queries.getCallers('src/lib.ts::doWork');
    expect(callers.map((c) => c.qualifiedName).sort()).toEqual([
      'src/__tests__/lib.test.ts::checksDoWork',
      'src/main.ts::run',
    ]);
    const importers = queries.getImporters('src/lib.ts');
    expect(importers.sort()).toEqual([
      'src/__tests__/lib.test.ts',
      'src/main.ts',
    ]);
    const tests = queries.getTestsFor('src/lib.ts::doWork');
    expect(tests).toEqual(['src/__tests__/lib.test.ts']);
  });

  it('converges when source files change after scanning but before parsing', async () => {
    engine.close();
    const runtime = await CodeGraphParserRuntime.create();
    const originalGetGrammar = runtime.getGrammar.bind(runtime);
    let parsingStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      parsingStarted = resolve;
    });
    let resumeParsing: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      resumeParsing = resolve;
    });
    jest.spyOn(runtime, 'getGrammar').mockImplementationOnce(async (id) => {
      parsingStarted();
      await blocked;
      return originalGetGrammar(id);
    });
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
      parserRuntime: runtime,
    });

    const firstBuild = engine.buildOrUpdate();
    await started;
    for (const [relativePath, source, exportName] of [
      ['src/lib.ts', LIB, 'changedLibDuringBuild'],
      ['src/main.ts', MAIN, 'changedMainDuringBuild'],
      ['src/__tests__/lib.test.ts', TEST, 'changedTestDuringBuild'],
    ] as const) {
      writeFileSync(
        path.join(root, relativePath),
        `${source}\nexport function ${exportName}(): boolean { return true; }\n`,
      );
    }
    resumeParsing();
    await firstBuild;

    const reconciliation = await engine.buildOrUpdate();
    expect(reconciliation.filesParsed).toBe(1);
    const verificationDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const relativePath of [
        'src/lib.ts',
        'src/main.ts',
        'src/__tests__/lib.test.ts',
      ]) {
        const row = requireRow(
          verificationDb
            .prepare('SELECT content_hash FROM files WHERE relative_path = ?')
            .get(relativePath),
        );
        expect(requireString(row, 'content_hash')).toBe(
          createHash('sha256')
            .update(readFileSync(path.join(root, relativePath)))
            .digest('hex'),
        );
      }
    } finally {
      verificationDb.close();
    }
    runtime.dispose();
  });

  it('incremental update: unchanged files skip, edits reparse, deletions remove', async () => {
    await engine.buildOrUpdate();
    const second = await engine.buildOrUpdate();
    expect(second.filesParsed).toBe(0);
    expect(second.filesUnchanged).toBe(3);

    // Touch mtime without changing content: stat fastpath misses, hash catches it.
    const mainPath = path.join(root, 'src', 'main.ts');
    const later = new Date(Date.now() + 5_000);
    utimesSync(mainPath, later, later);
    const third = await engine.buildOrUpdate();
    expect(third.filesParsed).toBe(0);
    expect(third.filesUnchanged).toBe(3);

    // Real edit: only main.ts reparses.
    writeFileSync(
      mainPath,
      `${MAIN}\nexport function extra(): number { return doWork(); }\n`,
    );
    const fourth = await engine.buildOrUpdate();
    expect(fourth.filesParsed).toBe(1);
    const callers = engine.queries().getCallers('src/lib.ts::doWork');
    expect(callers.some((c) => c.qualifiedName === 'src/main.ts::extra')).toBe(
      true,
    );

    // Deletion: facts disappear, cross-file edges downgrade instead of pointing at ghosts.
    unlinkSync(path.join(root, 'src', 'lib.ts'));
    const fifth = await engine.buildOrUpdate();
    expect(fifth.filesRemoved).toBe(1);
    expect(engine.queries().getCallers('src/lib.ts::doWork')).toEqual([]);
    const status = engine.getStatus();
    expect(status.repositories[0].fileCount).toBe(2);
    expect(status.unresolvedEdgeCount).toBeGreaterThan(0); // downgraded, not dropped
  });

  it('skips oversized files without reading them and stays stable on rebuild', async () => {
    writeFileSync(
      path.join(root, 'src', 'huge.ts'),
      'x'.repeat(CODE_GRAPH_MAX_FILE_BYTES + 1),
    );
    const first = await engine.buildOrUpdate();
    expect(first.filesScanned).toBe(4);
    expect(first.filesParsed).toBe(3); // huge.ts is skipped, not parsed
    expect(first.filesSkipped).toBe(1);
    expect(first.filesParsed + first.filesUnchanged + first.filesSkipped).toBe(
      4,
    );
    const initialFtsState = semanticFtsState(dbPath);
    engine.close();

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const record = store.getFileByPath('fixture', 'src/huge.ts');
      expect(record?.parseStatus).toBe('skipped_too_large');
      expect(record?.contentHash).toBeNull();
      const symbols = store.listSymbolsForFile(
        fileRowId('fixture', 'src/huge.ts'),
      );
      expect(symbols).toHaveLength(1);
      expect(symbols[0].kind).toBe('file');
    } finally {
      db.close();
    }

    // Rebuild: the oversized file stat-matches, so it does not reparse.
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
    });
    const second = await engine.buildOrUpdate();
    expect(second.filesParsed).toBe(0);
    expect(second.filesUnchanged).toBe(4);
    expect(second.filesSkipped).toBe(0); // stat-matched, so counted as unchanged, not re-skipped
    expect(second.timings?.ftsMs).toBeUndefined();
    expect(semanticFtsState(dbPath)).toEqual(initialFtsState);

    // Explicit verification bypasses the stat shortcut, but an oversized file
    // still cannot be content-hashed. Re-observing the same skipped file size
    // must therefore remain a semantic no-op instead of rebuilding every
    // resolver, search index, and derived analysis on each explicit request.
    const verified = await engine.buildOrUpdate({ verifyContent: true });
    expect(verified.filesParsed).toBe(0);
    expect(verified.filesSkipped).toBe(1);
    expect(verified.factsChanged).toBe(false);
    expect(verified.timings?.ftsMs).toBeUndefined();
    expect(semanticFtsState(dbPath)).toEqual(initialFtsState);
  });

  it('records resolver-confirmed packages and bare Node built-ins as external diagnostics', async () => {
    const reactDir = path.join(root, 'node_modules', 'react');
    mkdirSync(reactDir, { recursive: true });
    writeFileSync(
      path.join(reactDir, 'package.json'),
      JSON.stringify({ name: 'react', version: '1.0.0', types: 'index.d.ts' }),
    );
    writeFileSync(
      path.join(reactDir, 'index.d.ts'),
      'export declare const createElement: () => void;\n',
    );
    writeFileSync(
      path.join(root, 'src', 'external.ts'),
      [
        "import { createElement } from 'react';",
        "import { readFile } from 'fs';",
        'void createElement;',
        'void readFile;',
        '',
      ].join('\n'),
    );

    await engine.buildOrUpdate();

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const imports = store.listEdges({
        kind: 'IMPORTS_FROM',
        repoId: 'fixture',
        sourceFileId: fileRowId('fixture', 'src/external.ts'),
      });
      expect(
        imports.find((edge) => edge.targetRef === 'react')?.evidence.external,
      ).toBe(true);
      expect(
        imports.find((edge) => edge.targetRef === 'fs')?.evidence.external,
      ).toBe(true);
    } finally {
      db.close();
    }

    const importDiagnostics =
      engine
        .getStatus()
        .diagnostics?.repositories[0].edges.filter(
          (entry) => entry.kind === 'IMPORTS_FROM',
        ) ?? [];
    expect(
      importDiagnostics
        .filter((entry) => entry.reason === 'external')
        .reduce((sum, entry) => sum + entry.count, 0),
    ).toBe(2);
  });

  it('recovers from a parse degradation: a syntax hole raises filesWithErrors, fixing the file clears it', async () => {
    const brokenPath = path.join(root, 'src', 'broken.ts');
    writeFileSync(brokenPath, 'function broken( {\n');

    const first = await engine.buildOrUpdate();
    expect(first.filesParsed).toBe(4); // 3 fixture files + broken.ts
    expect(engine.getStatus().filesWithErrors).toBeGreaterThanOrEqual(1);

    writeFileSync(
      brokenPath,
      'export function broken(): number {\n  return 1;\n}\n',
    );
    const second = await engine.buildOrUpdate();
    expect(second.filesParsed).toBe(1); // only broken.ts changed
    expect(engine.getStatus().filesWithErrors).toBe(0);
    const summary = engine.queries().getFileSummary('src/broken.ts');
    expect(summary?.symbols.map((s) => s.qualifiedName)).toContain(
      'src/broken.ts::broken',
    );
  });

  it('force-reparses the full corpus when extractor_version metadata is stale', async () => {
    const first = await engine.buildOrUpdate();
    expect(first.filesParsed).toBe(3);
    expect(first.filesUnchanged).toBe(0);
    engine.close();

    const db = openCodeGraphDatabase(dbPath);
    try {
      setMetadataValue(db, 'extractor_version', '0');
    } finally {
      db.close();
    }

    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
    });
    const second = await engine.buildOrUpdate();
    // Stat fastpath bypassed: every file reparses even though nothing changed.
    expect(second.filesParsed).toBe(3);
    expect(second.filesUnchanged).toBe(0);
  });

  it('routes .tsx files through the pipeline and extracts their symbols', async () => {
    writeFileSync(
      path.join(root, 'src', 'widget.tsx'),
      `export function Widget(): JSX.Element {\n  return <div className="x">hi</div>;\n}\n`,
    );
    await engine.buildOrUpdate();
    const summary = engine.queries().getFileSummary('src/widget.tsx');
    expect(summary?.symbols.map((s) => s.qualifiedName)).toContain(
      'src/widget.tsx::Widget',
    );
  });

  it('routes a markdown file through the non-code extraction pipeline and resolves its doc links (Task 4: real markdown extraction + doc-link resolver)', async () => {
    writeFileSync(
      path.join(root, 'docs.md'),
      '# Title\n\nSome docs content linking to [lib](./src/lib.ts) and [missing](./nope.md).\n',
    );
    const result = await engine.buildOrUpdate();
    expect(result.filesScanned).toBe(4); // 3 fixture files + docs.md
    expect(result.filesParsed).toBe(4);
    expect(result.parseFailures).toBe(0);

    const summary = engine.queries().getFileSummary('docs.md');
    expect(summary?.symbols.map((s) => s.qualifiedName)).toEqual([
      'docs.md::title',
    ]);

    // A second read connection (WAL), same pattern as the oversized-file
    // assertions above: inspect raw file/symbol rows and DOCUMENTS edges the
    // query layer doesn't surface yet (getDocsFor lands in a later task).
    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const record = store.getFileByPath('fixture', 'docs.md');
      expect(record?.language).toBe('markdown');
      expect(record?.grammarId).toBe('markdown');
      expect(record?.grammarAbi).toBeNull();
      expect(record?.parseStatus).toBe('parsed');
      const symbols = store.listSymbolsForFile(fileRowId('fixture', 'docs.md'));
      expect(symbols).toHaveLength(2); // file symbol + the "Title" doc_section

      const docEdges = store.listEdges({
        kind: 'DOCUMENTS',
        repoId: 'fixture',
      });
      expect(docEdges).toHaveLength(2);
      const resolved = docEdges.find(
        (edge) => edge.targetRef === './src/lib.ts',
      );
      expect(resolved?.targetSymbolId).toBe(
        symbolRowId('fixture', fileQualifiedName('src/lib.ts')),
      );
      expect(resolved?.confidenceTier).toBe('RESOLVED');
      expect(resolved?.resolverId).toBe('doc-link');
      const unresolved = docEdges.find(
        (edge) => edge.targetRef === './nope.md',
      );
      expect(unresolved?.targetSymbolId).toBeNull();
      expect(unresolved?.confidenceTier).toBe('EXTRACTED');
    } finally {
      db.close();
    }
  });

  it('records a failed parse for a manifest file with invalid JSON and keeps the build going (Task 5: manifest extractor throw -> engine failed-file path)', async () => {
    writeFileSync(
      path.join(root, 'package.json'),
      '{ "name": "broken", invalid json here',
    );
    const result = await engine.buildOrUpdate();
    expect(result.filesScanned).toBe(4); // 3 fixture files + package.json
    expect(result.filesParsed).toBe(4);
    expect(result.parseFailures).toBe(1);

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const record = store.getFileByPath('fixture', 'package.json');
      expect(record?.language).toBe('package-json');
      expect(record?.parseStatus).toBe('failed');
      expect(record?.hasErrors).toBe(true);
      expect(record?.contentHash).not.toBeNull(); // file was read before the extractor threw
      const symbols = store.listSymbolsForFile(
        fileRowId('fixture', 'package.json'),
      );
      expect(symbols).toHaveLength(1); // file symbol only; no scripts/deps recorded
      expect(symbols[0].kind).toBe('file');
    } finally {
      db.close();
    }

    const firstFailedFtsState = semanticFtsState(dbPath);

    // The build stays stable: a subsequent build without fixing the file
    // still succeeds and does not throw out of `buildOrUpdate`. The failed
    // file's content is unchanged, so the stat/hash fastpath treats it like
    // any other unchanged file (no re-parse attempt) rather than retrying
    // the same doomed extraction on every build — the persisted failure from
    // the first build is what `getStatus().filesWithErrors` still reflects.
    const second = await engine.buildOrUpdate();
    expect(second.filesUnchanged).toBe(4);
    expect(second.parseFailures).toBe(0);
    expect(second.timings?.ftsMs).toBeUndefined();
    expect(semanticFtsState(dbPath)).toEqual(firstFailedFtsState);
    expect(engine.getStatus().filesWithErrors).toBeGreaterThanOrEqual(1);
    const verified = await engine.buildOrUpdate({ verifyContent: true });
    expect(verified.filesParsed).toBe(1);
    expect(verified.parseFailures).toBe(1);
    expect(semanticFtsState(dbPath)).toEqual(firstFailedFtsState);
    expect(engine.getStatus().diagnostics?.freshness).toBe('content');
    const recovered = await engine.buildOrUpdate({ forceReparse: true });
    expect(recovered.filesParsed).toBe(4);
    expect(engine.getStatus().diagnostics?.freshness).toBe('reparsed');
  });

  it('routes a .github/workflows/*.yml file through the non-code extraction pipeline (Task 4: real GitHub workflow extraction)', async () => {
    mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      path.join(root, '.github', 'workflows', 'ci.yml'),
      [
        'name: CI',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '',
      ].join('\n'),
    );
    const result = await engine.buildOrUpdate();
    expect(result.filesScanned).toBe(4); // 3 fixture files + the workflow
    expect(result.filesParsed).toBe(4);
    expect(result.parseFailures).toBe(0);

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const record = store.getFileByPath('fixture', '.github/workflows/ci.yml');
      expect(record?.language).toBe('github-workflow');
      expect(record?.grammarId).toBe('github-workflow');
      expect(record?.grammarAbi).toBeNull();
      expect(record?.parseStatus).toBe('parsed');

      const symbols = store.listSymbolsForFile(
        fileRowId('fixture', '.github/workflows/ci.yml'),
      );
      // file symbol + workflow symbol + 1 workflow_job symbol
      expect(symbols).toHaveLength(3);
      expect(symbols.map((s) => s.kind).sort()).toEqual(
        ['file', 'workflow', 'workflow_job'].sort(),
      );

      const workflowFileId = fileRowId('fixture', '.github/workflows/ci.yml');
      const containsEdges = store.listEdges({
        kind: 'CONTAINS',
        repoId: 'fixture',
        sourceFileId: workflowFileId,
      });
      // file->workflow and workflow->build, scoped to this file (the other
      // TS fixtures in this corpus also emit their own CONTAINS edges, which
      // is why this is filtered by sourceFileId rather than asserted as the
      // graph-wide total).
      expect(containsEdges).toHaveLength(2);

      const usesEdges = store.listEdges({
        kind: 'USES_PIPELINE_ACTION',
        repoId: 'fixture',
      });
      expect(usesEdges).toHaveLength(1);
      expect(usesEdges[0].targetRef).toBe('actions/checkout@v4');
      expect(usesEdges[0].targetSymbolId).toBeNull(); // external ref: unresolved forever
    } finally {
      db.close();
    }
  });

  it('closes the database handle when open fails after creating it', async () => {
    const closeSpy = jest.spyOn(DatabaseSync.prototype, 'close');
    closeSpy.mockClear();
    const resourcesDir = mkdtempSync(
      path.join(tmpdir(), 'code-graph-engine-other-resources-'),
    );
    try {
      await expect(
        CodeGraphEngine.open({
          dbPath: path.join(root, '.graph', 'failed-open.db'),
          repositories: [{ repoId: 'fixture', rootPath: root }],
          resourcesDir,
        }),
      ).rejects.toThrow(/already initialized with resourcesDir/);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
      rmSync(resourcesDir, { recursive: true, force: true });
    }
  });

  it('records a failed parse for a GitHub workflow file with invalid YAML and keeps the build going (workflow extractor throw -> engine failed-file path)', async () => {
    mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      path.join(root, '.github', 'workflows', 'broken.yml'),
      'name: [unterminated\n',
    );
    const result = await engine.buildOrUpdate();
    expect(result.filesScanned).toBe(4); // 3 fixture files + broken.yml
    expect(result.filesParsed).toBe(4);
    expect(result.parseFailures).toBe(1);

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const record = store.getFileByPath(
        'fixture',
        '.github/workflows/broken.yml',
      );
      expect(record?.language).toBe('github-workflow');
      expect(record?.parseStatus).toBe('failed');
      expect(record?.hasErrors).toBe(true);
      expect(record?.contentHash).not.toBeNull(); // file was read before the extractor threw
      const symbols = store.listSymbolsForFile(
        fileRowId('fixture', '.github/workflows/broken.yml'),
      );
      expect(symbols).toHaveLength(1); // file symbol only
      expect(symbols[0].kind).toBe('file');
    } finally {
      db.close();
    }

    const second = await engine.buildOrUpdate();
    expect(second.filesUnchanged).toBe(4);
    expect(second.parseFailures).toBe(0);
    expect(engine.getStatus().filesWithErrors).toBeGreaterThanOrEqual(1);
  });

  // --- Phase 6 Task 6: derived-phase integration ----------------------------

  it('computes and persists derived communities + flows during a full build, and reports them in status', async () => {
    const result = await engine.buildOrUpdate();

    expect(result.derived).toHaveLength(1);
    const [repoStats] = result.derived;
    expect(repoStats.repoId).toBe('fixture');
    expect(repoStats.computed).toBe(true);
    expect(repoStats.communitiesSkipped).toBe(false);
    expect(repoStats.flowsGlobalCapReached).toBe(false);
    expect(repoStats.warnings).toEqual([]);
    expect(repoStats.communityCount).toBeGreaterThan(0);
    // `run` calls `doWork` and nothing calls `run` -- a call-graph-root flow
    // entry point (see analysis/flows.ts), so this fixture always yields at
    // least one flow.
    expect(repoStats.flowCount).toBeGreaterThan(0);

    const status = engine.getStatus();
    expect(status.communityCount).toBe(repoStats.communityCount);
    expect(status.flowCount).toBe(repoStats.flowCount);
    expect(status.derivedAt).not.toBeNull();

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      expect(store.listFlows('fixture').length).toBe(repoStats.flowCount);
      expect(store.listCommunities('fixture').length).toBe(
        repoStats.communityCount,
      );
    } finally {
      db.close();
    }
  });

  it('skips derived computation when computeDerived is false, and never writes community/flow rows', async () => {
    const result = await engine.buildOrUpdate({ computeDerived: false });

    expect(result.derived).toEqual([]);
    const status = engine.getStatus();
    expect(status.communityCount).toBe(0);
    expect(status.flowCount).toBe(0);
    expect(status.derivedAt).toBeNull();
  });

  it('recomputes derived data on an unchanged build when its freshness marker is missing', async () => {
    const first = await engine.buildOrUpdate();
    expect(first.derived[0]?.computed).toBe(true);

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      store.replaceDerivedForRepo('fixture', [], [], [], []);
      deleteMetadataValue(db, 'derived_at');
    } finally {
      db.close();
    }

    const repaired = await engine.buildOrUpdate();
    expect(repaired.factsChanged).toBe(false);
    expect(repaired.derived[0]?.computed).toBe(true);
    expect(repaired.derived[0]?.communityCount).toBeGreaterThan(0);
    expect(repaired.derived[0]?.flowCount).toBeGreaterThan(0);
    expect(engine.getStatus().derivedAt).not.toBeNull();
  });

  it('invalidates derived freshness when changed facts are built without derived analysis', async () => {
    await engine.buildOrUpdate();
    expect(engine.getStatus().derivedAt).not.toBeNull();

    writeFileSync(
      path.join(root, 'src', 'main.ts'),
      `${MAIN}\nexport function changedWithoutDerived(): number { return 7; }\n`,
    );
    const withoutDerived = await engine.buildOrUpdate({
      computeDerived: false,
    });
    expect(withoutDerived.factsChanged).toBe(true);
    expect(withoutDerived.derived).toEqual([]);
    expect(engine.getStatus().derivedAt).toBeNull();

    const repaired = await engine.buildOrUpdate();
    expect(repaired.factsChanged).toBe(false);
    expect(repaired.derived[0]?.computed).toBe(true);
    expect(engine.getStatus().derivedAt).not.toBeNull();
  });

  it('still succeeds the build when derived analysis throws even in its error-reporting path (engine-level defensive catch)', async () => {
    // Double failure: `listSymbolsForRepo` throwing sends
    // `computeDerivedForRepo` into its own catch, whose error-REPORTING path
    // reads `getDerivedStats` -- which then throws TOO, so the rejection
    // escapes `computeDerivedForRepo` entirely and only the engine's
    // per-repo defensive catch stands between it and a failed build.
    // Prototype spies (same technique as before-graph.test.ts's
    // `CodeGraphEngine.prototype.buildOrUpdate` spy) are the only way to
    // reach this path: the orchestrator's injectable seam is not exposed
    // through `engine.buildOrUpdate`, by design.
    const listSpy = jest
      .spyOn(CodeGraphStore.prototype, 'listSymbolsForRepo')
      .mockImplementation(() => {
        throw new Error('boom: symbol load failed');
      });
    const statsSpy = jest
      .spyOn(CodeGraphStore.prototype, 'getDerivedStats')
      .mockImplementation(() => {
        throw new Error('boom: stats read failed');
      });
    try {
      const result = await engine.buildOrUpdate();

      // The build itself completed normally...
      expect(result.filesParsed).toBe(3);
      expect(result.parseFailures).toBe(0);
      // ...and the double failure surfaced as an honest warning entry. The
      // message carries the SECOND error (the stats read), proving this went
      // through the orchestrator's catch and out to the engine's guard.
      expect(result.derived).toHaveLength(1);
      const [repoStats] = result.derived;
      expect(repoStats.repoId).toBe('fixture');
      expect(repoStats.computed).toBe(false);
      expect(repoStats.communityCount).toBe(0);
      expect(repoStats.flowCount).toBe(0);
      expect(repoStats.warnings).toHaveLength(1);
      expect(repoStats.warnings[0]).toContain('boom: stats read failed');
    } finally {
      listSpy.mockRestore();
      statsSpy.mockRestore();
    }

    // No repo computed, so freshness must not have been stamped.
    expect(engine.getStatus().derivedAt).toBeNull();
  });

  it('is deterministic across rebuilds: an unchanged repo produces identical community/flow ids on a second build', async () => {
    const first = await engine.buildOrUpdate();
    const [firstStats] = first.derived;
    expect(firstStats.computed).toBe(true);

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    let firstCommunityIds: string[];
    let firstFlowIds: string[];
    try {
      firstCommunityIds = store
        .listCommunities('fixture')
        .map((c) => c.id)
        .sort();
      firstFlowIds = store
        .listFlows('fixture')
        .map((f) => f.id)
        .sort();
    } finally {
      db.close();
    }

    // Second build: no file content changed, so the zero-mutation path reuses
    // the existing derived rows. Their stable IDs and counts must remain
    // byte-for-byte identical without claiming another computation.
    const second = await engine.buildOrUpdate();
    const [secondStats] = second.derived;
    // An unchanged rebuild reuses the persisted rows without claiming a new
    // derived computation.
    expect(secondStats.computed).toBe(false);
    expect(secondStats.communityCount).toBe(firstStats.communityCount);
    expect(secondStats.flowCount).toBe(firstStats.flowCount);

    const db2 = openCodeGraphDatabase(dbPath);
    const store2 = new CodeGraphStore(db2);
    try {
      expect(
        store2
          .listCommunities('fixture')
          .map((c) => c.id)
          .sort(),
      ).toEqual(firstCommunityIds);
      expect(
        store2
          .listFlows('fixture')
          .map((f) => f.id)
          .sort(),
      ).toEqual(firstFlowIds);
    } finally {
      db2.close();
    }
  });
});
