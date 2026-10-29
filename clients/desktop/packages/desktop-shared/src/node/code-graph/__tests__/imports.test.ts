import { CodeGraphParserRuntime } from '../parser/runtime';
import { extractImports, importsToEdges } from '../extract/imports';
import { extractFileFacts } from '../extract/tags-extractor';

const SOURCE = `
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import def, { original as alias } from './other';
export { thing } from './reexport';
export type Shape = { x: number };
export enum Color { Red, Green }
`;

describe('supplemental extraction', () => {
  let runtime: CodeGraphParserRuntime;

  beforeAll(async () => {
    runtime = await CodeGraphParserRuntime.create();
  });
  afterAll(() => {
    runtime.dispose();
  });

  it('extracts imports with binding evidence', async () => {
    const grammar = await runtime.getGrammar('typescript');
    const imports = extractImports(runtime, grammar, SOURCE);
    expect(imports).toHaveLength(4);
    const named = imports.find((i) => i.source === 'node:fs/promises');
    expect(named?.names).toEqual([{ imported: 'readFile', local: 'readFile' }]);
    const namespace = imports.find((i) => i.source === 'node:path');
    expect(namespace?.namespaceLocal).toBe('path');
    const mixed = imports.find((i) => i.source === './other');
    expect(mixed?.defaultLocal).toBe('def');
    expect(mixed?.names).toEqual([{ imported: 'original', local: 'alias' }]);
    const reexport = imports.find((i) => i.source === './reexport');
    expect(reexport?.isReExport).toBe(true);
  });

  it('converts imports to unresolved IMPORTS_FROM edges with evidence', async () => {
    const grammar = await runtime.getGrammar('typescript');
    const imports = extractImports(runtime, grammar, SOURCE);
    const edges = importsToEdges({
      repoId: 'repo-a',
      relativePath: 'src/x.ts',
      fileSymbolId: 'sym_file',
      fileId: 'file_x',
      imports,
    });
    expect(edges).toHaveLength(4);
    expect(
      edges.every(
        (e) => e.kind === 'IMPORTS_FROM' && e.targetSymbolId === null,
      ),
    ).toBe(true);
    const mixed = edges.find((e) => e.targetRef === './other');
    expect(mixed?.evidence.defaultLocal).toBe('def');
  });

  it('captures type aliases and enums through the inline query suffix', async () => {
    const grammar = await runtime.getGrammar('typescript');
    const facts = extractFileFacts({
      grammar,
      runtime,
      repoId: 'repo-a',
      relativePath: 'src/x.ts',
      absolutePath: '/abs/src/x.ts',
      source: SOURCE,
      sizeBytes: SOURCE.length,
      mtimeNs: '1',
      contentHash: 'h',
      isTestFile: false,
    });
    const byQn = new Map(facts.symbols.map((s) => [s.qualifiedName, s]));
    expect(byQn.get('src/x.ts::Shape')?.kind).toBe('type');
    expect(byQn.get('src/x.ts::Color')?.kind).toBe('enum');
  });
});
