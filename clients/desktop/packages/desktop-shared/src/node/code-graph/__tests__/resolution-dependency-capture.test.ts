/**
 * Focused source draft for
 * packages/desktop-shared/src/node/code-graph/__tests__/
 * resolution-dependency-capture.test.ts.
 *
 * Text only: the enclosing task explicitly prohibited execution/checks/tests.
 */
import {
  RESOLUTION_CAPTURE_RESOLVERS,
  ResolutionDependencyCapture,
  resolutionDependencyKey,
} from '../resolve/resolution-dependency-capture';
import type {
  ResolutionCaptureResolver,
  ResolutionDependencyCaptureMetadata,
  ResolutionDependencyCaptureMetadataInput,
  ResolutionDependencyCoverage,
  ResolutionDependencyObservation,
  ResolutionDependencyRecord,
  ResolutionDependencySource,
  ResolutionDependencyWriter,
} from '../resolve/resolution-dependency-capture';

const REPO_ID = 'repo-public-id';
const ROOT_PATH = '/workspace/repo';

function sourceIdentity(source: ResolutionDependencySource): string {
  return [source.resolver, source.sourceFileId, source.sourceEdgeId].join(
    '\u0000',
  );
}

class MemoryDependencyWriter implements ResolutionDependencyWriter {
  private readonly records = new Map<string, ResolutionDependencyRecord>();

  public beginResolver(
    repoId: string,
    resolver: ResolutionCaptureResolver,
    sourceFileIds: readonly string[] | undefined,
  ): void {
    void repoId;
    void resolver;
    void sourceFileIds;
  }

  public replaceSource(
    repoId: string,
    source: ResolutionDependencySource,
    observations: readonly ResolutionDependencyObservation[],
  ): void {
    const scope = sourceIdentity(source);
    for (const [key, record] of Array.from(this.records)) {
      if (sourceIdentity(record) === scope) this.records.delete(key);
    }
    for (const observation of observations) {
      const record: ResolutionDependencyRecord = {
        repositoryId: repoId,
        ...source,
        dependencyKind: observation.dependencyKind,
        dependencyKey: observation.dependencyKey,
        dependencyValue: observation.dependencyValue,
      };
      const key = [
        record.resolver,
        record.sourceFileId,
        record.sourceEdgeId,
        record.dependencyKind,
        record.dependencyKey,
      ].join('\u0000');
      this.records.set(key, record);
    }
  }

  public finishResolver(
    repoId: string,
    resolver: ResolutionCaptureResolver,
    sourceFileIds: readonly string[] | undefined,
  ): void {
    void repoId;
    void resolver;
    void sourceFileIds;
  }

  public writeMetadata(
    repoId: string,
    metadata: ResolutionDependencyCaptureMetadataInput,
  ): ResolutionDependencyCaptureMetadata {
    void repoId;
    return {
      ...metadata,
      dependencyCoverage: {
        'ts-module-resolution': this.coverage('ts-module-resolution'),
        'config-extends': this.coverage('config-extends'),
        'doc-link': this.coverage('doc-link'),
        'ipc-channel': this.coverage('ipc-channel'),
        'workflow-action': this.coverage('workflow-action'),
        'call-resolution': this.coverage('call-resolution'),
        'test-linker': this.coverage('test-linker'),
      },
    };
  }

  public listRecords(): readonly ResolutionDependencyRecord[] {
    return Array.from(this.records.values());
  }

  private coverage(
    resolver: ResolutionCaptureResolver,
  ): ResolutionDependencyCoverage {
    const rows = this.listRecords().filter(
      (record) => record.resolver === resolver,
    );
    const sources = new Set(
      rows.map((record) =>
        [record.sourceFileId, record.sourceEdgeId].join('\u0000'),
      ),
    );
    return {
      rowCount: rows.length,
      sourceCount: sources.size,
      sha256: 'test-only',
    };
  }
}

function fullCapture(
  writer: MemoryDependencyWriter,
): ResolutionDependencyCaptureMetadata {
  const capture = new ResolutionDependencyCapture(REPO_ID, ROOT_PATH, writer);
  for (const resolver of RESOLUTION_CAPTURE_RESOLVERS) {
    capture.beginResolver(resolver);
    const endSource = capture.beginSource({
      sourceFileId: `src/${resolver}.ts`,
      sourceEdgeId: `edge-${resolver}`,
    });
    recordPositiveAndNegativeInputs(capture, resolver);
    endSource();
    capture.finishResolver(resolver);
  }
  return capture.finishRepository().metadata;
}

function recordPositiveAndNegativeInputs(
  capture: ResolutionDependencyCapture,
  resolver: ResolutionCaptureResolver,
): void {
  switch (resolver) {
    case 'ts-module-resolution':
      capture.observe(
        resolutionDependencyKey.tsReadInput('tsconfig.json'),
        'sha256:config',
      );
      capture.observe(
        resolutionDependencyKey.tsFileExists('node_modules/missing.d.ts'),
        false,
      );
      capture.observe(resolutionDependencyKey.tsDirectoryExists('src'), true);
      capture.observe(
        resolutionDependencyKey.moduleSpecifier(
          'src/importer.ts',
          'missing-lib',
        ),
        {
          kind: 'unresolved',
        },
      );
      capture.observe(resolutionDependencyKey.moduleCandidate('src/found.ts'), {
        fileId: 'file-found',
      });
      capture.observe(
        resolutionDependencyKey.compilerOptions('tsconfig.json'),
        {
          moduleResolution: 'Bundler',
        },
      );
      break;
    case 'config-extends':
      capture.observe(
        resolutionDependencyKey.configTarget('configs/missing.json'),
        null,
      );
      capture.observe(
        resolutionDependencyKey.configTarget('configs/base.json'),
        { symbolId: 'config-base' },
      );
      break;
    case 'doc-link':
      capture.observe(
        resolutionDependencyKey.docPathFragment(
          'docs/missing.md',
          'missing-heading',
        ),
        null,
      );
      capture.observe(
        resolutionDependencyKey.docPathFragment('docs/guide.md', 'setup'),
        { symbolId: 'guide' },
      );
      break;
    case 'ipc-channel':
      capture.observe(
        resolutionDependencyKey.ipcNamespace('all', 'not-declared'),
        [],
      );
      capture.observe(resolutionDependencyKey.ipcNamespace('main', 'save'), [
        { symbolId: 'channel-a', registry: 'main' },
        { symbolId: 'channel-b', registry: 'legacy' },
      ]);
      break;
    case 'workflow-action':
      capture.observe(resolutionDependencyKey.workflowAction('owner/repo@v1'), {
        disposition: 'external',
      });
      capture.observe(
        resolutionDependencyKey.workflowManifest(
          '.github/actions/missing/action.yml',
        ),
        null,
      );
      capture.observe(
        resolutionDependencyKey.workflowManifest(
          '.github/actions/local/action.yaml',
        ),
        {
          symbolId: 'action-manifest',
        },
      );
      break;
    case 'call-resolution':
      capture.observe(resolutionDependencyKey.moduleImports('src/caller.ts'), [
        { specifier: './barrel', resolvedPath: 'src/barrel.ts' },
      ]);
      capture.observe(resolutionDependencyKey.moduleSymbols('src/caller.ts'), [
        { qualifiedName: 'src/caller.ts::caller' },
      ]);
      capture.observe(
        resolutionDependencyKey.exportedName('src/barrel.ts', 'MissingAlias'),
        [],
      );
      capture.observe(
        resolutionDependencyKey.exportedName('src/barrel.ts', 'Run'),
        [{ symbolId: 'export-run', via: ['src/barrel.ts', 'src/lib.ts'] }],
      );
      capture.observe(
        resolutionDependencyKey.moduleCandidate('src/absent.ts'),
        null,
      );
      break;
    case 'test-linker':
      capture.observe(
        resolutionDependencyKey.testCallCandidate(
          'tests/a.test.ts',
          'call-edge-unresolved',
        ),
        {
          targetSymbolId: null,
          sourceIsTest: true,
          targetIsTest: null,
          targetFound: false,
        },
      );
      capture.observe(
        resolutionDependencyKey.symbolsForFile('src/production.ts'),
        [{ id: 'production-entry', isTest: false }],
      );
      capture.observe(
        resolutionDependencyKey.symbolsForFile('tests/a.test.ts'),
        [{ id: 'test-file-symbol', isTest: true }],
      );
      break;
  }
}

describe('resolution dependency capture', () => {
  it('persists positive and negative observations for all seven families', () => {
    const writer = new MemoryDependencyWriter();
    const metadata = fullCapture(writer);
    const records = writer.listRecords();
    const keysByKind = new Set(records.map((record) => record.dependencyKind));

    expect(metadata.complete).toBe(true);
    expect(metadata.incompleteResolvers).toEqual([]);
    expect(RESOLUTION_CAPTURE_RESOLVERS).toHaveLength(7);
    expect(
      records.filter(
        (record) => record.dependencyKind === 'capture-source-coverage',
      ),
    ).toHaveLength(7);
    expect(keysByKind.has('ts-file-exists')).toBe(true);
    expect(keysByKind.has('config-target')).toBe(true);
    expect(keysByKind.has('doc-path-fragment')).toBe(true);
    expect(keysByKind.has('ipc-channel-candidate-set')).toBe(true);
    expect(keysByKind.has('workflow-manifest-candidate-set')).toBe(true);
    expect(keysByKind.has('export-candidate-set')).toBe(true);
    expect(keysByKind.has('test-call-candidate-set')).toBe(true);
    expect(records.some((record) => record.dependencyValue === false)).toBe(
      true,
    );
    expect(
      records.some(
        (record) =>
          Array.isArray(record.dependencyValue) &&
          record.dependencyValue.length === 0,
      ),
    ).toBe(true);
    expect(records.some((record) => record.dependencyValue === null)).toBe(
      true,
    );
  });

  it('replays observations captured before a cache hit into the next source scope', () => {
    const writer = new MemoryDependencyWriter();
    const capture = new ResolutionDependencyCapture(REPO_ID, ROOT_PATH, writer);
    capture.beginResolver('call-resolution');
    const endFirst = capture.beginSource({
      sourceFileId: 'src/a.ts',
      sourceEdgeId: 'edge-a',
    });
    const checkpoint = capture.checkpoint();
    capture.observe(
      resolutionDependencyKey.exportedName('src/barrel.ts', 'Run'),
      [{ symbolId: 'run-id' }],
    );
    const cached = capture.observationsSince(checkpoint);
    endFirst();

    const endSecond = capture.beginSource({
      sourceFileId: 'src/b.ts',
      sourceEdgeId: 'edge-b',
    });
    capture.replay([
      ...cached,
      {
        dependencyKind: 'capture-source-coverage',
        dependencyKey: 'stale-cache-sentinel',
        dependencyValue: true,
      },
    ]);
    endSecond();
    capture.finishResolver('call-resolution');

    const replayed = writer
      .listRecords()
      .filter(
        (record) =>
          record.sourceFileId === 'src/b.ts' &&
          record.dependencyKind === 'export-candidate-set',
      );
    expect(replayed).toHaveLength(1);
    expect(
      writer
        .listRecords()
        .filter(
          (record) =>
            record.sourceFileId === 'src/b.ts' &&
            record.dependencyKind === 'capture-source-coverage',
        ),
    ).toHaveLength(1);
    expect(replayed[0]?.dependencyKey).toBe(
      resolutionDependencyKey.exportedName('src/barrel.ts', 'Run')
        .dependencyKey,
    );
  });

  it('requires a compatible complete prior plus closure proof for partial resolver passes', () => {
    const priorWriter = new MemoryDependencyWriter();
    const prior = fullCapture(priorWriter);
    const trustedPrior = { metadata: prior, closureComplete: true };

    const incrementalWriter = priorWriter;
    const incremental = new ResolutionDependencyCapture(
      REPO_ID,
      ROOT_PATH,
      incrementalWriter,
      trustedPrior,
    );
    for (const resolver of RESOLUTION_CAPTURE_RESOLVERS) {
      incremental.beginResolver(resolver, ['src/changed.ts']);
      incremental.finishResolver(resolver, ['src/changed.ts']);
    }
    expect(incremental.finishRepository().metadata.complete).toBe(true);

    const unsafeWriter = new MemoryDependencyWriter();
    const unsafe = new ResolutionDependencyCapture(
      REPO_ID,
      ROOT_PATH,
      unsafeWriter,
      { metadata: prior, closureComplete: false },
    );
    for (const resolver of RESOLUTION_CAPTURE_RESOLVERS) {
      unsafe.beginResolver(resolver, ['src/changed.ts']);
      unsafe.finishResolver(resolver, ['src/changed.ts']);
    }
    expect(unsafe.finishRepository().metadata.complete).toBe(false);
  });

  it('marks every unwrapped or unlocalizable host observation incomplete', () => {
    const writer = new MemoryDependencyWriter();
    const capture = new ResolutionDependencyCapture(REPO_ID, ROOT_PATH, writer);
    for (const resolver of RESOLUTION_CAPTURE_RESOLVERS) {
      capture.beginResolver(resolver);
      const endSource = capture.beginSource({
        sourceFileId: `src/${resolver}.ts`,
        sourceEdgeId: 'edge',
      });
      if (resolver === 'ts-module-resolution') {
        capture.markIncompleteForCurrent('typescript-realpath-unavailable');
      }
      endSource();
      capture.finishResolver(resolver);
    }
    const metadata = capture.finishRepository().metadata;
    expect(metadata.complete).toBe(false);
    expect(metadata.incompleteResolvers).toContain('ts-module-resolution');
    expect(metadata.reasonsByResolver['ts-module-resolution']).toContain(
      'typescript-realpath-unavailable',
    );
  });
});
