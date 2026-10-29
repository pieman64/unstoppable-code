import { CodeGraphParserRuntime } from '../parser/runtime';
import { extractFileFacts, isTestFilePath } from '../extract/tags-extractor';
import type { CodeGraphFileFacts } from '../../../types/code-graph';

const SOURCE = `
import { helper } from './helper';

export class Greeter {
  greet(): string {
    return helper();
  }
}

export const arrowFn = (): number => {
  return compute();
};

function internal(): void {
  arrowHelper();
  const g = new Greeter();
}
`;

describe('tags extractor', () => {
  let runtime: CodeGraphParserRuntime;
  let facts: CodeGraphFileFacts;

  beforeAll(async () => {
    runtime = await CodeGraphParserRuntime.create();
    const grammar = await runtime.getGrammar('typescript');
    facts = extractFileFacts({
      grammar,
      runtime,
      repoId: 'repo-a',
      relativePath: 'src/greeter.ts',
      absolutePath: '/abs/src/greeter.ts',
      source: SOURCE,
      sizeBytes: SOURCE.length,
      mtimeNs: '1',
      contentHash: 'h',
      isTestFile: false,
    });
  });
  afterAll(() => {
    runtime.dispose();
  });

  it('extracts Swift declarations and preserves unsupported calls as unresolved', async () => {
    const grammar = await runtime.getGrammar('swift');
    const source =
      'struct Greeter { func greet() { helper() } }\nfunc helper() {}';
    const result = extractFileFacts({
      grammar,
      runtime,
      repoId: 'r',
      relativePath: 'hello.swift',
      absolutePath: '/hello.swift',
      source,
      sizeBytes: source.length,
      mtimeNs: '1',
      contentHash: 'h',
      isTestFile: false,
    });
    expect(result.file.hasErrors).toBe(false);
    expect(result.symbols.map((symbol) => symbol.qualifiedName)).toEqual(
      expect.arrayContaining([
        'hello.swift::Greeter',
        'hello.swift::Greeter.greet',
        'hello.swift::helper',
      ]),
    );
    expect(result.edges.find((edge) => edge.kind === 'CALLS')).toMatchObject({
      targetRef: 'helper',
      targetSymbolId: null,
      evidence: { unsupportedLanguageResolution: true },
    });
  });

  it('classifies test file paths', () => {
    expect(isTestFilePath('src/__tests__/a.test.ts')).toBe(true);
    expect(isTestFilePath('src/a.spec.tsx')).toBe(true);
    expect(isTestFilePath('src/attest.ts')).toBe(false);
  });

  it('extracts the file symbol plus class, method, arrow const, and function', () => {
    const byQn = new Map(facts.symbols.map((s) => [s.qualifiedName, s]));
    expect(byQn.get('src/greeter.ts')?.kind).toBe('file');
    expect(byQn.get('src/greeter.ts::Greeter')?.kind).toBe('class');
    expect(byQn.get('src/greeter.ts::Greeter.greet')?.kind).toBe('method');
    expect(byQn.get('src/greeter.ts::arrowFn')?.kind).toBe('function');
    expect(byQn.get('src/greeter.ts::internal')?.kind).toBe('function');
    expect(byQn.get('src/greeter.ts::Greeter')?.exported).toBe(true);
    expect(byQn.get('src/greeter.ts::internal')?.exported).toBe(false);
  });

  it('builds CONTAINS edges from file to top-level and parent to member', () => {
    const contains = facts.edges.filter((e) => e.kind === 'CONTAINS');
    const fileSym = facts.symbols.find((s) => s.kind === 'file');
    const cls = facts.symbols.find((s) =>
      s.qualifiedName.endsWith('::Greeter'),
    );
    const method = facts.symbols.find((s) =>
      s.qualifiedName.endsWith('Greeter.greet'),
    );
    expect(
      contains.some(
        (e) => e.sourceSymbolId === fileSym?.id && e.targetSymbolId === cls?.id,
      ),
    ).toBe(true);
    expect(
      contains.some(
        (e) => e.sourceSymbolId === cls?.id && e.targetSymbolId === method?.id,
      ),
    ).toBe(true);
    expect(method?.parentSymbolId).toBe(cls?.id);
  });

  it('keeps unresolved call targets with the enclosing definition as source', () => {
    const calls = facts.edges.filter((e) => e.kind === 'CALLS');
    const helperCall = calls.find((e) => e.targetRef === 'helper');
    const method = facts.symbols.find((s) =>
      s.qualifiedName.endsWith('Greeter.greet'),
    );
    expect(helperCall?.sourceSymbolId).toBe(method?.id);
    expect(helperCall?.targetSymbolId).toBeNull();
    expect(helperCall?.confidenceTier).toBe('EXTRACTED');
    expect(calls.some((e) => e.targetRef === 'compute')).toBe(true);
    expect(calls.some((e) => e.targetRef === 'arrowHelper')).toBe(true);
  });

  it('emits exactly one class reference when JS and TS queries both capture it', () => {
    const newGreeterLine =
      SOURCE.split('\n').findIndex((line) => line.includes('new Greeter()')) +
      1;
    const classRefs = facts.edges.filter(
      (e) =>
        e.kind === 'REFERENCES' &&
        e.targetRef === 'Greeter' &&
        e.evidence.capture === 'reference.class' &&
        e.line === newGreeterLine,
    );
    expect(classRefs).toHaveLength(1);
  });

  it('records parse health on the file record', () => {
    expect(facts.file.parseStatus).toBe('parsed');
    expect(facts.file.hasErrors).toBe(false);
    expect(facts.file.grammarId).toBe('typescript');
    expect(facts.file.grammarAbi).toBe(14);
    expect(facts.file.lineCount).toBe(SOURCE.split('\n').length);
  });
});
