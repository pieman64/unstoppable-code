import * as fs from 'node:fs/promises';
import path from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { getCursorRuntimeTargetForHost } from '@canopy/desktop-shared/node/cursor/runtime-metadata';
import { getCopilotRuntimeArtifact } from '@canopy/desktop-shared/node/copilot/runtime-metadata';
import { getOpenCodeRuntimeArtifact } from '@canopy/desktop-shared/node/opencode/runtime-metadata';
import { getBundledCodexBinaryPath } from '../../pipelines/config-paths';

/** No static runtime pin exists for this provider on the host (e.g. Linux
 * Cursor/Copilot/OpenCode). */
export const DELEGATION_RUNTIME_NO_PIN_REASON =
  'This provider has no pinned managed runtime for Linux. Choose another provider.';

/** The bundled Linux sandbox helper the pinned Codex runtime shells out to is
 * absent or unusable. Actionable, user-facing copy; developer restaging steps
 * live in docs. */
export const DELEGATION_RUNTIME_CODEX_SANDBOX_MISSING_REASON =
  'The bundled Linux sandbox helper for the managed runtime is missing or invalid. Reinstall the app to restore it.';

/**
 * Static pin and prerequisite availability only; never installs a runtime,
 * probes an account, runs the sandbox, or changes host AppArmor. Returns an
 * actionable unavailable reason, or undefined when the host prerequisites for
 * the harness are present. On non-Linux hosts every harness is available here.
 */
export async function delegationRuntimeUnavailableReason(
  harness: string,
): Promise<string | undefined> {
  const platform = hostOperatingSystem();
  if (platform !== 'linux') return undefined;
  if (harness === 'codex')
    return (await linuxCodexSandboxHelperStaged())
      ? undefined
      : DELEGATION_RUNTIME_CODEX_SANDBOX_MISSING_REASON;
  const pinned =
    harness === 'cursor'
      ? getCursorRuntimeTargetForHost(platform, process.arch)
      : harness === 'copilot'
        ? getCopilotRuntimeArtifact(platform, process.arch)
        : harness === 'opencode'
          ? getOpenCodeRuntimeArtifact(platform, process.arch)
          : true;
  return pinned ? undefined : DELEGATION_RUNTIME_NO_PIN_REASON;
}

/**
 * The pinned Linux Codex runtime shells out to a bundled `bwrap` staged beside
 * the resolved Codex binary. This checks that prerequisite's presence only — a
 * fixed, non-empty, executable regular file at the sibling path, never a
 * symlink or hard link — matching the staged helper contract. No host-PATH
 * fallback and no arg0 alias checks; native sandbox enforcement happens after
 * launch.
 */
async function linuxCodexSandboxHelperStaged(): Promise<boolean> {
  try {
    const codex = await fs.realpath(getBundledCodexBinaryPath());
    const bwrap = path.join(path.dirname(codex), 'bwrap');
    const stat = await fs.lstat(bwrap);
    return (
      stat.isFile() &&
      stat.nlink === 1 &&
      stat.size > 0 &&
      (stat.mode & 0o111) !== 0
    );
  } catch {
    return false;
  }
}
