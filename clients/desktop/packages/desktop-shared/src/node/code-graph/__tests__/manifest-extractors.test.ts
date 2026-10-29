import { nonCodeExtractorForPath } from '../extract/extractor-registry';
import {
  extractMcpConfigFacts,
  extractPackageJsonFacts,
  extractTsconfigFacts,
} from '../extract/manifest-extractors';
import type { NonCodeExtractorInput } from '../extract/extractor-registry';
import { CodeGraphParserRuntime } from '../parser/runtime';
import { symbolQualifiedName } from '../ids';
import type {
  CodeGraphEdgeRecord,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';

const REPO = 'fixture';

describe('manifest extractors', () => {
  let runtime: CodeGraphParserRuntime;

  beforeAll(async () => {
    // None of these extractors touch web-tree-sitter, but `runtime` is a
    // required field on `NonCodeExtractorInput` (the markdown extractor
    // needs it), so a real instance is threaded through anyway.
    runtime = await CodeGraphParserRuntime.create();
  });

  afterAll(() => {
    runtime.dispose();
  });

  function input(relativePath: string, source: string): NonCodeExtractorInput {
    return {
      repoId: REPO,
      relativePath,
      absolutePath: `/repo/${relativePath}`,
      source,
      sizeBytes: Buffer.byteLength(source, 'utf8'),
      mtimeNs: '1',
      contentHash: 'hash',
      runtime,
    };
  }

  function bySymbolName(
    symbols: readonly CodeGraphSymbolRecord[],
    name: string,
  ): CodeGraphSymbolRecord | undefined {
    return symbols.find((symbol) => symbol.name === name);
  }

  function edgesOfKind(
    edges: readonly CodeGraphEdgeRecord[],
    kind: CodeGraphEdgeRecord['kind'],
  ): CodeGraphEdgeRecord[] {
    return edges.filter((edge) => edge.kind === kind);
  }

  it('rejects unterminated schema strings/comments rather than inventing declarations', () => {
    const extractor = nonCodeExtractorForPath('schema.prisma');
    if (extractor === undefined) throw new Error('Prisma extractor missing');
    for (const source of [
      '/* unclosed\nmodel Fake {}',
      'generator client {\n provider = "unclosed\nmodel Fake {}',
    ]) {
      expect(() => extractor.extract(input('schema.prisma', source))).toThrow();
    }
  });

  it('extracts Prisma declarations and only proven local type references', async () => {
    const source =
      '// model Fake { }\nmodel User {\n id String @id\n posts Post[]\n role Role\n}\nmodel Post {\n author User?\n missing Absent\n}\nenum Role {\n ADMIN\n USER\n}\ndatasource db {\n url = "SECRET"\n provider = "postgresql"\n}';
    const extractor = nonCodeExtractorForPath('schema.prisma');
    expect(extractor).toBeDefined();
    if (extractor === undefined) throw new Error('Prisma extractor missing');
    const facts = await extractor.extract(input('schema.prisma', source));
    expect(facts.symbols.map((symbol) => symbol.qualifiedName)).toEqual(
      expect.arrayContaining([
        'schema.prisma::User',
        'schema.prisma::User.posts',
        'schema.prisma::Role.ADMIN',
      ]),
    );
    expect(facts.symbols.some((symbol) => symbol.name === 'Fake')).toBe(false);
    const refs = facts.edges.filter((edge) => edge.kind === 'REFERENCES');
    expect(refs.filter((edge) => edge.targetSymbolId !== null)).toHaveLength(3);
    expect(
      refs.find((edge) => edge.targetRef === 'Absent')?.targetSymbolId,
    ).toBeNull();
    expect(JSON.stringify(facts)).not.toContain('SECRET');
  });

  it('counts every omitted Prisma declaration and member after the symbol cap', async () => {
    const retainedFields = Array.from(
      { length: 4998 },
      (_, index) => ` field${index} String`,
    ).join('\n');
    const source = `model Retained {\n${retainedFields}\n}\nmodel Omitted {\n first String\n second String\n}\n`;
    const extractor = nonCodeExtractorForPath('schema.prisma');
    if (extractor === undefined) throw new Error('Prisma extractor missing');

    const facts = await extractor.extract(input('schema.prisma', source));
    const fileSymbol = facts.symbols.find((symbol) => symbol.kind === 'file');

    expect(facts.symbols).toHaveLength(5000);
    expect(fileSymbol?.extra.truncatedFacts).toBe(3);
  });

  describe('package.json', () => {
    const RELATIVE_PATH = 'package.json';
    const SOURCE = [
      '{',
      '  "name": "demo",',
      '  "version": "1.0.0",',
      '  "scripts": {',
      '    "build": "tsc -p .",',
      '    "test": "jest"',
      '  },',
      '  "dependencies": {',
      '    "lodash": "^4.17.21"',
      '  },',
      '  "devDependencies": {',
      '    "typescript": "^5.7.0"',
      '  },',
      '  "peerDependencies": {',
      '    "react": "^19.0.0"',
      '  },',
      '  "optionalDependencies": {',
      '    "fsevents": "^2.3.3"',
      '  }',
      '}',
      '',
    ].join('\n');

    it('extracts script symbols with DECLARES_SCRIPT edges and approximate line numbers', () => {
      const facts = extractPackageJsonFacts(input(RELATIVE_PATH, SOURCE));
      expect(facts.file.language).toBe('package-json');
      expect(facts.file.grammarId).toBe('package-json');
      expect(facts.file.parseStatus).toBe('parsed');

      const fileSymbol = facts.symbols.find((symbol) => symbol.kind === 'file');
      expect(fileSymbol).toBeDefined();

      const build = bySymbolName(facts.symbols, 'build');
      expect(build?.kind).toBe('script');
      expect(build?.qualifiedName).toBe(
        symbolQualifiedName(RELATIVE_PATH, ['scripts'], 'build'),
      );
      expect(build?.signature).toBe('tsc -p .');
      expect(build?.parentSymbolId).toBeNull();
      expect(build?.lineStart).toBe(5);

      const test = bySymbolName(facts.symbols, 'test');
      expect(test?.lineStart).toBe(6);

      const declaresScript = edgesOfKind(facts.edges, 'DECLARES_SCRIPT');
      expect(declaresScript).toHaveLength(2);
      const buildEdge = declaresScript.find(
        (edge) => edge.targetSymbolId === build?.id,
      );
      expect(buildEdge?.sourceSymbolId).toBe(fileSymbol?.id);
      expect(buildEdge?.confidenceTier).toBe('EXTRACTED');
      expect(buildEdge?.confidenceScore).toBe(1.0);
    });

    it('extracts each dependency group with group/range extras, DECLARES_DEPENDENCY edges, and approximate line numbers', () => {
      const facts = extractPackageJsonFacts(input(RELATIVE_PATH, SOURCE));
      const fileSymbol = facts.symbols.find((symbol) => symbol.kind === 'file');

      const cases: Array<{
        name: string;
        group: string;
        range: string;
        line: number;
      }> = [
        { name: 'lodash', group: 'dependencies', range: '^4.17.21', line: 9 },
        {
          name: 'typescript',
          group: 'devDependencies',
          range: '^5.7.0',
          line: 12,
        },
        {
          name: 'react',
          group: 'peerDependencies',
          range: '^19.0.0',
          line: 15,
        },
        {
          name: 'fsevents',
          group: 'optionalDependencies',
          range: '^2.3.3',
          line: 18,
        },
      ];

      for (const testCase of cases) {
        const symbol = bySymbolName(facts.symbols, testCase.name);
        expect(symbol?.kind).toBe('dependency');
        expect(symbol?.qualifiedName).toBe(
          symbolQualifiedName(RELATIVE_PATH, ['deps'], testCase.name),
        );
        expect(symbol?.extra).toEqual({
          groups: [{ group: testCase.group, range: testCase.range }],
        });
        expect(symbol?.lineStart).toBe(testCase.line);
        expect(symbol?.parentSymbolId).toBeNull();
      }

      const declaresDependency = edgesOfKind(
        facts.edges,
        'DECLARES_DEPENDENCY',
      );
      expect(declaresDependency).toHaveLength(4);
      for (const edge of declaresDependency) {
        expect(edge.sourceSymbolId).toBe(fileSymbol?.id);
        expect(edge.confidenceTier).toBe('EXTRACTED');
      }
      expect(
        declaresDependency.map((edge) => edge.evidence.group).sort(),
      ).toEqual([
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ]);
    });

    it('merges a package listed in multiple dependency groups into ONE symbol with per-group edges (no INSERT OR REPLACE metadata loss)', () => {
      // JSON.stringify keeps the whole fixture on one line, so BOTH group
      // occurrences resolve to approximate line 1 — this deliberately
      // exercises the edge-id discriminator: without it the two edges would
      // hash to the same id and one would be silently dropped.
      const source = JSON.stringify({
        dependencies: { 'same-dep': '^1.0.0' },
        devDependencies: { 'same-dep': '^2.0.0' },
      });
      const facts = extractPackageJsonFacts(input(RELATIVE_PATH, source));

      const dependencySymbols = facts.symbols.filter(
        (symbol) => symbol.kind === 'dependency',
      );
      expect(dependencySymbols).toHaveLength(1);
      const symbol = dependencySymbols[0];
      expect(symbol.qualifiedName).toBe(
        symbolQualifiedName(RELATIVE_PATH, ['deps'], 'same-dep'),
      );
      // Every group occurrence survives, in DEPENDENCY_GROUPS order.
      expect(symbol.extra).toEqual({
        groups: [
          { group: 'dependencies', range: '^1.0.0' },
          { group: 'devDependencies', range: '^2.0.0' },
        ],
      });

      const declaresDependency = edgesOfKind(
        facts.edges,
        'DECLARES_DEPENDENCY',
      );
      expect(declaresDependency).toHaveLength(2);
      expect(
        declaresDependency.every((edge) => edge.targetSymbolId === symbol.id),
      ).toBe(true);
      expect(new Set(declaresDependency.map((edge) => edge.id)).size).toBe(2);
      expect(
        declaresDependency.map((edge) => edge.evidence.group).sort(),
      ).toEqual(['dependencies', 'devDependencies']);
    });

    it('caps combined script+dependency extraction at 500 and records truncatedFacts on the file symbol', () => {
      const scriptEntries = Array.from(
        { length: 600 },
        (_, i) => `    "script${i}": "echo ${i}"`,
      ).join(',\n');
      const source = `{\n  "scripts": {\n${scriptEntries}\n  }\n}\n`;

      const facts = extractPackageJsonFacts(input(RELATIVE_PATH, source));
      const fileSymbol = facts.symbols.find((symbol) => symbol.kind === 'file');
      expect(facts.symbols).toHaveLength(1 + 500);
      expect(facts.edges).toHaveLength(500);
      expect(fileSymbol?.extra.truncatedFacts).toBe(100);
    });

    it('throws on invalid JSON', () => {
      expect(() =>
        extractPackageJsonFacts(input(RELATIVE_PATH, '{ not valid json')),
      ).toThrow();
    });

    it('treats a non-object top-level JSON value as an empty manifest instead of throwing', () => {
      const facts = extractPackageJsonFacts(input(RELATIVE_PATH, '[]\n'));
      expect(facts.symbols).toHaveLength(1);
      expect(facts.edges).toEqual([]);
    });

    it('skips non-string script/dependency values instead of crashing', () => {
      const source = JSON.stringify({
        scripts: { build: 123 },
        dependencies: { lodash: ['not', 'a', 'string'] },
      });
      const facts = extractPackageJsonFacts(input(RELATIVE_PATH, source));
      expect(facts.symbols).toHaveLength(1); // only the file symbol
      expect(facts.edges).toEqual([]);
    });

    it('rejects array-shaped scripts/dependency blocks (isRecord alone passes arrays; numeric indices must not become entry names)', () => {
      const source = JSON.stringify({
        scripts: ['echo hi'],
        dependencies: ['lodash'],
      });
      const facts = extractPackageJsonFacts(input(RELATIVE_PATH, source));
      expect(facts.symbols).toHaveLength(1); // only the file symbol
      expect(facts.edges).toEqual([]);
    });

    it('marks the file symbol as a test file when the manifest lives under __tests__/ (fixture package.json)', () => {
      const facts = extractPackageJsonFacts(
        input('src/__tests__/fixtures/package.json', '{}\n'),
      );
      const fileSymbol = facts.symbols.find((symbol) => symbol.kind === 'file');
      expect(fileSymbol?.isTest).toBe(true);
    });
  });

  describe('tsconfig.json', () => {
    const RELATIVE_PATH = 'tsconfig.json';

    it('emits a config symbol + CONFIGURES edge, records paths alias keys and reference paths, and emits an unresolved REFERENCES edge for a relative extends', () => {
      const source = JSON.stringify({
        extends: './base.tsconfig.json',
        compilerOptions: {
          paths: {
            '@app/*': ['src/app/*'],
            '@lib/*': ['src/lib/*'],
          },
        },
        references: [{ path: '../shared' }, { path: '../other' }],
      });

      const facts = extractTsconfigFacts(input(RELATIVE_PATH, source));
      expect(facts.file.language).toBe('tsconfig');
      expect(facts.symbols).toHaveLength(2);

      const fileSymbol = facts.symbols.find((symbol) => symbol.kind === 'file');
      const configSymbol = facts.symbols.find(
        (symbol) => symbol.kind === 'config',
      );
      expect(configSymbol?.qualifiedName).toBe(
        symbolQualifiedName(RELATIVE_PATH, [], 'config'),
      );
      expect(configSymbol?.name).toBe('tsconfig.json');
      expect(configSymbol?.parentSymbolId).toBeNull();
      expect(configSymbol?.extra.pathsAliases).toEqual(['@app/*', '@lib/*']);
      expect(configSymbol?.extra.references).toEqual(['../shared', '../other']);

      const configuresEdges = edgesOfKind(facts.edges, 'CONFIGURES');
      expect(configuresEdges).toHaveLength(1);
      expect(configuresEdges[0].sourceSymbolId).toBe(fileSymbol?.id);
      expect(configuresEdges[0].targetSymbolId).toBe(configSymbol?.id);

      const referencesEdges = edgesOfKind(facts.edges, 'REFERENCES');
      expect(referencesEdges).toHaveLength(1);
      expect(referencesEdges[0].sourceSymbolId).toBe(configSymbol?.id);
      expect(referencesEdges[0].targetSymbolId).toBeNull(); // unresolved: Phase 5
      expect(referencesEdges[0].targetRef).toBe('./base.tsconfig.json');
      expect(referencesEdges[0].confidenceTier).toBe('EXTRACTED');
    });

    it('does not emit a REFERENCES edge for a non-relative (package-style) extends', () => {
      const source = JSON.stringify({
        extends: '@tsconfig/node18/tsconfig.json',
      });
      const facts = extractTsconfigFacts(input(RELATIVE_PATH, source));
      expect(edgesOfKind(facts.edges, 'REFERENCES')).toEqual([]);
      expect(edgesOfKind(facts.edges, 'CONFIGURES')).toHaveLength(1);
    });

    it('emits only the CONFIGURES edge when there is no extends, paths, or references', () => {
      const facts = extractTsconfigFacts(input(RELATIVE_PATH, '{}\n'));
      expect(facts.symbols).toHaveLength(2);
      expect(facts.edges).toHaveLength(1);
      expect(facts.edges[0].kind).toBe('CONFIGURES');
      const configSymbol = facts.symbols.find(
        (symbol) => symbol.kind === 'config',
      );
      expect(configSymbol?.extra).toEqual({});
    });

    it('throws on invalid JSON', () => {
      expect(() =>
        extractTsconfigFacts(input(RELATIVE_PATH, '{ not valid json')),
      ).toThrow();
    });
  });

  describe('.mcp.json', () => {
    const RELATIVE_PATH = '.mcp.json';
    const SECRET_VALUE = 'sk-super-secret-value-12345';
    const SOURCE = JSON.stringify({
      mcpServers: {
        linear: {
          command: 'npx',
          args: ['-y', '@some/mcp-linear'],
          env: {
            LINEAR_API_KEY: SECRET_VALUE,
          },
        },
        'remote-server': {
          url: 'https://example.com/mcp',
        },
      },
    });

    it('emits a config symbol per server with command + envNames extras and a CONFIGURES edge', () => {
      const facts = extractMcpConfigFacts(input(RELATIVE_PATH, SOURCE));
      expect(facts.file.language).toBe('mcp-config');
      expect(facts.symbols).toHaveLength(3); // file + 2 servers

      const fileSymbol = facts.symbols.find((symbol) => symbol.kind === 'file');
      const linear = bySymbolName(facts.symbols, 'linear');
      expect(linear?.kind).toBe('config');
      expect(linear?.qualifiedName).toBe(
        symbolQualifiedName(RELATIVE_PATH, ['servers'], 'linear'),
      );
      expect(linear?.extra.command).toBe('npx');
      expect(linear?.extra.envNames).toEqual(['LINEAR_API_KEY']);
      expect(linear?.parentSymbolId).toBeNull();

      const remote = bySymbolName(facts.symbols, 'remote-server');
      expect(remote?.extra.command).toBeUndefined();
      expect(remote?.extra.envNames).toEqual([]);

      const configuresEdges = edgesOfKind(facts.edges, 'CONFIGURES');
      expect(configuresEdges).toHaveLength(2);
      expect(
        configuresEdges.every((edge) => edge.sourceSymbolId === fileSymbol?.id),
      ).toBe(true);
    });

    it('NEVER stores env var values anywhere in the extracted facts (names only)', () => {
      const facts = extractMcpConfigFacts(input(RELATIVE_PATH, SOURCE));
      const serialized = JSON.stringify(facts);
      expect(serialized).not.toContain(SECRET_VALUE);
    });

    it('throws on invalid JSON', () => {
      expect(() =>
        extractMcpConfigFacts(input(RELATIVE_PATH, '{ not valid json')),
      ).toThrow();
    });
  });
});
