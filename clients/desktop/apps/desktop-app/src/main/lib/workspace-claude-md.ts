import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
 * the local per-workspace copy. Shared by the renderer IPC handlers and the
 * browser Remote Control portal adapter so the two surfaces cannot drift.
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
  const { filePath } = await resolveWorkspaceClaudeMdTarget(workspaceId);
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    // A missing file is the normal "no CLAUDE.md yet" case → empty string. Any
    // OTHER read error (permissions, I/O) MUST propagate so callers can tell
    // "empty" apart from "couldn't read". The portal small-RPC get relies on
    // this: a failed read then fails the command (no synchronous result) instead
    // of surfacing as a confirmed-empty result the editor could Save back,
    // overwriting the real file.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
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
  const target = await resolveWorkspaceClaudeMdTarget(workspaceId);
  await mkdir(dirname(target.filePath), { recursive: true });
  await writeProjectInstructionFile(target, content);
  recordWorkspaceCrudTelemetry({
    action: 'update',
    workspaceId,
    source: telemetrySource,
  });
}
