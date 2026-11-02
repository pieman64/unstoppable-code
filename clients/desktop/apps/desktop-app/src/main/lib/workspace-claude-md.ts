import { mkdir, readFile } from 'node:fs/promises';
import {
  readInstructionTarget,
  writeInstructionTarget,
} from '@canopy/core-runtime/node/workspace/workspace-instructions';
import { recordWorkspaceCrudTelemetry } from './desktop-telemetry';
import {
  resolveProjectInstructionFile,
  writeProjectInstructionFile,
} from './instruction-files';
import { getWorkspaceClaudeMdPath } from './paths';
import { validateId } from './validation';
import { readWorkspaceConfig } from './workspace-persistence';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';

interface WorkspaceClaudeMdTarget {
  filePath: string;
  mirrorPath?: string;
}

/**
 * Resolve where a workspace's editable instructions live. For a source-backed
 * workspace this preserves the attached source repo's instruction file; otherwise it is
 * the local per-workspace copy. This is the trusted host port behind
 * `core.workspace.instructions.*`; interfaces reach it through the dispatcher.
 */
async function resolveWorkspaceClaudeMdTarget(
  workspaceId: string,
): Promise<WorkspaceClaudeMdTarget> {
  validateId(workspaceId, 'workspaceId');
  const config = await readWorkspaceConfig(workspaceId);
  const referenceRepoPath = config.sourceRepoPath
    ? await resolveWorkspaceReferenceRepoPath(config.sourceRepoPath)
    : undefined;
  return config.sourceRepoPath
    ? resolveProjectInstructionFile(referenceRepoPath ?? config.sourceRepoPath)
    : { filePath: getWorkspaceClaudeMdPath(workspaceId) };
}

/**
 * Read a workspace's instructions. Returns an empty string when the file does
 * not exist yet (never throws for a missing file).
 */
export async function loadWorkspaceClaudeMd(
  workspaceId: string,
): Promise<string> {
  return readInstructionTarget(
    await resolveWorkspaceClaudeMdTarget(workspaceId),
    { readText: (path) => readFile(path, 'utf8') },
  );
}

/**
 * Write a workspace's instructions (creating the directory as needed), keeping
 * existing aliases and synchronized copies for source-backed workspaces, and recording
 * update telemetry. `telemetrySource` distinguishes the caller (`claude_md` for
 * the renderer, `portal` for the browser Remote Control).
 */
export async function saveWorkspaceClaudeMd(
  workspaceId: string,
  content: string,
  telemetrySource: string,
): Promise<void> {
  await writeInstructionTarget(
    await resolveWorkspaceClaudeMdTarget(workspaceId),
    content,
    {
      ensureDirectory: async (path) => {
        await mkdir(path, { recursive: true });
      },
      writeTarget: writeProjectInstructionFile,
    },
  );
  recordWorkspaceCrudTelemetry({
    action: 'update',
    workspaceId,
    source: telemetrySource,
  });
}
