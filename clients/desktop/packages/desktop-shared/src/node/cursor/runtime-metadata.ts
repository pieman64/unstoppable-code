import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  getCursorRuntimeTarget,
  type CursorRuntimeTarget,
} from '../../lib/cursor-runtime-targets';

/** One pinned, inspected vendor archive for a host target. */
export interface CursorRuntimeArtifact {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly filesSha256: string;
}

type CursorRuntimeConfig = typeof __CANOPY_CURSOR_CLI__;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a manifest `cursor-cli` entry has the shape the build projects. */
function isCursorRuntimeConfig(value: unknown): value is CursorRuntimeConfig {
  if (
    !isRecord(value) ||
    typeof value.version !== 'string' ||
    !isRecord(value.artifacts)
  )
    return false;
  return Object.values(value.artifacts).every(
    (artifact) =>
      isRecord(artifact) &&
      typeof artifact.url === 'string' &&
      typeof artifact.sha256 === 'string' &&
      typeof artifact.archiveBytes === 'number' &&
      typeof artifact.filesSha256 === 'string',
  );
}

function loadCursorRuntimeConfig(): CursorRuntimeConfig {
  // Production bundles replace this identifier at build time so they do not
  // inline or read the whole manifest. Direct source execution through tsx
  // (including the development desktop CLI) has no injected build constants.
  if (typeof __CANOPY_CURSOR_CLI__ !== 'undefined') {
    return __CANOPY_CURSOR_CLI__;
  }

  const packageJsonPath = path.resolve(
    __dirname,
    '../../../../../package.json',
  );
  const packageJson: unknown = JSON.parse(
    readFileSync(packageJsonPath, 'utf8'),
  );
  const entry = isRecord(packageJson) ? packageJson['cursor-cli'] : undefined;
  if (!isCursorRuntimeConfig(entry)) {
    throw new Error(`Cursor runtime metadata missing from ${packageJsonPath}`);
  }
  return entry;
}

// `__CANOPY_CURSOR_CLI__` is the root package.json `cursor-cli` entry projected
// at build time by electron.vite.config.ts, scripts/build-cli.mjs, and
// jest.config.js. Source-mode Node consumers use the same root manifest.
const cursorRuntimeConfig = loadCursorRuntimeConfig();
export const CURSOR_RUNTIME_VERSION: string = cursorRuntimeConfig.version;

/**
 * The supported target for a host, or undefined when nothing is pinned for it.
 * Both halves must agree: a target with no pinned artifact is unusable, and an
 * artifact key with no target has no known launcher or archive format.
 */
export function getCursorRuntimeTargetForHost(
  platform: string = process.platform,
  arch: string = process.arch,
): CursorRuntimeTarget | undefined {
  const target = getCursorRuntimeTarget(platform, arch);
  if (!target || !cursorRuntimeConfig.artifacts[target.key]) return undefined;
  return target;
}

export function getCursorRuntimeArtifact(
  platform: string = process.platform,
  arch: string = process.arch,
): CursorRuntimeArtifact | undefined {
  const target = getCursorRuntimeTarget(platform, arch);
  if (!target) return undefined;
  const artifact = cursorRuntimeConfig.artifacts[target.key];
  return artifact
    ? { version: CURSOR_RUNTIME_VERSION, ...artifact }
    : undefined;
}
