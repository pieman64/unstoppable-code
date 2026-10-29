import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { useGitHubStore } from '@/stores/githubStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

/**
 * Opening a Cowork Work Entry from a sidebar row, shared by every sidebar host
 * so they behave the same. Same shape as `openNewCoworkTaskFromSidebar`: the
 * navigation is fire-and-forget, so a rejection has to be surfaced here or the
 * row silently does nothing and the user has no way to tell the click landed.
 *
 * `openWorkEntryFromSidebar` rejects when the workspace is genuinely absent
 * (`switchChatProject` throws after a fresh listing), which is a real error
 * rather than a superseded navigation. It can also reject from `initialize()`,
 * `refreshWorkEntries()`, or `selectWorkEntry()`, so the error is logged as
 * well as toasted — the toast is all the user needs, but without the log the
 * failure never reaches `agent-observability/diagnostics/app-events` and a
 * report of "the row does nothing" has nothing behind it to triage.
 */
export function openCoworkWorkEntryFromSidebar(
  projectId: string,
  entryId: string,
): void {
  void useStandaloneChatStore
    .getState()
    .openWorkEntryFromSidebar(projectId, entryId)
    .catch((error: unknown) => {
      reportRendererConsoleError('Opening the cowork task failed', {
        projectId,
        entryId,
        error,
      });
      useGitHubStore
        .getState()
        .addToast("Couldn't open the task. Try again.", 'error');
    });
}

/**
 * Selecting a Cowork *workspace* row from a sidebar host. The sibling of
 * `openCoworkWorkEntryFromSidebar` for the row above the tasks: same
 * fire-and-forget navigation, same need to surface a rejection rather than
 * leave a click that appears to do nothing.
 *
 * `switchChatProject` returns `false` when a newer navigation superseded this
 * one — that is an ordinary outcome, not a failure, so it must not toast. It
 * rejects only when the workspace is genuinely absent after a fresh listing,
 * which is the case this catch exists for.
 */
export function selectCoworkWorkspaceFromSidebar(projectId: string): void {
  void useStandaloneChatStore
    .getState()
    .switchChatProject(projectId)
    .catch((error: unknown) => {
      reportRendererConsoleError('Selecting the cowork workspace failed', {
        projectId,
        error,
      });
      useGitHubStore
        .getState()
        .addToast("Couldn't open the workspace. Try again.", 'error');
    });
}
