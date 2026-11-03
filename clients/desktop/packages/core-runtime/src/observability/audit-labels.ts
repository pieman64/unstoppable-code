import {
  CHAT_LABEL,
  CHAT_UNIT_LABEL,
  ORCHESTRATOR_LABEL,
  WORKTREE_LABEL,
  WORKTREE_UNIT_LABEL,
} from '@canopy/protocol';
import type { AgentAuditEventType } from '@canopy/protocol/observability';

export function labelForEventType(eventType: AgentAuditEventType): string {
  switch (eventType) {
    case 'worktree_chat':
      return `${WORKTREE_LABEL} ${CHAT_UNIT_LABEL}`;
    case 'standalone_chat':
      return `${CHAT_LABEL} ${CHAT_UNIT_LABEL}`;
    case 'app_advisor':
      return ORCHESTRATOR_LABEL;
    case 'pipeline_editor':
      return 'Workflow Editor';
    case 'pipeline_agent_turn':
      return 'Workflow Agent';
    case 'pipeline_advisor':
      return 'Workflow Advisor';
    case 'pr_generation':
      return 'PR Generation';
    case 'pr_split_planning':
      return 'Split PR Planning';
    case 'commit_message_generation':
      return 'Commit Message';
    case 'branch_naming':
      return 'Branch Naming';
    case 'cron_generation':
      return 'Cron Generation';
    case 'automation_if_command_generation':
      return 'If Command Generation';
    case 'worktree_summary':
      return `${WORKTREE_UNIT_LABEL} Summary`;
    case 'chat_summary':
      return `${CHAT_UNIT_LABEL} Summary`;
    case 'chat_handoff_summary':
      return `${CHAT_UNIT_LABEL} Handoff Summary`;
    case 'archive_summary':
      return 'Archive Summary';
    case 'worktree_plan_chat':
      return 'Worktree Plan Chat';
    case 'worktree_plan_diagram':
      return 'Worktree Plan Diagram';
    case 'code_review_annotations':
      return 'Review Annotations';
    case 'code_review_diagram':
      return 'Review Diagram';
    case 'local_memory_consolidation':
      return 'Memory Consolidation';
    case 'local_memory_chat_profile':
      return 'Chat History Profile';
    case 'skill_suggestion_scan':
      return 'Skill Suggestion Scan';
    case 'managed_delegation':
      return 'Delegation';
  }
}

/**
 * Both names of a renamed audit target. Persisted entries keep the label they
 * were written with, so history search matches either the old or the current
 * name for every entry of that type.
 */
export function renamedLabelsForEventType(
  eventType: AgentAuditEventType,
): readonly string[] {
  switch (eventType) {
    case 'pipeline_editor':
      return ['Pipeline Editor', 'Workflow Editor'];
    case 'pipeline_agent_turn':
      return ['Pipeline Agent', 'Workflow Agent'];
    case 'pipeline_advisor':
      return ['Pipeline Advisor', 'Workflow Advisor'];
    default:
      return [];
  }
}
