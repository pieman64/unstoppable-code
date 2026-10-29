import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { getBundledCodeGraphDir } from '../../../pipelines/config-paths';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('code-graph grammar resources', () => {
  const dir = getBundledCodeGraphDir();

  it('resolves to the committed resources directory', () => {
    expect(dir.endsWith(path.join('resources', 'code-graph'))).toBe(true);
    expect(existsSync(path.join(dir, 'manifest.json'))).toBe(true);
  });

  it('contains every artifact the manifest and registry rely on', () => {
    for (const rel of [
      'runtime/web-tree-sitter.wasm',
      'grammars/tree-sitter-swift.wasm',
      'queries/swift.tags.scm',
      'licenses/swift.txt',
      'grammars/tree-sitter-typescript.wasm',
      'grammars/tree-sitter-tsx.wasm',
      'grammars/tree-sitter-javascript.wasm',
      'grammars/tree-sitter-markdown.wasm',
      'grammars/tree-sitter-markdown-inline.wasm',
      'queries/typescript.tags.scm',
      'queries/javascript.tags.scm',
    ]) {
      expect(existsSync(path.join(dir, rel))).toBe(true);
    }
  });

  it('matches the installed web-tree-sitter version and the pinned grammar versions', () => {
    const manifestRaw: unknown = JSON.parse(
      readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
    );
    if (!isRecord(manifestRaw) || !isRecord(manifestRaw.runtime)) {
      throw new Error('manifest.json missing runtime block');
    }
    const rootPkgRaw: unknown = JSON.parse(
      readFileSync(path.resolve(dir, '../../../..', 'package.json'), 'utf8'),
    );
    if (!isRecord(rootPkgRaw) || !isRecord(rootPkgRaw['code-graph'])) {
      throw new Error('root package.json missing code-graph block');
    }
    const wtsPkgRaw: unknown = JSON.parse(
      readFileSync(
        require
          .resolve('web-tree-sitter')
          .replace(/web-tree-sitter\.c?js$/, 'package.json'),
        'utf8',
      ),
    );
    if (!isRecord(wtsPkgRaw)) {
      throw new Error('web-tree-sitter package.json unreadable');
    }
    expect(manifestRaw.runtime.version).toBe(wtsPkgRaw.version);
    const pins = rootPkgRaw['code-graph'];
    if (!isRecord(pins) || !isRecord(pins.grammars)) {
      throw new Error('code-graph.grammars missing');
    }
    if (!Array.isArray(manifestRaw.grammars)) {
      throw new Error('manifest grammars missing');
    }
    for (const entry of manifestRaw.grammars) {
      if (!isRecord(entry) || typeof entry.package !== 'string') {
        throw new Error('bad manifest grammar entry');
      }
      expect(entry.version).toBe(pins.grammars[entry.package]);
    }
  });

  it('records the self-built markdown grammars with the pinned version and a built marker', () => {
    const manifestRaw: unknown = JSON.parse(
      readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
    );
    if (!isRecord(manifestRaw) || !Array.isArray(manifestRaw.grammars)) {
      throw new Error('manifest grammars missing');
    }
    const rootPkgRaw: unknown = JSON.parse(
      readFileSync(path.resolve(dir, '../../../..', 'package.json'), 'utf8'),
    );
    if (!isRecord(rootPkgRaw) || !isRecord(rootPkgRaw['code-graph'])) {
      throw new Error('root package.json missing code-graph block');
    }
    const pins = rootPkgRaw['code-graph'];
    if (!isRecord(pins) || !isRecord(pins.grammars)) {
      throw new Error('code-graph.grammars missing');
    }
    const markdownPackage = '@tree-sitter-grammars/tree-sitter-markdown';
    const pinnedVersion = pins.grammars[markdownPackage];
    expect(typeof pinnedVersion).toBe('string');

    const foundGrammarIds = new Set<string>();
    for (const entry of manifestRaw.grammars) {
      if (
        isRecord(entry) &&
        entry.package === markdownPackage &&
        typeof entry.grammar === 'string'
      ) {
        foundGrammarIds.add(entry.grammar);
        expect(entry.version).toBe(pinnedVersion);
        expect(entry.built).toBe(true);
      }
    }
    expect(foundGrammarIds.has('markdown')).toBe(true);
    expect(foundGrammarIds.has('markdown-inline')).toBe(true);
  });
});
