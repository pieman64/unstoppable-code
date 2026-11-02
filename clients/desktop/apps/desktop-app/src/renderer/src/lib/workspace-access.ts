/**
 * Workspace access mode threaded through the standard panel host.
 *
 * The shared-container recipient view mounts the SAME panel grid, chat
 * surface, file viewer, browser and activity rail the publisher uses. Read-only
 * is a property of the scope, provided once by the recipient host, rather than
 * a second set of components. Consumers hide the controls that send, mutate or
 * act on a turn; main independently fails closed for every content write on
 * the viewer scope (`assertWritableScope`), so this context is presentation,
 * not the security boundary.
 *
 * React context flows through the panel grid's portals, so every panel content
 * subtree below the provider sees the value. The recipient host disables
 * pop-out, so no auxiliary window renders viewer content outside it.
 * Retained transcript viewers use the same presentation gates with the
 * `retained-chat` reason, without restoring an execution host.
 */
import { createContext, useContext } from 'react';

export type SharedContainerAccessContainerType =
  | 'CODE_WORKTREE'
  | 'COWORK_WORK_ENTRY';

export type WorkspaceAccess =
  | { readonly mode: 'read-write' }
  | {
      readonly mode: 'read-only';
      readonly reason: 'shared-container' | 'retained-chat';
      readonly containerType: SharedContainerAccessContainerType;
      /**
       * Whether this device granted the share permission to run code. Unlocks
       * only what executes code (terminal, scripts, launch); the file explorer
       * and browser only read the replica and are never gated on it.
       */
      readonly runAllowed: boolean;
    };

export const READ_WRITE_WORKSPACE_ACCESS: WorkspaceAccess = Object.freeze({
  mode: 'read-write',
});

export const WorkspaceAccessContext = createContext<WorkspaceAccess>(
  READ_WRITE_WORKSPACE_ACCESS,
);

export function useWorkspaceAccess(): WorkspaceAccess {
  return useContext(WorkspaceAccessContext);
}

export function useWorkspaceIsReadOnly(): boolean {
  return useContext(WorkspaceAccessContext).mode === 'read-only';
}
