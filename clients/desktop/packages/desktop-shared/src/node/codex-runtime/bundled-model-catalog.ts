import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getBundledCodexBinaryPath,
  getEnhancedEnv,
} from '../../pipelines/config-paths';

const execFileAsync = promisify(execFile);
const CATALOG_TIMEOUT_MS = 10_000;
const CATALOG_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * Read the pinned binary's bundled model catalog under runtime-service
 * lifecycle ownership. Callers receive parsed data and validate the shape they
 * need without gaining access to a raw Codex subprocess.
 */
export async function loadBundledCodexModelCatalog(
  signal: AbortSignal,
): Promise<unknown> {
  const { stdout } = await execFileAsync(
    getBundledCodexBinaryPath(),
    ['debug', 'models', '--bundled'],
    {
      encoding: 'utf8',
      env: getEnhancedEnv({
        includeCanopySecrets: false,
        environment: false,
      }),
      timeout: CATALOG_TIMEOUT_MS,
      maxBuffer: CATALOG_MAX_BUFFER_BYTES,
      signal,
    },
  );
  const parsed: unknown = JSON.parse(stdout);
  return parsed;
}
