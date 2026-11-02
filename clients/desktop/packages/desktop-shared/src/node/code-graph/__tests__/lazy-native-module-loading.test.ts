// Regression guard for the Electron-main boot cost of the code-graph subsystem.
//
// Electron main statically imports the code-graph service transitively (via
// worktree-chat-turn, worktree-data-cleanup, the scheduler, canopy-tools, ...),
// which pulls in engine.ts → ts-module-resolver.ts + parser/runtime.ts. Those
// two modules used to `loadRequiredNodeModule('typescript')` /
// `('web-tree-sitter')` at MODULE EVALUATION, so merely importing the service
// eagerly evaluated the TypeScript compiler (~18MB heap, ~90ms CPU) and the
// web-tree-sitter WASM runtime at boot. They are now loaded lazily on first
// engine use. This test locks that in: importing the service module must NOT
// load either native module, and building a graph must.
import type * as NodeModuleLoader from '@canopy/code-graph/node-module-loader';
import type * as TsModule from 'typescript';

const mockLoadedModuleIds: string[] = [];

// Catch bare imports as well as the packaged loader: a new extractor can
// otherwise bypass the loader spy and silently reintroduce the startup cost.
jest.mock('typescript', () => {
  mockLoadedModuleIds.push('bare-typescript');
  return jest.requireActual<typeof TsModule>('typescript');
});

jest.mock('@canopy/code-graph/node-module-loader', () => {
  const actual = jest.requireActual<typeof NodeModuleLoader>(
    '@canopy/code-graph/node-module-loader',
  );
  return {
    ...actual,
    loadRequiredNodeModule: <T>(options: {
      moduleId: string;
      requireFrom: string;
      validate: (value: unknown) => value is T;
    }): T => {
      mockLoadedModuleIds.push(options.moduleId);
      return actual.loadRequiredNodeModule<T>(options);
    },
  };
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  getCodeGraphWorktreeService,
  resetCodeGraphWorktreeServiceForTests,
  type CodeGraphWorktreeDescriptor,
} from '../service';

// Captured at file-load time, immediately after the `../service` import above,
// so the "import must not load them" assertion is order-independent.
const moduleIdsAfterServiceImport = [...mockLoadedModuleIds];

const LIB = `export function doWork(): number {
  return 42;
}
`;
const MAIN = `import { doWork } from './lib';

export function run(): number {
  return doWork();
}
`;

describe('code-graph native module lazy loading', () => {
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  let dataDirRoot: string;
  let repoDir: string;
  let descriptor: CodeGraphWorktreeDescriptor;

  beforeEach(() => {
    dataDirRoot = mkdtempSync(path.join(tmpdir(), 'code-graph-lazy-load-'));
    process.env.CANOPY_DATA_DIR = path.join(dataDirRoot, 'data');

    repoDir = mkdtempSync(path.join(tmpdir(), 'code-graph-lazy-load-repo-'));
    mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    writeFileSync(path.join(repoDir, 'src', 'lib.ts'), LIB);
    writeFileSync(path.join(repoDir, 'src', 'main.ts'), MAIN);
    writeFileSync(
      path.join(repoDir, 'tsconfig.json'),
      '{ /* JSONC */ "compilerOptions": { "strict": true, }, }',
    );

    descriptor = {
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      repositories: [{ repoId: 'fixture', rootPath: repoDir }],
    };
  });

  afterEach(async () => {
    await resetCodeGraphWorktreeServiceForTests();
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dataDirRoot, { recursive: true, force: true });
    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
  });

  it('does not load typescript or web-tree-sitter when the service module is imported', () => {
    expect(moduleIdsAfterServiceImport).not.toContain('typescript');
    expect(moduleIdsAfterServiceImport).not.toContain('bare-typescript');
    expect(moduleIdsAfterServiceImport).not.toContain('web-tree-sitter');
  });

  it('loads typescript and web-tree-sitter only once a graph is actually built', async () => {
    const service = getCodeGraphWorktreeService();
    // Constructing the service (and checking hasGraph) still must not load the
    // heavy native modules — only an actual build/query does.
    expect(service.hasGraph('ws-1', 'wt-1')).toBe(false);
    expect(mockLoadedModuleIds).not.toContain('typescript');
    expect(mockLoadedModuleIds).not.toContain('web-tree-sitter');

    await service.buildOrUpdate(descriptor);

    expect(mockLoadedModuleIds).toContain('web-tree-sitter');
    expect(mockLoadedModuleIds).toContain('typescript');
  });
});
