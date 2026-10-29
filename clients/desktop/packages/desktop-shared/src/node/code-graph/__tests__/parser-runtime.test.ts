import { CODE_GRAPH_GRAMMARS, grammarForPath } from '../grammars/registry';
import { CodeGraphParserRuntime, type Range } from '../parser/runtime';

describe('code-graph parser runtime', () => {
  it('maps extensions to grammars with JS tags preceding TS tags', () => {
    expect(grammarForPath('src/a.ts')?.id).toBe('typescript');
    expect(grammarForPath('src/a.tsx')?.id).toBe('tsx');
    expect(grammarForPath('src/a.mjs')?.id).toBe('javascript');
    expect(grammarForPath('src/a.css')).toBeUndefined();
    const ts = CODE_GRAPH_GRAMMARS.find((g) => g.id === 'typescript');
    expect(ts?.tagsFiles[0]).toBe('queries/javascript.tags.scm');
    expect(ts?.tagsFiles[1]).toBe('queries/typescript.tags.scm');
  });

  it('loads real grammars, reports ABI, and parses source', async () => {
    const runtime = await CodeGraphParserRuntime.create();
    try {
      const grammar = await runtime.getGrammar('typescript');
      expect(grammar.abiVersion).toBeGreaterThanOrEqual(13);
      expect(grammar.abiVersion).toBeLessThanOrEqual(15);
      const matchCount = runtime.withParser(grammar, (parser) =>
        runtime.withTree(
          parser,
          'export function hi(): void { other(); }',
          (tree) => {
            if (tree === null) {
              throw new Error('parse returned null');
            }
            expect(tree.rootNode.hasError).toBe(false);
            return grammar.tagsQuery.matches(tree.rootNode).length;
          },
        ),
      );
      expect(matchCount).toBeGreaterThanOrEqual(2); // definition + call reference
      const again = await runtime.getGrammar('typescript');
      expect(again).toBe(grammar); // cached
    } finally {
      runtime.dispose();
    }
  });

  it('rejects unknown grammar ids', async () => {
    const runtime = await CodeGraphParserRuntime.create();
    try {
      await expect(runtime.getGrammar('cobol')).rejects.toThrow('cobol');
    } finally {
      runtime.dispose();
    }
  });

  it('loads the markdown block and inline grammars and reports ABI, cached across calls', async () => {
    const runtime = await CodeGraphParserRuntime.create();
    try {
      const { block, inline } = await runtime.getMarkdownGrammars();
      expect(block.abiVersion).toBeGreaterThanOrEqual(13);
      expect(block.abiVersion).toBeLessThanOrEqual(15);
      expect(inline.abiVersion).toBeGreaterThanOrEqual(13);
      expect(inline.abiVersion).toBeLessThanOrEqual(15);
      const again = await runtime.getMarkdownGrammars();
      expect(again.block).toBe(block); // cached
      expect(again.inline).toBe(inline); // cached
    } finally {
      runtime.dispose();
    }
  });

  it('dual-parses a heading + link doc via withParserForLanguage/withTreeOptions and finds a link_destination in the inline tree', async () => {
    const runtime = await CodeGraphParserRuntime.create();
    try {
      const { block, inline } = await runtime.getMarkdownGrammars();
      const source = '# Heading\n\n[example](https://example.com)\n';

      const foundLinkDestination = runtime.withParserForLanguage(
        block.language,
        (blockParser) =>
          runtime.withTreeOptions(
            blockParser,
            source,
            undefined,
            (blockTree) => {
              if (blockTree === null) {
                throw new Error('block parse returned null');
              }
              expect(blockTree.rootNode.hasError).toBe(false);

              const ranges: Range[] = [];
              const blockStack = [blockTree.rootNode];
              while (blockStack.length > 0) {
                const node = blockStack.pop();
                if (node === undefined) {
                  continue;
                }
                if (node.type === 'inline') {
                  ranges.push({
                    startIndex: node.startIndex,
                    endIndex: node.endIndex,
                    startPosition: node.startPosition,
                    endPosition: node.endPosition,
                  });
                }
                for (let i = node.childCount - 1; i >= 0; i -= 1) {
                  const child = node.child(i);
                  if (child !== null) {
                    blockStack.push(child);
                  }
                }
              }
              expect(ranges.length).toBeGreaterThan(0);

              return runtime.withParserForLanguage(
                inline.language,
                (inlineParser) =>
                  runtime.withTreeOptions(
                    inlineParser,
                    source,
                    { includedRanges: ranges },
                    (inlineTree) => {
                      if (inlineTree === null) {
                        throw new Error('inline parse returned null');
                      }
                      let found = false;
                      const inlineStack = [inlineTree.rootNode];
                      while (inlineStack.length > 0) {
                        const node = inlineStack.pop();
                        if (node === undefined) {
                          continue;
                        }
                        if (node.type === 'link_destination') {
                          found = true;
                        }
                        for (let i = node.childCount - 1; i >= 0; i -= 1) {
                          const child = node.child(i);
                          if (child !== null) {
                            inlineStack.push(child);
                          }
                        }
                      }
                      return found;
                    },
                  ),
              );
            },
          ),
      );

      expect(foundLinkDestination).toBe(true);
    } finally {
      runtime.dispose();
    }
  });
});
