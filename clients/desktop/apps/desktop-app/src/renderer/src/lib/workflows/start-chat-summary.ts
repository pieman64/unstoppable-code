/**
 * What a converted chat automation's Definition summarizes (CAN-4551): where
 * its chat starts and the steps its workflow runs, read from the same
 * converter main saves with, so the summary follows the form as it changes.
 */
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  CHAT_AUTOMATION_JOB,
  chatAutomationToPipeline,
  convertibleChatAutomation,
} from '@canopy/desktop-shared/lib/chat-automation-conversion';
import type { AutomationAction } from '@canopy/desktop-shared/types';

const STEP_LABELS: Readonly<Record<string, string>> = {
  'builtin/create-worktree': 'Create a worktree',
  'builtin/create-project-entry': 'Create a task',
  'builtin/create-bot-entry': `Create an ${ORCHESTRATOR_LABEL} task`,
  'builtin/send-agent-message': 'Send the prompt',
  'builtin/wait-for-agent-reply': 'Wait for the reply',
};

export interface StartChatSummaryView {
  readonly destination: string;
  readonly steps: readonly string[];
}

function projectIdOf(action: AutomationAction): string | undefined {
  switch (action.type) {
    case 'worktree_prompt':
    case 'worktree_session_prompt':
      return action.workspaceId;
    case 'standalone_prompt':
      return action.chatProjectId;
    default:
      return undefined;
  }
}

/** Null for an action that stays native, which has nothing to summarize. */
export function startChatSummaryView(
  name: string,
  action: AutomationAction,
  projectName: (projectId: string) => string | undefined,
): StartChatSummaryView | null {
  if (!convertibleChatAutomation({ name, action }).convertible) return null;
  const { pipeline } = chatAutomationToPipeline({ name, action });
  const steps = (pipeline.jobs[CHAT_AUTOMATION_JOB]?.steps ?? []).map(
    (step) => STEP_LABELS[step.uses ?? ''] ?? 'Step',
  );
  if (action.type === 'app_advisor_prompt')
    return { destination: ORCHESTRATOR_LABEL, steps };
  const projectId = projectIdOf(action);
  return {
    destination:
      (projectId === undefined ? undefined : projectName(projectId)) ??
      'a project',
    steps,
  };
}
