import {
  CODE_GRAPH_NON_CODE_EXTRACTORS,
  nonCodeExtractorForPath,
} from '../extract/extractor-registry';
import { CODE_GRAPH_SOURCE_EXTENSIONS } from '../grammars/registry';
import { CodeGraphParserRuntime } from '../parser/runtime';

describe('code-graph non-code extractor registry', () => {
  it('matches markdown by .md/.mdx extension', () => {
    expect(nonCodeExtractorForPath('README.md')?.id).toBe('markdown');
    expect(nonCodeExtractorForPath('docs/guide.mdx')?.id).toBe('markdown');
    expect(nonCodeExtractorForPath('src/lib.ts')).toBeUndefined();
  });

  it('matches package.json by basename anywhere in the tree', () => {
    expect(nonCodeExtractorForPath('package.json')?.id).toBe('package-json');
    expect(nonCodeExtractorForPath('apps/web/package.json')?.id).toBe(
      'package-json',
    );
    expect(nonCodeExtractorForPath('package.json.bak')).toBeUndefined();
    expect(nonCodeExtractorForPath('my-package.json')).toBeUndefined();
  });

  it('matches tsconfig*.json by basename', () => {
    expect(nonCodeExtractorForPath('tsconfig.json')?.id).toBe('tsconfig');
    expect(nonCodeExtractorForPath('apps/web/tsconfig.json')?.id).toBe(
      'tsconfig',
    );
    expect(nonCodeExtractorForPath('tsconfig.build.json')?.id).toBe('tsconfig');
    expect(nonCodeExtractorForPath('tsconfig.jsonx')).toBeUndefined();
    expect(nonCodeExtractorForPath('nottsconfig.json')).toBeUndefined();
  });

  it('matches .mcp.json or mcp.json by basename', () => {
    expect(nonCodeExtractorForPath('.mcp.json')?.id).toBe('mcp-config');
    expect(nonCodeExtractorForPath('mcp.json')?.id).toBe('mcp-config');
    expect(nonCodeExtractorForPath('config/.mcp.json')?.id).toBe('mcp-config');
    expect(nonCodeExtractorForPath('other-mcp.json')).toBeUndefined();
  });

  it('matches .github/workflows/*.yml or *.yaml by path, case-insensitively', () => {
    expect(nonCodeExtractorForPath('.github/workflows/ci.yml')?.id).toBe(
      'github-workflow',
    );
    expect(nonCodeExtractorForPath('.github/workflows/release.yaml')?.id).toBe(
      'github-workflow',
    );
    expect(
      nonCodeExtractorForPath('apps/web/.github/workflows/deploy.yml')?.id,
    ).toBe('github-workflow');
    expect(nonCodeExtractorForPath('.GITHUB/Workflows/CI.YML')?.id).toBe(
      'github-workflow',
    );
    // Not a workflow file: wrong directory, wrong extension, or a nested
    // workflows-looking directory one level too deep.
    expect(nonCodeExtractorForPath('.github/ci.yml')).toBeUndefined();
    expect(nonCodeExtractorForPath('.github/workflows/ci.txt')).toBeUndefined();
    expect(
      nonCodeExtractorForPath('.github/workflows/nested/ci.yml'),
    ).toBeUndefined();
    expect(nonCodeExtractorForPath('workflows/ci.yml')).toBeUndefined();
  });

  it('returns undefined for paths matching no non-code extractor', () => {
    expect(nonCodeExtractorForPath('src/index.ts')).toBeUndefined();
    expect(nonCodeExtractorForPath('README')).toBeUndefined();
  });

  it('matches action.yml or action.yaml by basename anywhere in the tree, case-insensitively (Phase 6: local workflow-action resolution)', () => {
    expect(
      nonCodeExtractorForPath('.github/actions/local-thing/action.yml')?.id,
    ).toBe('github-action-manifest');
    expect(
      nonCodeExtractorForPath('.github/actions/local-thing/action.yaml')?.id,
    ).toBe('github-action-manifest');
    // A local action referenced as `uses: ./` lives at the repository root.
    expect(nonCodeExtractorForPath('action.yml')?.id).toBe(
      'github-action-manifest',
    );
    expect(nonCodeExtractorForPath('ACTION.YML')?.id).toBe(
      'github-action-manifest',
    );
    expect(nonCodeExtractorForPath('my-action.yml')).toBeUndefined();
    expect(nonCodeExtractorForPath('action.yml.bak')).toBeUndefined();
  });

  it('prefers the github-workflow matcher over the action-manifest matcher for a workflow file that happens to be named action.yml', () => {
    // Registry order decides ties: github-workflow is listed before
    // github-action-manifest, so a (pathological) workflow file literally
    // named action.yml under .github/workflows/ still resolves as a workflow.
    expect(nonCodeExtractorForPath('.github/workflows/action.yml')?.id).toBe(
      'github-workflow',
    );
  });

  it('resolves the first matching definition in registry order', () => {
    // Every candidate path in this suite is claimed by exactly one
    // definition today, but nonCodeExtractorForPath is documented as
    // first-match-wins, so pin that contract explicitly.
    const readme = nonCodeExtractorForPath('README.md');
    expect(readme).toBe(CODE_GRAPH_NON_CODE_EXTRACTORS[0]);
  });

  it('keeps non-code matcher paths disjoint from grammar source extensions', () => {
    for (const extension of CODE_GRAPH_SOURCE_EXTENSIONS) {
      const samplePath = `some/file${extension}`;
      expect(nonCodeExtractorForPath(samplePath)).toBeUndefined();
    }
  });

  it('keeps the github-workflow matcher disjoint from every other non-code matcher', () => {
    // A workflow path never collides with the basename-driven manifest
    // matchers (they all require an exact top-level basename, never a
    // `.github/workflows/` path segment) or the markdown extension matcher.
    const workflowPaths = [
      '.github/workflows/ci.yml',
      '.github/workflows/release.yaml',
      'apps/web/.github/workflows/deploy.yml',
    ];
    for (const workflowPath of workflowPaths) {
      expect(nonCodeExtractorForPath(workflowPath)?.id).toBe('github-workflow');
    }

    // And the reverse: none of the OTHER matchers' sample paths are claimed
    // by the github-workflow matcher.
    const otherMatcherPaths = [
      'README.md',
      'docs/guide.mdx',
      'package.json',
      'apps/web/package.json',
      'tsconfig.json',
      'tsconfig.build.json',
      '.mcp.json',
      'mcp.json',
    ];
    for (const otherPath of otherMatcherPaths) {
      expect(nonCodeExtractorForPath(otherPath)?.id).not.toBe(
        'github-workflow',
      );
    }
  });

  it('each minimal extractor returns file-symbol-only facts for content with no extractable structure (Task 3 contract; markdown body replaced in Task 4, package.json/mcp-config replaced in Task 5, but empty content is still file-symbol-only for all three)', async () => {
    const cases: Array<{ relativePath: string; id: string }> = [
      { relativePath: 'README.md', id: 'markdown' },
      { relativePath: 'package.json', id: 'package-json' },
      { relativePath: '.mcp.json', id: 'mcp-config' },
    ];
    const runtime = await CodeGraphParserRuntime.create();
    try {
      for (const testCase of cases) {
        const definition = nonCodeExtractorForPath(testCase.relativePath);
        expect(definition?.id).toBe(testCase.id);
        if (definition === undefined) {
          continue;
        }
        const source = '{}\n';
        const facts = await definition.extract({
          repoId: 'fixture',
          relativePath: testCase.relativePath,
          absolutePath: `/repo/${testCase.relativePath}`,
          source,
          sizeBytes: source.length,
          mtimeNs: '100',
          contentHash: 'deadbeef',
          runtime,
        });
        expect(facts.file.language).toBe(testCase.id);
        expect(facts.file.grammarId).toBe(testCase.id);
        expect(facts.file.grammarAbi).toBeNull();
        expect(facts.file.parseStatus).toBe('parsed');
        expect(facts.file.relativePath).toBe(testCase.relativePath);
        expect(facts.symbols).toHaveLength(1);
        expect(facts.symbols[0].kind).toBe('file');
        expect(facts.edges).toEqual([]);
      }
    } finally {
      runtime.dispose();
    }
  });

  it('tsconfig always emits a config symbol + CONFIGURES edge even for an empty config (Task 5 contract: unlike package.json/mcp-config, the config symbol is unconditional)', async () => {
    const definition = nonCodeExtractorForPath('tsconfig.json');
    expect(definition?.id).toBe('tsconfig');
    if (definition === undefined) {
      return;
    }
    const runtime = await CodeGraphParserRuntime.create();
    try {
      const source = '{}\n';
      const facts = await definition.extract({
        repoId: 'fixture',
        relativePath: 'tsconfig.json',
        absolutePath: '/repo/tsconfig.json',
        source,
        sizeBytes: source.length,
        mtimeNs: '100',
        contentHash: 'deadbeef',
        runtime,
      });
      expect(facts.file.language).toBe('tsconfig');
      expect(facts.symbols).toHaveLength(2); // file symbol + config symbol
      expect(facts.symbols[1].kind).toBe('config');
      expect(facts.edges).toHaveLength(1);
      expect(facts.edges[0].kind).toBe('CONFIGURES');
    } finally {
      runtime.dispose();
    }
  });
});
