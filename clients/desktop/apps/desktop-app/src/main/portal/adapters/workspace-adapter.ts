import { W5_UNREACHABLE_READ_MESSAGE } from '@canopy/core-runtime/node/w5/file-store';
import {
  normalizeRepositoryCloneUrl,
  REPOSITORY_CLONE_FAILURE_MESSAGE,
} from '@canopy/protocol/portal';
import {
  IPC_CHANNELS,
  type PortalCommandEnvelope,
  type PortalCommandPayloadMap,
} from '@canopy/desktop-shared/types';
import { describeProjectDeletionDiscard } from '../../lib/project-deletion-discard';
import { deleteWorkspaceById } from '../../lib/workspace-deletion';
import {
  reorderWorkspaces,
  updateWorkspaceMetadata,
  WorkspaceMetadataRefusedError,
} from '../../lib/workspace-metadata';
import { createWorkspace } from '../../lib/workspace-creation';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { getDefaultReposDir } from '../../lib/paths';
import { readPreferencesFile } from '../../lib/preferences-store';
import {
  readPortalSidebarItems,
  readPortalWorkspaceInstructions,
  writePortalWorkspaceInstructions,
  readPortalWorkspaceScriptCommands,
  savePortalWorkspaceScriptCommands,
} from '../portal-workspace-reads';
import { validateId } from '../../lib/validation';
import { sendToWindow } from '../../lib/window-send';
import { markPortalWorkspaceCreateStarted } from '../portal-state-store';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';

/**
 * Notify the desktop renderer that a portal-initiated workspace-level mutation
 * (create/delete/rename/recolor/reorder) changed the persisted sidebar state.
 * The renderer never initiated the write, so without this the desktop sidebar
 * goes stale until an unrelated full reload (CAN-1304). The workspace-id-only
 * `workspaceWorktreesUpdated` event deliberately carries no worktree payload:
 * the renderer's unmatched-event fallback runs a debounced, silent full
 * projects reload, which also picks up workspaces it has never seen (create)
 * and drops removed ones (delete).
 */
function notifyRendererWorkspacesChanged(
  context: PortalAdapterContext,
  workspaceId: string,
): void {
  sendToWindow(
    context.getWindow?.() ?? null,
    IPC_CHANNELS.workspaceWorktreesUpdated,
    { workspaceId },
  );
}

function isPortalVisibleWorkspace(
  item: Awaited<ReturnType<typeof readPortalSidebarItems>>['items'][number],
  hiddenWorkspaceIds: ReadonlySet<string>,
): boolean {
  if (item.type === 'cowork' || hiddenWorkspaceIds.has(item.id)) return false;
  if (item.alwaysShow !== false) return true;
  return item.worktrees.some((worktree) => worktree.hidden !== true);
}

/** Persist a visible-workspace drag move while preserving non-visible slots. */
export async function handlePortalWorkspaceReorder(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.activeWorkspaceId !== 'string' ||
    typeof payload.overWorkspaceId !== 'string'
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid project reorder payload: activeWorkspaceId and overWorkspaceId are required.',
    );
    return;
  }

  try {
    validateId(payload.activeWorkspaceId, 'activeWorkspaceId');
    validateId(payload.overWorkspaceId, 'overWorkspaceId');
    const [sidebarItems, preferences] = await settleAll([
      readPortalSidebarItems(),
      readPreferencesFile(),
    ]);
    if (sidebarItems.stale) throw new Error(W5_UNREACHABLE_READ_MESSAGE);
    const hiddenWorkspaceIds = new Set(
      preferences.worktreeFilterHiddenWorkspaceIds ?? [],
    );
    await reorderWorkspaces({
      visibleWorkspaceIds: sidebarItems.items
        .filter((item) => isPortalVisibleWorkspace(item, hiddenWorkspaceIds))
        .map((item) => item.id),
      activeWorkspaceId: payload.activeWorkspaceId,
      overWorkspaceId: payload.overWorkspaceId,
    });
    notifyRendererWorkspacesChanged(context, payload.activeWorkspaceId);
    context.complete(command, {
      activeWorkspaceId: payload.activeWorkspaceId,
      overWorkspaceId: payload.overWorkspaceId,
    });
  } catch (error) {
    if (
      error instanceof WorkspaceMetadataRefusedError &&
      error.reason === 'not-found'
    ) {
      context.fail(command, 'not_found', error.message);
      return;
    }
    failServiceError(command, context, error);
  }
}

/**
 * A browser-supplied remote must look like a REMOTE git URL before we hand it
 * to `git clone`: an explicit remote scheme (`https`, `http`, `git`, `ssh`) or
 * scp-like `user@host:path`. Local-filesystem forms — bare paths AND the
 * `file://` scheme — are rejected: a paired browser must not be able to clone
 * arbitrary local content off the desktop. (The desktop's own remote-add is
 * less strict, but it is driven by a trusted local UI, not an untrusted
 * browser.)
 */
function isPlausibleGitRemoteUrl(remoteUrl: string): boolean {
  const value = remoteUrl.trim();
  if (value.length === 0) return false;
  // Reject anything that could be parsed as a `git clone` option (argument
  // injection, e.g. `--upload-pack=...`, which the scp-like pattern below would
  // otherwise admit). Defense-in-depth alongside the `--` separator in
  // `cloneRepo`.
  if (value.startsWith('-')) return false;
  // Note: an `ssh://-oProxyCommand=...`-style host (CVE-2017-1000117 class) is
  // intentionally left to git's own protection (bundled git postdates the fix),
  // not re-validated here — this guard is not meant to be an exhaustive git/ssh
  // option filter, only to reject option-looking remotes at the browser edge.
  if (/^(https?|git|ssh):\/\//i.test(value)) return true;
  // scp-like syntax, e.g. git@github.com:org/repo.git
  if (/^[^\s/@]+@[^\s/:]+:.+$/.test(value)) return true;
  return false;
}

/**
 * Handle `portal.workspace.create` — create a new workspace from the browser
 * Remote Control sidebar, mirroring the desktop "add project" modal.
 *
 * Only the `remote-clone` mode is exposed: it clones a git repo by URL via the
 * workspace creation boundary ({@link createWorkspace}). The browser cannot
 * pick a clone destination, so the desktop resolves the default repos directory
 * itself and the service derives the workspace name from the repo (same as the
 * desktop remote-add flow). The `cowork` mode is deferred (CAN-1199) because a
 * freshly-created cowork workspace does not yet surface in the portal standalone
 * rail; the desktop's "add existing local folder" mode is impossible from a
 * browser.
 *
 * Creation is additive, so this is NOT gated by the destructive-actions flag
 * (matching `portal.worktree.create`). The browser refreshes the workspace list
 * by requesting a fresh `overview` snapshot right after this command (portal
 * commands are processed serially, so the snapshot includes the new workspace).
 */
export async function handlePortalWorkspaceCreate(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.workspace.create']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  // The payload is browser-supplied and only shape/size-validated in transit,
  // so re-validate the discriminated fields here (read through `unknown` so the
  // guards are real runtime checks, not type-narrowed no-ops).
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    payload.kind !== 'remote-clone' ||
    typeof payload.remoteUrl !== 'string' ||
    !isPlausibleGitRemoteUrl(payload.remoteUrl)
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid project create payload: expected { kind: "remote-clone", remoteUrl } with a remote git URL (https/http/git/ssh scheme or user@host:path).',
    );
    return;
  }
  const remoteUrl = normalizeRepositoryCloneUrl(payload.remoteUrl);

  // Keep this claim through completion reporting and the completion-to-cursor
  // crash window. The state store removes it only with durable acknowledgement.
  let started: boolean;
  try {
    if (!context.sessionId) throw new Error('No active clone session');
    started = await markPortalWorkspaceCreateStarted({
      sessionId: context.sessionId,
      commandId: command.id,
      sequence: command.sequence,
    });
  } catch {
    context.fail(
      command,
      'execution_failed',
      'Could not confirm the clone request on the desktop. Check Projects before trying again.',
      false,
    );
    return;
  }
  if (!started) {
    context.fail(
      command,
      'execution_failed',
      'The desktop restarted before the clone result was confirmed. Check Projects before trying again.',
      false,
    );
    return;
  }

  let workspace: SidebarItem;
  let scriptActionsOperationId: string | undefined;
  try {
    // The browser cannot pick a clone destination; resolve the desktop's
    // default repos directory here (the service mkdir's it and derives the
    // workspace name from the repo URL).
    ({ workspace, scriptActionsOperationId } = await createWorkspace({
      source: 'portal',
      variant: {
        kind: 'remote-clone',
        remoteUrl,
        destinationDir: getDefaultReposDir(),
      },
    }));
  } catch {
    // Do NOT forward the raw error to the browser: `git clone` failures embed
    // the absolute clone-destination path (e.g. "could not create work tree dir
    // '<dataDir>/repos/...'"). Report a generic message instead. Richer,
    // path-free failure feedback is tracked in CAN-1200.
    context.fail(
      command,
      'execution_failed',
      REPOSITORY_CLONE_FAILURE_MESSAGE,
      false,
    );
    return;
  }
  notifyRendererWorkspacesChanged(context, workspace.id);
  // Reporting errors are not clone failures. Never erase the invocation claim
  // or tell the browser to retry a clone that may already have succeeded.
  context.complete(command, {
    workspaceId: workspace.id,
    ...(scriptActionsOperationId ? { scriptActionsOperationId } : {}),
  });
}

/**
 * Handle `portal.workspace.delete` — delete an entire workspace (project) from
 * the browser Remote Control sidebar, mirroring the desktop sidebar's
 * delete-workspace action. This is IRREVERSIBLE (removes the persisted
 * workspace directory: every worktree checkout, chat, and summary, or
 * detaches an external cowork folder). Workspace removal is a first-class,
 * always-available portal action: it is NOT in the flag-gated
 * `PORTAL_DESTRUCTIVE_COMMAND_TYPES` set, so the browser guards it with a
 * confirmation dialog rather than the `canopy-portal-destructive-actions` flag.
 *
 * Reuses the exact same {@link deleteWorkspaceById} service the renderer IPC
 * path (`IPC_CHANNELS.workspaceDelete`) calls, so cowork detach/delete cleanup
 * and persisted-dir removal cannot drift between the two surfaces. Unlike the
 * worktree create/archive adapters, this handler does NOT reject cowork
 * workspaces — the service handles every workspace type. The browser refreshes
 * the workspace list by requesting a fresh `overview` snapshot right after this
 * command (portal commands are processed serially, so the snapshot reflects the
 * deletion).
 */
export async function handlePortalWorkspaceDelete(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.workspace.delete']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  // The payload is browser-supplied and only shape/size-validated in transit,
  // so re-validate the fields here (read through `unknown` so the guard is a
  // real runtime check, not a type-narrowed no-op).
  const payload: unknown = command.payload;
  if (!isRecord(payload) || typeof payload.workspaceId !== 'string') {
    context.fail(
      command,
      'invalid_payload',
      'Invalid project delete payload: workspaceId is required.',
    );
    return;
  }
  const workspaceId = payload.workspaceId;
  // Superseding is a person's confirmation (CAN-5337); an agent's is ignored.
  const superseded =
    !context.origin && typeof payload.supersedeInterruptedDeletion === 'string'
      ? payload.supersedeInterruptedDeletion
      : undefined;
  if (superseded !== undefined) {
    // Checked outside the deletion's catch, which may replace its message.
    try {
      validateId(superseded, 'supersedeInterruptedDeletion');
    } catch {
      context.fail(
        command,
        'invalid_payload',
        'Invalid project delete payload: supersedeInterruptedDeletion must be an operation id.',
      );
      return;
    }
  }

  try {
    // Defense-in-depth on the browser-supplied id (the service also validates,
    // but validate up front to match the IPC convention).
    validateId(workspaceId, 'workspaceId');
    await deleteWorkspaceById(
      workspaceId,
      'portal',
      superseded !== undefined
        ? { supersedeInterruptedDeletion: superseded }
        : {},
    );
    notifyRendererWorkspacesChanged(context, workspaceId);
    context.complete(command, { success: true });
  } catch (error) {
    if (await isRefusedOnlyForDiscardableItems(workspaceId)) {
      const code: unknown =
        error instanceof Error && 'code' in error ? error.code : undefined;
      context.fail(
        command,
        typeof code === 'string' ? code : 'execution_failed',
        PROJECT_DELETION_DISCARD_POINTER,
        false,
      );
      return;
    }
    failServiceError(command, context, error);
  }
}

/**
 * CAN-5337: a deletion that refused only because of worktrees a person can
 * discard points at the discard instead of a retry that can't succeed. The
 * service's own messages stay unchanged; desktop Settings and the web open the
 * discard confirmation themselves.
 */
export const PROJECT_DELETION_DISCARD_POINTER =
  "A source repository for this project's worktrees is missing, or a worktree's removal can't finish. If a repository is on a disconnected drive or share, reconnect it and retry. Otherwise, delete the project in the desktop app or on the web to discard the affected worktrees.";

/** Any other refusal, or one the description can't read, keeps its message. */
async function isRefusedOnlyForDiscardableItems(
  workspaceId: string,
): Promise<boolean> {
  try {
    // CAN-5338: a client that sees this pointer describes with the opt-in.
    const description = await describeProjectDeletionDiscard(workspaceId, {
      retainedArchives: true,
    });
    return description.status === 'discardable';
  } catch {
    return false;
  }
}

/**
 * Handle `portal.workspace.delete.discard.describe` (CAN-5337): the read-only
 * list of what keeps a project's deletion from finishing. User-only: a
 * command an external agent sent is refused.
 */
export async function handlePortalWorkspaceDeleteDiscardDescribe(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  if (context.origin) {
    context.fail(command, 'forbidden', 'Only a person can discard a worktree.');
    return;
  }
  const payload: unknown = command.payload;
  if (!isRecord(payload) || typeof payload.workspaceId !== 'string') {
    context.fail(
      command,
      'invalid_payload',
      'Invalid project deletion discard payload: workspaceId is required.',
    );
    return;
  }
  try {
    validateId(payload.workspaceId, 'workspaceId');
    context.complete(
      command,
      payload.retainedArchives === true
        ? await describeProjectDeletionDiscard(payload.workspaceId, {
            retainedArchives: true,
          })
        : await describeProjectDeletionDiscard(payload.workspaceId),
    );
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/**
 * Handle `portal.workspace.claude_md.get` — read a workspace's editable
 * `CLAUDE.md` for the browser workspace-settings dialog. Small-RPC: the content
 * is returned in the command completion result (`{ content }`). Reads through
 * `core.workspace.instructions.get`, the operation behind the renderer IPC
 * path (source-backed routing + empty-on-missing).
 */
export async function handlePortalWorkspaceClaudeMdGet(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.workspace.claude_md.get']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (!isRecord(payload) || typeof payload.workspaceId !== 'string') {
    context.fail(
      command,
      'invalid_payload',
      'Invalid CLAUDE.md get payload: workspaceId is required.',
    );
    return;
  }
  const workspaceId = payload.workspaceId;
  try {
    validateId(workspaceId, 'workspaceId');
    const content = await readPortalWorkspaceInstructions(workspaceId);
    context.complete(command, { content });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/**
 * Handle `portal.workspace.claude_md.save` — write a workspace's `CLAUDE.md`
 * from the browser workspace-settings dialog via
 * `core.workspace.instructions.update` (keeps the source-backed `AGENTS.md`
 * symlink and records `portal` update telemetry). Editing config is additive, so this is not gated by
 * the destructive-actions flag.
 */
export async function handlePortalWorkspaceClaudeMdSave(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.workspace.claude_md.save']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.workspaceId !== 'string' ||
    typeof payload.content !== 'string'
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid CLAUDE.md save payload: workspaceId and content are required.',
    );
    return;
  }
  const workspaceId = payload.workspaceId;
  const content = payload.content;
  try {
    validateId(workspaceId, 'workspaceId');
    await writePortalWorkspaceInstructions(workspaceId, content);
    context.complete(command, { success: true });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/**
 * Handle `portal.workspace.update` — rename and/or recolor a workspace from the
 * browser workspace-settings dialog through the shared metadata boundary
 * ({@link updateWorkspaceMetadata}), which validates a non-empty name and a
 * palette color and rewrites only the workspace's index entry.
 * Additive metadata edit → not gated by the destructive-actions flag.
 */
export async function handlePortalWorkspaceUpdate(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.workspace.update']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (!isRecord(payload) || typeof payload.workspaceId !== 'string') {
    context.fail(
      command,
      'invalid_payload',
      'Invalid project update payload: workspaceId is required.',
    );
    return;
  }
  const workspaceId = payload.workspaceId;
  const name = typeof payload.name === 'string' ? payload.name : undefined;
  const color = typeof payload.color === 'string' ? payload.color : undefined;
  const collapsed =
    typeof payload.collapsed === 'boolean' ? payload.collapsed : undefined;
  try {
    validateId(workspaceId, 'workspaceId');
    await updateWorkspaceMetadata({
      workspaceId,
      patch: { name, color, collapsed },
      source: 'portal',
    });
    notifyRendererWorkspacesChanged(context, workspaceId);
    context.complete(command, { success: true });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/**
 * Handle `portal.workspace.scripts.get` — read a workspace's lifecycle script
 * commands for the browser settings Scripts section. Small-RPC: returns
 * `{ commands }` (name→command-string) in the completion result.
 */
export async function handlePortalWorkspaceScriptsGet(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.workspace.scripts.get']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (!isRecord(payload) || typeof payload.workspaceId !== 'string') {
    context.fail(
      command,
      'invalid_payload',
      'Invalid scripts get payload: workspaceId is required.',
    );
    return;
  }
  const workspaceId = payload.workspaceId;
  try {
    const commands = await readPortalWorkspaceScriptCommands(workspaceId);
    context.complete(command, { commands });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/**
 * Handle `portal.workspace.scripts.save` — merge browser-supplied script command
 * strings into the workspace's persisted scripts and save, through
 * `core.script.definition.upsert` and `.delete` (CAN-5369), which preserve
 * untouched scripts + non-command `ScriptDefinition` fields and re-normalize
 * through the same path as the renderer. Additive edit → not flag-gated.
 */
export async function handlePortalWorkspaceScriptsSave(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.workspace.scripts.save']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.workspaceId !== 'string' ||
    !isRecord(payload.commands)
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid scripts save payload: workspaceId and a commands map are required.',
    );
    return;
  }
  const workspaceId = payload.workspaceId;
  // Keep only string-valued command entries (the wire is untrusted).
  const commands: Record<string, string> = {};
  for (const [name, value] of Object.entries(payload.commands)) {
    if (typeof value === 'string') {
      commands[name] = value;
    }
  }
  try {
    validateId(workspaceId, 'workspaceId');
    await savePortalWorkspaceScriptCommands(workspaceId, commands);
    context.complete(command, { success: true });
  } catch (error) {
    failServiceError(command, context, error);
  }
}
