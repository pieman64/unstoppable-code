/**
 * Focused source draft for
 * packages/desktop-shared/src/node/code-graph/__tests__/
 * ts-module-resolver.capture.test.ts.
 *
 * This source is intentionally not executed under the task's text-only grant.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { canonicalRelativePath } from '../ids';
import {
  canonicalResolutionDependencyJson,
  ResolutionDependencyCapture,
} from '../resolve/resolution-dependency-capture';
import type {
  ResolutionCaptureResolver,
  ResolutionDependencyCaptureMetadata,
  ResolutionDependencyCaptureMetadataInput,
  ResolutionDependencyCoverage,
  ResolutionDependencyJson,
  ResolutionDependencyObservation,
  ResolutionDependencySource,
  ResolutionDependencyWriter,
} from '../resolve/resolution-dependency-capture';
import {
  CAPTURED_HOST_OPERATION_PREFIX,
  resolutionInputHostOperationKey,
  resolutionInputHash,
  resolutionInputsChanged,
  resolutionInputsTransferable,
  TsModuleResolver,
} from '../resolve/ts-module-resolver';
import type { ResolutionInputHostOperation } from '../resolve/ts-module-resolver';

const emptyCoverage = (): Readonly<
  Record<ResolutionCaptureResolver, ResolutionDependencyCoverage>
> => ({
  'ts-module-resolution': { rowCount: 0, sourceCount: 0, sha256: '' },
  'config-extends': { rowCount: 0, sourceCount: 0, sha256: '' },
  'doc-link': { rowCount: 0, sourceCount: 0, sha256: '' },
  'ipc-channel': { rowCount: 0, sourceCount: 0, sha256: '' },
  'workflow-action': { rowCount: 0, sourceCount: 0, sha256: '' },
  'call-resolution': { rowCount: 0, sourceCount: 0, sha256: '' },
  'test-linker': { rowCount: 0, sourceCount: 0, sha256: '' },
});

class NoopDependencyWriter implements ResolutionDependencyWriter {
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
    void repoId;
    void source;
    void observations;
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
    return { ...metadata, dependencyCoverage: emptyCoverage() };
  }
}

function fingerprint(value: ResolutionDependencyJson): string {
  const json = canonicalResolutionDependencyJson(value);
  return createHash('sha256').update(json).digest('hex');
}

function oneInput(key: string, value: ResolutionDependencyJson): string {
  return JSON.stringify({ [key]: fingerprint(value) });
}

describe('TypeScript resolver host-operation fingerprints', () => {
  let tempRoot: string;
  let root: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'ts-resolution-capture-'));
    root = path.join(tempRoot, 'repo');
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('keeps the uncaptured resolver on the legacy host/fingerprint path', () => {
    const sourcePath = path.join(root, 'src', 'main.ts');
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, 'export {}\n');
    writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{}}');

    const resolver = new TsModuleResolver(root);
    resolver.resolveSpecifierWithKind('missing-package', sourcePath);
    const fingerprints = resolver.getInputFingerprints();

    expect(
      Object.keys(fingerprints).some((key) =>
        key.startsWith(CAPTURED_HOST_OPERATION_PREFIX),
      ),
    ).toBe(false);
    expect(
      Object.keys(fingerprints).some((key) => key.startsWith('file-exists:')),
    ).toBe(true);
  });

  it('captures compiler host operation keys when source-scoped capture is enabled', () => {
    const sourcePath = path.join(root, 'src', 'main.ts');
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, 'export {}\n');
    writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{}}');

    const capture = new ResolutionDependencyCapture(
      'public-repo-id',
      root,
      new NoopDependencyWriter(),
    );
    capture.beginResolver('ts-module-resolution');
    const endSource = capture.beginSource({
      sourceFileId: 'file:main',
      sourceEdgeId: 'edge:import',
    });
    const resolver = new TsModuleResolver(root, capture);
    resolver.resolveSpecifierWithKind(
      'missing-package',
      sourcePath,
      'file:main',
    );
    endSource();
    capture.finishResolver('ts-module-resolution');

    expect(
      Object.keys(resolver.getInputFingerprints()).some((key) =>
        key.startsWith(CAPTURED_HOST_OPERATION_PREFIX),
      ),
    ).toBe(true);
  });

  it('invalidates an external readDirectory fingerprint when parent-directory membership changes', async () => {
    const externalDirectory = path.join(tempRoot, 'shared-types');
    mkdirSync(externalDirectory);
    const operation: ResolutionInputHostOperation = {
      operation: 'readDirectory',
      root: '../shared-types',
      extensions: ['.d.ts'],
      excludes: [],
      includes: [],
      depth: null,
    };
    const key = resolutionInputHostOperationKey(operation);
    const saved = oneInput(key, []);

    expect(await resolutionInputsChanged(root, saved)).toBe(false);
    writeFileSync(path.join(externalDirectory, 'added.d.ts'), 'export {};\n');
    expect(await resolutionInputsChanged(root, saved)).toBe(true);
  });

  it('invalidates node_modules getDirectories fingerprints when a package directory disappears', async () => {
    const packageDirectory = path.join(root, 'node_modules', 'pkg');
    mkdirSync(packageDirectory, { recursive: true });
    const operation: ResolutionInputHostOperation = {
      operation: 'getDirectories',
      path: 'node_modules',
    };
    const key = resolutionInputHostOperationKey(operation);
    const saved = oneInput(
      key,
      ts.sys
        .getDirectories(path.join(root, 'node_modules'))
        .map((name) => canonicalRelativePath(path.relative(root, name))),
    );

    expect(await resolutionInputsChanged(root, saved)).toBe(false);
    rmSync(packageDirectory, { recursive: true, force: true });
    expect(await resolutionInputsChanged(root, saved)).toBe(true);
  });

  it('replays the realpath host operation to notice a changed package symlink', async () => {
    const firstTarget = path.join(root, 'packages', 'first');
    const secondTarget = path.join(root, 'packages', 'second');
    const linkPath = path.join(root, 'node_modules', 'alias');
    mkdirSync(firstTarget, { recursive: true });
    mkdirSync(secondTarget, { recursive: true });
    mkdirSync(path.dirname(linkPath), { recursive: true });
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(firstTarget, linkPath, symlinkType);
    const operation: ResolutionInputHostOperation = {
      operation: 'realpath',
      path: 'node_modules/alias',
    };
    const key = resolutionInputHostOperationKey(operation);
    const saved = oneInput(
      key,
      canonicalRelativePath(path.relative(root, realpathSync(firstTarget))),
    );

    expect(await resolutionInputsChanged(root, saved)).toBe(false);
    rmSync(linkPath, { recursive: true, force: true });
    symlinkSync(secondTarget, linkPath, symlinkType);
    expect(await resolutionInputsChanged(root, saved)).toBe(true);
  });

  it('refuses to transfer new host operation keys to a different root', () => {
    const key = resolutionInputHostOperationKey({
      operation: 'getDirectories',
      path: '../node_modules',
    });
    const saved = oneInput(key, []);
    expect(resolutionInputsTransferable(saved, root, `${root}-copy`)).toBe(
      false,
    );
    expect(resolutionInputHash('legacy-value')).toBeTruthy();
  });
});
