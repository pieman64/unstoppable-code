import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';

const configPathsModule = await tsImport(
  '../../../../../packages/desktop-shared/src/pipelines/config-paths.ts',
  import.meta.url,
);
const { getBundledCodexBinaryPath } =
  configPathsModule.default ?? configPathsModule;

function getStagedCodexBinaryPath() {
  const previousCanopyEnv = process.env.CANOPY_ENV;
  process.env.CANOPY_ENV = 'development';
  try {
    return getBundledCodexBinaryPath();
  } finally {
    if (previousCanopyEnv === undefined) {
      delete process.env.CANOPY_ENV;
    } else {
      process.env.CANOPY_ENV = previousCanopyEnv;
    }
  }
}

/** Initialize fresh fixture schemas before foreground/background clients race. */
export function initializeIsolatedCodexState(userDataDir) {
  // No thread or turn is started, and the real provider state is never used.
  const providerDir = path.join(userDataDir, 'provider-state', 'codex');
  mkdirSync(providerDir, { recursive: true });
  const binary = getStagedCodexBinaryPath();
  execFileSync(binary, ['app-server'], {
    cwd: userDataDir,
    env: { ...process.env, CODEX_HOME: providerDir },
    input: `${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'canopy-e2e', version: '1' } } })}\n`,
    timeout: 15_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
