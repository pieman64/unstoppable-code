import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CodeGraphParserRuntime } from '../parser/runtime';
import { extractFileFacts } from '../extract/tags-extractor';
import {
  extractRationale,
  isRationaleExcludedPath,
  RATIONALE_MAX_PER_FILE,
  type ExtractRationaleResult,
} from '../extract/rationale';
import { CodeGraphEngine } from '../engine';
import { openCodeGraphDatabase } from '../store/database';
import { CodeGraphStore } from '../store/graph-store';
import { fileQualifiedName, fileRowId, symbolRowId } from '../ids';

const REPO = 'fixture';

// Drives extractRationale through the SAME plumbing engine.ts uses in
// production: extractFileFacts's `onTree` hook, which hands over both the
// live tree and the in-progress definitions list synchronously (the tree is
// deleted once extractFileFacts returns, so extractRationale must run inside
// this callback -- see the ExtractFileInput.onTree comment in
// tags-extractor.ts).
async function extractRationaleFromSource(
  runtime: CodeGraphParserRuntime,
  source: string,
  relativePath: string,
  isTestFile: boolean = false,
): Promise<ExtractRationaleResult> {
  const grammar = await runtime.getGrammar('typescript');
  const fileId = fileRowId(REPO, relativePath);
  const fileSymbolId = symbolRowId(REPO, fileQualifiedName(relativePath));
  let captured: ExtractRationaleResult | null = null;
  extractFileFacts({
    grammar,
    runtime,
    repoId: REPO,
    relativePath,
    absolutePath: `/repo/${relativePath}`,
    source,
    sizeBytes: Buffer.byteLength(source, 'utf8'),
    mtimeNs: '1',
    contentHash: 'h',
    isTestFile,
    onTree: (tree, definitions) => {
      captured = extractRationale({
        tree,
        source,
        repoId: REPO,
        relativePath,
        fileId,
        fileSymbolId,
        definitions,
      });
    },
  });
  if (captured === null) {
    throw new Error('onTree callback did not run; parse must have failed');
  }
  return captured;
}

describe('extractRationale', () => {
  let runtime: CodeGraphParserRuntime;

  beforeAll(async () => {
    runtime = await CodeGraphParserRuntime.create();
  });
  afterAll(() => {
    runtime.dispose();
  });

  it('binds a line comment above a function to that function', async () => {
    const source = `// NOTE: guards against negative input
export function double(n: number): number {
  return n * 2;
}
`;
    const result = await extractRationaleFromSource(
      runtime,
      source,
      'src/math.ts',
    );
    expect(result.symbols).toHaveLength(1);
    const symbol = result.symbols[0];
    expect(symbol.kind).toBe('rationale');
    expect(symbol.name).toBe('NOTE');
    expect(symbol.qualifiedName).toBe('src/math.ts::rationale.L1');
    expect(symbol.signature).toBe('guards against negative input');

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0];
    expect(edge.kind).toBe('RATIONALE_FOR');
    expect(edge.sourceSymbolId).toBe(symbol.id);
    expect(edge.confidenceTier).toBe('EXTRACTED');
    expect(edge.confidenceScore).toBe(1.0);
    const doubleFn = symbolRowId(REPO, 'src/math.ts::double');
    expect(edge.targetSymbolId).toBe(doubleFn);
  });

  it('binds a comment inside a method to the innermost enclosing method, not the class', async () => {
    const source = `export class Box {
  unwrap(): number {
    // HACK: value is never actually undefined at runtime
    return this.value;
  }
  value = 0;
}
`;
    const result = await extractRationaleFromSource(
      runtime,
      source,
      'src/box.ts',
    );
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0].name).toBe('HACK');
    const method = symbolRowId(REPO, 'src/box.ts::Box.unwrap');
    expect(result.edges[0].targetSymbolId).toBe(method);
  });

  it('binds a trailing orphan comment to the file symbol', async () => {
    const source = `export function foo(): void {}

// FIXME: nobody has looked at this in years
`;
    const result = await extractRationaleFromSource(
      runtime,
      source,
      'src/orphan.ts',
    );
    expect(result.symbols).toHaveLength(1);
    const fileSymbolId = symbolRowId(REPO, fileQualifiedName('src/orphan.ts'));
    expect(result.edges[0].targetSymbolId).toBe(fileSymbolId);
  });

  it('does not match a lowercase marker spelling', async () => {
    const source = `// todo: this must never match
export function foo(): void {}
`;
    const result = await extractRationaleFromSource(
      runtime,
      source,
      'src/lower.ts',
    );
    expect(result.symbols).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('takes the first marker when a block comment contains more than one, counting it once', async () => {
    const source = `/**
 * NOTE: primary reason
 * WHY: secondary detail
 */
export function calc(): number {
  return 1;
}
`;
    const result = await extractRationaleFromSource(
      runtime,
      source,
      'src/calc.ts',
    );
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0].name).toBe('NOTE');
    expect(result.symbols[0].signature).toBe('primary reason');
    expect(result.symbols[0].qualifiedName).toBe('src/calc.ts::rationale.L2');
    const calcFn = symbolRowId(REPO, 'src/calc.ts::calc');
    expect(result.edges[0].targetSymbolId).toBe(calcFn);
  });

  it('matches a single-line JSDoc-style comment and strips the block-comment closer', async () => {
    const source = `/** WHY: fix the race condition */
export function race(): void {}
`;
    const result = await extractRationaleFromSource(
      runtime,
      source,
      'src/race.ts',
    );
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0].name).toBe('WHY');
    expect(result.symbols[0].signature).toBe('fix the race condition');
  });

  it('adds a column discriminator only for the second of two rationale comments on the same physical line', async () => {
    const source = `/* NOTE: a */ /* HACK: b */
export function twoInline(): void {}
`;
    const result = await extractRationaleFromSource(
      runtime,
      source,
      'src/twoinline.ts',
    );
    expect(result.symbols).toHaveLength(2);
    const [first, second] = result.symbols;
    expect(first.name).toBe('NOTE');
    expect(first.qualifiedName).toBe('src/twoinline.ts::rationale.L1');
    expect(second.name).toBe('HACK');
    expect(second.qualifiedName).toMatch(
      /^src\/twoinline\.ts::rationale\.L1C\d+$/,
    );
    // Distinct qualifiedNames mean distinct ids -- neither symbol row was
    // silently dropped by an INSERT OR REPLACE collision.
    expect(first.id).not.toBe(second.id);
  });

  it('binds a definition starting exactly 3 lines after the comment (inclusive window)', async () => {
    const source = `// NOTE: three lines away
//
//
export function inWindow(): void {}
`;
    const result = await extractRationaleFromSource(
      runtime,
      source,
      'src/window.ts',
    );
    expect(result.symbols).toHaveLength(1);
    const inWindowFn = symbolRowId(REPO, 'src/window.ts::inWindow');
    expect(result.edges[0].targetSymbolId).toBe(inWindowFn);
  });

  it('falls back to the file symbol when the nearest definition starts 4+ lines after the comment', async () => {
    const source = `// NOTE: four lines away, outside the window
//
//
//
export function outOfWindow(): void {}
`;
    const result = await extractRationaleFromSource(
      runtime,
      source,
      'src/outofwindow.ts',
    );
    expect(result.symbols).toHaveLength(1);
    const fileSymbolId = symbolRowId(
      REPO,
      fileQualifiedName('src/outofwindow.ts'),
    );
    expect(result.edges[0].targetSymbolId).toBe(fileSymbolId);
  });

  it('caps rationale extraction at 100 per file and reports the drop count', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `// NOTE: item ${i}`);
    const source = `${lines.join('\n')}\nexport function anchor(): void {}\n`;
    const result = await extractRationaleFromSource(
      runtime,
      source,
      'src/many.ts',
    );
    expect(result.symbols).toHaveLength(RATIONALE_MAX_PER_FILE);
    expect(result.edges).toHaveLength(RATIONALE_MAX_PER_FILE);
    expect(result.truncatedFacts).toBe(120 - RATIONALE_MAX_PER_FILE);
  });

  it('caps the extracted signature at 200 characters', async () => {
    const longText = 'x'.repeat(250);
    const source = `// NOTE: ${longText}
export function foo(): void {}
`;
    const result = await extractRationaleFromSource(
      runtime,
      source,
      'src/long.ts',
    );
    expect(result.symbols[0].signature?.length).toBe(200);
  });
});

describe('isRationaleExcludedPath', () => {
  it('excludes test file paths', () => {
    expect(isRationaleExcludedPath('src/__tests__/a.test.ts', true)).toBe(true);
    expect(isRationaleExcludedPath('src/a.test.ts', true)).toBe(true);
  });

  it('excludes generated-output directories regardless of test status', () => {
    expect(isRationaleExcludedPath('dist/a.ts', false)).toBe(true);
    expect(isRationaleExcludedPath('out/a.ts', false)).toBe(true);
    expect(isRationaleExcludedPath('build/a.ts', false)).toBe(true);
    expect(isRationaleExcludedPath('generated/a.ts', false)).toBe(true);
    expect(isRationaleExcludedPath('src/generated/a.ts', false)).toBe(true);
  });

  it('does not exclude ordinary source paths', () => {
    expect(isRationaleExcludedPath('src/lib.ts', false)).toBe(false);
    expect(isRationaleExcludedPath('src/distillery.ts', false)).toBe(false);
  });
});

describe('CodeGraphEngine rationale wiring (end to end)', () => {
  let root: string;
  let dbPath: string;
  let engine: CodeGraphEngine;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-rationale-'));
    mkdirSync(path.join(root, 'src', '__tests__'), { recursive: true });
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

  it('produces a rationale symbol and RATIONALE_FOR edge for a NOTE comment after a real build', async () => {
    writeFileSync(
      path.join(root, 'src', 'greeter.ts'),
      `// NOTE: keeps the greeting deterministic for snapshot tests
export function greet(name: string): string {
  return \`hello \${name}\`;
}
`,
    );
    const result = await engine.buildOrUpdate();
    expect(result.parseFailures).toBe(0);

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const fileId = fileRowId('fixture', 'src/greeter.ts');
      const symbols = store.listSymbolsForFile(fileId);
      const rationaleSymbol = symbols.find((s) => s.kind === 'rationale');
      expect(rationaleSymbol?.name).toBe('NOTE');
      expect(rationaleSymbol?.signature).toBe(
        'keeps the greeting deterministic for snapshot tests',
      );

      const edges = store.listEdges({
        kind: 'RATIONALE_FOR',
        repoId: 'fixture',
      });
      expect(edges).toHaveLength(1);
      const greetFn = symbolRowId('fixture', 'src/greeter.ts::greet');
      expect(edges[0].targetSymbolId).toBe(greetFn);
      expect(edges[0].sourceSymbolId).toBe(rationaleSymbol?.id);
    } finally {
      db.close();
    }
  });

  it('extracts zero rationale symbols from a test file', async () => {
    writeFileSync(
      path.join(root, 'src', '__tests__', 'greeter.test.ts'),
      `// TODO: add more cases
function checksGreeting(): void {}
checksGreeting();
`,
    );
    const result = await engine.buildOrUpdate();
    expect(result.parseFailures).toBe(0);

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const fileId = fileRowId('fixture', 'src/__tests__/greeter.test.ts');
      const symbols = store.listSymbolsForFile(fileId);
      expect(symbols.some((s) => s.kind === 'rationale')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('caps rationale symbols at 100 per file and records truncatedFacts on the file symbol', async () => {
    const lines = Array.from({ length: 130 }, (_, i) => `// NOTE: item ${i}`);
    writeFileSync(
      path.join(root, 'src', 'many.ts'),
      `${lines.join('\n')}\nexport function anchor(): void {}\n`,
    );
    const result = await engine.buildOrUpdate();
    expect(result.parseFailures).toBe(0);

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const fileId = fileRowId('fixture', 'src/many.ts');
      const symbols = store.listSymbolsForFile(fileId);
      const rationaleSymbols = symbols.filter((s) => s.kind === 'rationale');
      expect(rationaleSymbols).toHaveLength(100);
      const fileSymbol = symbols.find((s) => s.kind === 'file');
      expect(fileSymbol?.extra.truncatedFacts).toBe(30);
    } finally {
      db.close();
    }
  });
});
