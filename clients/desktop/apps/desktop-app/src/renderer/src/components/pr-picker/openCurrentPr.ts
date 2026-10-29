import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  useNavigationStore,
  type PrPickerOption,
} from '@/stores/navigationStore';
import { isCoworkChatTarget } from '@/lib/cowork';
import { openUrlExternally } from './openUrlExternally';

export type OpenCurrentPrResult =
  | { kind: 'opened'; option: PrPickerOption }
  | { kind: 'picker'; options: PrPickerOption[] }
  | { kind: 'no-worktree' }
  | { kind: 'no-prs' };

function collectWorktreePrOptions(
  projectId: string,
  worktreeId: string,
): PrPickerOption[] {
  const status =
    useGitHubStore.getState().prStatuses[`${projectId}/${worktreeId}`];
  if (!status) {
    return [];
  }
  const options: PrPickerOption[] = [];
  for (const repo of status.repos) {
    if (!repo.status) {
      continue;
    }
    options.push({
      repoId: repo.repoId,
      repoName: repo.repoName,
      prNumber: repo.status.prNumber,
      prUrl: repo.status.prUrl,
      prTitle: repo.status.title,
      prState: repo.status.state,
    });
  }
  return options;
}

export function openCurrentWorktreePr(): OpenCurrentPrResult {
  const selection = useChatStore.getState().selectedWorktree;
  if (!selection || isCoworkChatTarget(selection.projectId)) {
    return { kind: 'no-worktree' };
  }

  const options = collectWorktreePrOptions(
    selection.projectId,
    selection.worktreeId,
  );

  if (options.length === 0) {
    return { kind: 'no-prs' };
  }

  if (options.length === 1) {
    openUrlExternally(options[0].prUrl);
    return { kind: 'opened', option: options[0] };
  }

  useNavigationStore.getState().openPrPicker(options);
  return { kind: 'picker', options };
}
