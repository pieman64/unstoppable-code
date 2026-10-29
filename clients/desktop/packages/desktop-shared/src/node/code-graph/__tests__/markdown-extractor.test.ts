import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { extractMarkdownFacts } from '../extract/markdown-extractor';
import { resolveDocLinkEdges } from '../resolve/doc-link-resolver';
import { CodeGraphParserRuntime } from '../parser/runtime';
import {
  openCodeGraphDatabase,
  type CodeGraphDatabase,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { CodeGraphStore } from '../store/graph-store';
import {
  edgeRowId,
  fileQualifiedName,
  fileRowId,
  symbolQualifiedName,
  symbolRowId,
} from '../ids';
import type {
  CodeGraphEdgeRecord,
  CodeGraphFileFacts,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';

const REPO = 'fixture';
const RELATIVE_PATH = 'docs/guide.md';

async function extractFacts(
  runtime: CodeGraphParserRuntime,
  source: string,
  relativePath: string = RELATIVE_PATH,
): Promise<CodeGraphFileFacts> {
  return extractMarkdownFacts({
    repoId: REPO,
    relativePath,
    absolutePath: `/repo/${relativePath}`,
    source,
    sizeBytes: Buffer.byteLength(source, 'utf8'),
    mtimeNs: '1',
    contentHash: 'hash',
    runtime,
  });
}

function docSections(facts: CodeGraphFileFacts): CodeGraphSymbolRecord[] {
  return facts.symbols.filter((symbol) => symbol.kind === 'doc_section');
}

function bySlug(
  facts: CodeGraphFileFacts,
  slugPath: string,
  relativePath: string = RELATIVE_PATH,
): CodeGraphSymbolRecord | undefined {
  const qualifiedName = symbolQualifiedName(
    relativePath,
    slugPath.split('.').slice(0, -1),
    slugPath.split('.').slice(-1)[0],
  );
  return facts.symbols.find((symbol) => symbol.qualifiedName === qualifiedName);
}

describe('markdown extractor', () => {
  let runtime: CodeGraphParserRuntime;

  beforeAll(async () => {
    runtime = await CodeGraphParserRuntime.create();
  });

  afterAll(() => {
    runtime.dispose();
  });

  it('resolves full, collapsed and shortcut reference links at their use sites', async () => {
    const source =
      '# Guide\n\n[Full][ REF ] and [ref][] and [ref].\n\n[ref]: ../lib.ts "title"\n[unused]: ../unused.ts\n\n```md\n[fake]: ../fake.ts\n```\n';
    const facts = await extractFacts(runtime, source);
    const links = facts.edges.filter((edge) => edge.kind === 'DOCUMENTS');
    expect(links).toHaveLength(1); // same target/line is deduplicated
    expect(links[0]).toMatchObject({ targetRef: '../lib.ts', line: 3 });
    expect(links[0].sourceSymbolId).toBe(bySlug(facts, 'guide')?.id);
  });

  it('builds a heading hierarchy (h1 > h2 > h3, plus a sibling h2) with correct qualified names and parents', async () => {
    const source = [
      '# Title One',
      '',
      '## Section A',
      '',
      'Content A',
      '',
      '### Subsection A1',
      '',
      'Content A1',
      '',
      '## Section B',
      '',
      'Content B',
      '',
    ].join('\n');

    const facts = await extractFacts(runtime, source);
    expect(facts.file.hasErrors).toBe(false);
    expect(facts.file.parseStatus).toBe('parsed');

    const fileSymbol = facts.symbols.find((symbol) => symbol.kind === 'file');
    expect(fileSymbol).toBeDefined();
    const sections = docSections(facts);
    expect(sections).toHaveLength(4);

    const titleOne = bySlug(facts, 'title-one');
    const sectionA = bySlug(facts, 'title-one.section-a');
    const subsectionA1 = bySlug(facts, 'title-one.section-a.subsection-a1');
    const sectionB = bySlug(facts, 'title-one.section-b');
    expect(titleOne?.name).toBe('Title One');
    expect(sectionA?.name).toBe('Section A');
    expect(subsectionA1?.name).toBe('Subsection A1');
    expect(sectionB?.name).toBe('Section B');

    // Root-level headings get parentSymbolId: null, exactly like top-level
    // code definitions — the file relationship is carried by the CONTAINS
    // edge (source = file symbol), not by parentSymbolId.
    expect(titleOne?.parentSymbolId).toBeNull();
    expect(sectionA?.parentSymbolId).toBe(titleOne?.id);
    expect(subsectionA1?.parentSymbolId).toBe(sectionA?.id);
    expect(sectionB?.parentSymbolId).toBe(titleOne?.id); // sibling of Section A, not nested under it

    const containsEdges = facts.edges.filter(
      (edge) => edge.kind === 'CONTAINS',
    );
    expect(containsEdges).toHaveLength(4);
    expect(
      containsEdges.some(
        (edge) =>
          edge.sourceSymbolId === fileSymbol?.id &&
          edge.targetSymbolId === titleOne?.id,
      ),
    ).toBe(true);
    expect(
      containsEdges.some(
        (edge) =>
          edge.sourceSymbolId === titleOne?.id &&
          edge.targetSymbolId === sectionB?.id,
      ),
    ).toBe(true);
  });

  it('treats setext headings as h1 (=== underline) / h2 (--- underline) and extracts their text', async () => {
    const source = [
      'Top Level',
      '=========',
      '',
      '## Nested ATX',
      '',
      'Body Heading',
      '-------------',
      '',
    ].join('\n');

    const facts = await extractFacts(runtime, source);
    const sections = docSections(facts);
    expect(sections).toHaveLength(3);

    const topLevel = bySlug(facts, 'top-level');
    const nestedAtx = bySlug(facts, 'top-level.nested-atx');
    const bodyHeading = bySlug(facts, 'top-level.body-heading');
    expect(topLevel?.name).toBe('Top Level');
    expect(nestedAtx?.name).toBe('Nested ATX');
    expect(bodyHeading?.name).toBe('Body Heading');
    // "Body Heading" (setext h2, level 2) closes out "Nested ATX" (atx h2,
    // level 2) and becomes ITS sibling under "Top Level", not its child.
    expect(bodyHeading?.parentSymbolId).toBe(topLevel?.id);
    expect(nestedAtx?.parentSymbolId).toBe(topLevel?.id);
  });

  it('dedupes colliding slugs within a file with -2/-3 suffixes instead of dropping sections', async () => {
    const source = [
      '# Doc',
      '',
      '## Overview',
      '',
      'Text 1',
      '',
      '## Overview',
      '',
      'Text 2',
      '',
      '## Overview',
      '',
      'Text 3',
      '',
    ].join('\n');

    const facts = await extractFacts(runtime, source);
    const sections = docSections(facts);
    expect(sections).toHaveLength(4); // Doc + three "Overview" headings, none dropped

    const first = bySlug(facts, 'doc.overview');
    const second = bySlug(facts, 'doc.overview-2');
    const third = bySlug(facts, 'doc.overview-3');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    expect(first?.name).toBe('Overview');
    expect(second?.name).toBe('Overview');
    expect(third?.name).toBe('Overview');
    // All three collided-slug symbols still get distinct ids/qualifiedNames.
    const ids = new Set([first?.id, second?.id, third?.id]);
    expect(ids.size).toBe(3);
  });

  it('extracts DOCUMENTS edges for relative and root-relative links, skips external/fragment-only links, and captures wikilinks', async () => {
    const lines = [
      '# Doc',
      '',
      'Link one: [rel](./other.md)',
      '',
      'Link two: [rootrel](docs/x.md)',
      '',
      'Link three: [ext](https://example.com)',
      '',
      'Link four: [frag](#section)',
      '',
      'Link five: [[Wiki Target]]',
      '',
      'Link six: [withfrag](./other.md#anchor)',
      '',
    ];
    const source = lines.join('\n');

    const facts = await extractFacts(runtime, source);
    const docEdges = facts.edges.filter((edge) => edge.kind === 'DOCUMENTS');
    expect(docEdges).toHaveLength(4);

    const byTargetAndLine = new Map(
      docEdges.map((edge) => [`${edge.targetRef}@${edge.line}`, edge]),
    );
    const rel = byTargetAndLine.get('./other.md@3');
    expect(rel).toBeDefined();
    expect(rel?.evidence.raw).toBe('./other.md');
    expect(rel?.targetSymbolId).toBeNull();
    expect(rel?.confidenceTier).toBe('EXTRACTED');
    expect(rel?.confidenceScore).toBe(1.0);

    const rootRelative = byTargetAndLine.get('docs/x.md@5');
    expect(rootRelative).toBeDefined();

    expect(byTargetAndLine.has('https://example.com@7')).toBe(false);
    expect(docEdges.some((edge) => edge.targetRef?.startsWith('#'))).toBe(
      false,
    );

    const wikilink = byTargetAndLine.get('Wiki Target@11');
    expect(wikilink).toBeDefined();
    expect(wikilink?.evidence.raw).toBe('Wiki Target');

    const withFragment = byTargetAndLine.get('./other.md@13');
    expect(withFragment).toBeDefined();
    expect(withFragment?.evidence.raw).toBe('./other.md#anchor'); // fragment kept in raw evidence, stripped from targetRef

    // Every link in this fixture falls inside the single "Doc" section.
    const docSection = bySlug(facts, 'doc');
    expect(docSection).toBeDefined();
    for (const edge of docEdges) {
      expect(edge.sourceSymbolId).toBe(docSection?.id);
    }
  });

  it('skips an uppercase external scheme (HTTPS://) exactly like a lowercase one', async () => {
    const source = ['# Doc', '', 'Link: [ext](HTTPS://example.com)', ''].join(
      '\n',
    );

    const facts = await extractFacts(runtime, source);
    const docEdges = facts.edges.filter((edge) => edge.kind === 'DOCUMENTS');
    expect(
      docEdges.some((edge) => edge.targetRef === 'HTTPS://example.com'),
    ).toBe(false);
    expect(docEdges).toHaveLength(0);
  });

  it('does not treat a [[wikilink]]-shaped sequence inside a fenced code block as a doc link, but still captures one in prose', async () => {
    const source = [
      '# Doc',
      '',
      'Real: [[Real Target]]',
      '',
      '```',
      'Fake: [[Fake Target]]',
      '```',
      '',
    ].join('\n');

    const facts = await extractFacts(runtime, source);
    const docEdges = facts.edges.filter((edge) => edge.kind === 'DOCUMENTS');
    const targets = docEdges.map((edge) => edge.targetRef);
    expect(targets).toContain('Real Target');
    expect(targets).not.toContain('Fake Target');
  });

  it("dedupes a slug collision where a later duplicate heading would otherwise land on an earlier literal heading's slug", async () => {
    // "Section" -> "section", "Section 2" -> "section-2" (literal), then the
    // second "Section" -> naive count-based suffixing would ALSO produce
    // "section-2", colliding with the literal "Section 2" heading's slug.
    const source = [
      '## Section',
      '',
      'Text 1',
      '',
      '## Section 2',
      '',
      'Text 2',
      '',
      '## Section',
      '',
      'Text 3',
      '',
    ].join('\n');

    const facts = await extractFacts(runtime, source);
    const sections = docSections(facts);
    expect(sections).toHaveLength(3);

    const qualifiedNames = sections.map((section) => section.qualifiedName);
    expect(new Set(qualifiedNames).size).toBe(3);

    const first = bySlug(facts, 'section');
    const second = bySlug(facts, 'section-2');
    const third = bySlug(facts, 'section-3');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    expect(second?.name).toBe('Section 2');
    expect(third?.name).toBe('Section');
  });

  it('caps doc sections at 200 per file and records the drop count on the file symbol', async () => {
    const totalHeadings = 210;
    const source = Array.from(
      { length: totalHeadings },
      (_, i) => `## Section ${i + 1}\n\nBody ${i + 1}\n`,
    ).join('\n');

    const facts = await extractFacts(runtime, source);
    const sections = docSections(facts);
    expect(sections).toHaveLength(200);

    const fileSymbol = facts.symbols.find((symbol) => symbol.kind === 'file');
    expect(fileSymbol?.extra.truncatedFacts).toBe(totalHeadings - 200);
  });
});

describe('doc-link resolver', () => {
  const RESOLVER_REPO = 'repo-a';
  const ROOT = '/abs';
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;

  function fileFacts(
    relativePath: string,
    extraEdges: CodeGraphEdgeRecord[] = [],
  ): CodeGraphFileFacts {
    const fileId = fileRowId(RESOLVER_REPO, relativePath);
    const fileSymbol: CodeGraphSymbolRecord = {
      id: symbolRowId(RESOLVER_REPO, fileQualifiedName(relativePath)),
      repositoryId: RESOLVER_REPO,
      fileId,
      kind: 'file',
      name: relativePath.split('/').pop() ?? relativePath,
      qualifiedName: fileQualifiedName(relativePath),
      parentSymbolId: null,
      lineStart: 1,
      lineEnd: 5,
      byteStart: 0,
      byteEnd: 50,
      signature: null,
      exported: false,
      isTest: false,
      extra: {},
    };
    return {
      file: {
        id: fileId,
        repositoryId: RESOLVER_REPO,
        relativePath,
        absolutePath: path.join(ROOT, relativePath),
        language: 'markdown',
        contentHash: 'h',
        sizeBytes: 50,
        mtimeNs: '1',
        lineCount: 5,
        grammarId: 'markdown',
        grammarAbi: null,
        parseStatus: 'parsed',
        hasErrors: false,
        updatedAt: Date.now(),
      },
      symbols: [fileSymbol],
      edges: extraEdges,
    };
  }

  function documentsEdge(
    relativePath: string,
    targetRef: string,
    line: number,
  ): CodeGraphEdgeRecord {
    const fileId = fileRowId(RESOLVER_REPO, relativePath);
    const sourceSymbolId = symbolRowId(
      RESOLVER_REPO,
      fileQualifiedName(relativePath),
    );
    return {
      id: edgeRowId({
        repoId: RESOLVER_REPO,
        kind: 'DOCUMENTS',
        sourceId: sourceSymbolId,
        target: targetRef,
        line,
      }),
      repositoryId: RESOLVER_REPO,
      kind: 'DOCUMENTS',
      sourceSymbolId,
      targetSymbolId: null,
      sourceFileId: fileId,
      targetRef,
      line,
      confidenceTier: 'EXTRACTED',
      confidenceScore: 1.0,
      resolverId: null,
      evidence: { raw: targetRef },
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-doclink-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({
      repoId: RESOLVER_REPO,
      rootPath: ROOT,
      gitHead: null,
    });

    store.replaceFileFacts(fileFacts('docs/other.md'));
    store.replaceFileFacts(
      fileFacts('docs/guide.md', [
        documentsEdge('docs/guide.md', './other.md', 3),
      ]),
    );
    store.replaceFileFacts(
      fileFacts('docs/guide2.md', [
        documentsEdge('docs/guide2.md', 'docs/other.md', 3),
      ]),
    );
    store.replaceFileFacts(
      fileFacts('docs/guide3.md', [
        documentsEdge('docs/guide3.md', './nope.md', 3),
      ]),
    );
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('binds a dir-relative target to the file symbol in the same directory', () => {
    const resolved = resolveDocLinkEdges({
      store,
      repoId: RESOLVER_REPO,
      rootPath: ROOT,
    });
    expect(resolved).toBe(2); // guide.md (dir-relative) + guide2.md (root-relative)

    const edges = store.listEdges({ kind: 'DOCUMENTS', repoId: RESOLVER_REPO });
    const guideEdge = edges.find(
      (edge) => edge.sourceFileId === fileRowId(RESOLVER_REPO, 'docs/guide.md'),
    );
    expect(guideEdge?.targetSymbolId).toBe(
      symbolRowId(RESOLVER_REPO, fileQualifiedName('docs/other.md')),
    );
    expect(guideEdge?.confidenceTier).toBe('RESOLVED');
    expect(guideEdge?.confidenceScore).toBe(0.95);
    expect(guideEdge?.resolverId).toBe('doc-link');
    expect(guideEdge?.evidence.resolvedPath).toBe('docs/other.md');
  });

  it('falls back to a repo-root-relative target when dir-relative resolution fails', () => {
    resolveDocLinkEdges({ store, repoId: RESOLVER_REPO, rootPath: ROOT });
    const edges = store.listEdges({ kind: 'DOCUMENTS', repoId: RESOLVER_REPO });
    const guide2Edge = edges.find(
      (edge) =>
        edge.sourceFileId === fileRowId(RESOLVER_REPO, 'docs/guide2.md'),
    );
    expect(guide2Edge?.targetSymbolId).toBe(
      symbolRowId(RESOLVER_REPO, fileQualifiedName('docs/other.md')),
    );
    expect(guide2Edge?.resolverId).toBe('doc-link');
  });

  it('leaves a missing target unresolved and is idempotent', () => {
    const firstPass = resolveDocLinkEdges({
      store,
      repoId: RESOLVER_REPO,
      rootPath: ROOT,
    });
    expect(firstPass).toBe(2);

    const edges = store.listEdges({ kind: 'DOCUMENTS', repoId: RESOLVER_REPO });
    const guide3Edge = edges.find(
      (edge) =>
        edge.sourceFileId === fileRowId(RESOLVER_REPO, 'docs/guide3.md'),
    );
    expect(guide3Edge?.targetSymbolId).toBeNull();
    expect(guide3Edge?.confidenceTier).toBe('EXTRACTED');
    expect(guide3Edge?.resolverId).toBeNull();

    const secondPass = resolveDocLinkEdges({
      store,
      repoId: RESOLVER_REPO,
      rootPath: ROOT,
    });
    expect(secondPass).toBe(0); // idempotent — already-resolved edges are excluded by unresolvedOnly
  });
});

describe('doc-link resolver — root-absolute links and dot-dot filenames', () => {
  const RESOLVER_REPO = 'repo-b';
  const ROOT = '/abs';
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;

  function fileFacts(relativePath: string): CodeGraphFileFacts {
    const fileId = fileRowId(RESOLVER_REPO, relativePath);
    const fileSymbol: CodeGraphSymbolRecord = {
      id: symbolRowId(RESOLVER_REPO, fileQualifiedName(relativePath)),
      repositoryId: RESOLVER_REPO,
      fileId,
      kind: 'file',
      name: relativePath.split('/').pop() ?? relativePath,
      qualifiedName: fileQualifiedName(relativePath),
      parentSymbolId: null,
      lineStart: 1,
      lineEnd: 5,
      byteStart: 0,
      byteEnd: 50,
      signature: null,
      exported: false,
      isTest: false,
      extra: {},
    };
    return {
      file: {
        id: fileId,
        repositoryId: RESOLVER_REPO,
        relativePath,
        absolutePath: path.join(ROOT, relativePath),
        language: 'markdown',
        contentHash: 'h',
        sizeBytes: 50,
        mtimeNs: '1',
        lineCount: 5,
        grammarId: 'markdown',
        grammarAbi: null,
        parseStatus: 'parsed',
        hasErrors: false,
        updatedAt: Date.now(),
      },
      symbols: [fileSymbol],
      edges: [],
    };
  }

  function documentingFileFacts(
    relativePath: string,
    targetRef: string,
    line: number,
  ): CodeGraphFileFacts {
    const facts = fileFacts(relativePath);
    const fileId = fileRowId(RESOLVER_REPO, relativePath);
    const sourceSymbolId = symbolRowId(
      RESOLVER_REPO,
      fileQualifiedName(relativePath),
    );
    const edge: CodeGraphEdgeRecord = {
      id: edgeRowId({
        repoId: RESOLVER_REPO,
        kind: 'DOCUMENTS',
        sourceId: sourceSymbolId,
        target: targetRef,
        line,
      }),
      repositoryId: RESOLVER_REPO,
      kind: 'DOCUMENTS',
      sourceSymbolId,
      targetSymbolId: null,
      sourceFileId: fileId,
      targetRef,
      line,
      confidenceTier: 'EXTRACTED',
      confidenceScore: 1.0,
      resolverId: null,
      evidence: { raw: targetRef },
    };
    return { ...facts, edges: [edge] };
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-doclink-abs-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({
      repoId: RESOLVER_REPO,
      rootPath: ROOT,
      gitHead: null,
    });

    store.replaceFileFacts(fileFacts('docs/other.md'));
    store.replaceFileFacts(fileFacts('..weird.md'));
    store.replaceFileFacts(
      documentingFileFacts('docs/root-absolute.md', '/docs/other.md', 3),
    );
    store.replaceFileFacts(
      documentingFileFacts('docs/root-absolute-missing.md', '/missing.md', 3),
    );
    store.replaceFileFacts(
      documentingFileFacts('docs/dotdot-target.md', '../..weird.md', 3),
    );
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('binds a root-absolute (leading-slash) target to the file at that repo-root-relative path', () => {
    resolveDocLinkEdges({ store, repoId: RESOLVER_REPO, rootPath: ROOT });
    const edges = store.listEdges({ kind: 'DOCUMENTS', repoId: RESOLVER_REPO });
    const edge = edges.find(
      (e) =>
        e.sourceFileId === fileRowId(RESOLVER_REPO, 'docs/root-absolute.md'),
    );
    expect(edge?.targetSymbolId).toBe(
      symbolRowId(RESOLVER_REPO, fileQualifiedName('docs/other.md')),
    );
    expect(edge?.confidenceTier).toBe('RESOLVED');
    expect(edge?.resolverId).toBe('doc-link');
  });

  it('leaves a root-absolute target unresolved when no file exists at that repo-root-relative path', () => {
    resolveDocLinkEdges({ store, repoId: RESOLVER_REPO, rootPath: ROOT });
    const edges = store.listEdges({ kind: 'DOCUMENTS', repoId: RESOLVER_REPO });
    const edge = edges.find(
      (e) =>
        e.sourceFileId ===
        fileRowId(RESOLVER_REPO, 'docs/root-absolute-missing.md'),
    );
    expect(edge?.targetSymbolId).toBeNull();
    expect(edge?.confidenceTier).toBe('EXTRACTED');
    expect(edge?.resolverId).toBeNull();
  });

  it('binds a relative target to an in-repo file whose name itself starts with two literal dots', () => {
    resolveDocLinkEdges({ store, repoId: RESOLVER_REPO, rootPath: ROOT });
    const edges = store.listEdges({ kind: 'DOCUMENTS', repoId: RESOLVER_REPO });
    const edge = edges.find(
      (e) =>
        e.sourceFileId === fileRowId(RESOLVER_REPO, 'docs/dotdot-target.md'),
    );
    expect(edge?.targetSymbolId).toBe(
      symbolRowId(RESOLVER_REPO, fileQualifiedName('..weird.md')),
    );
    expect(edge?.confidenceTier).toBe('RESOLVED');
    expect(edge?.resolverId).toBe('doc-link');
  });
});
