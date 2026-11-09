import {
  escapeExpressions,
  unescapeExpressions,
} from '@canopy/desktop-shared/lib/chat-automation-conversion';
import type { Step } from '@canopy/execution-engine/types/pipeline';
import type { SidebarItemGroupScope } from '@canopy/protocol/sidebar';

/**
 * A create step's sidebar group (CAN-5782): the picker over the groups of
 * the sidebar its new task joins, or a plain name when the step's project
 * isn't known until it runs.
 */
export type StepSidebarGroupField =
  | {
      readonly kind: 'picker';
      readonly scope: SidebarItemGroupScope;
      readonly value: string;
    }
  | { readonly kind: 'text'; readonly value: string };

const CREATE_WORKTREE = 'builtin/create-worktree';
const CREATE_PROJECT_ENTRY = 'builtin/create-project-entry';
const CREATE_BOT_ENTRY = 'builtin/create-bot-entry';

/** `${{ inputs.name }}`, the form conversion writes. */
const INPUT_EXPRESSION = /^\$\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}$/;

function stepText(step: Step, key: string): string | undefined {
  const value = step.with?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** A step input the action reads under either name, as the runner does. */
function presentStepText(
  step: Step,
  primary: string,
  alias: string,
): string | undefined {
  for (const key of [primary, alias]) {
    const value = stepText(step, key);
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}

/** The step's project: a literal id, or the run value its input reads. */
function stepProjectId(
  step: Step,
  inputValues: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const value = presentStepText(step, 'project_id', 'workspace_id');
  if (value === undefined) return undefined;
  const input = INPUT_EXPRESSION.exec(value)?.[1];
  if (input !== undefined) return inputValues?.[input] || undefined;
  return value.includes('${{') ? undefined : value;
}

/**
 * The sidebar group field for a step, or `undefined` when the step makes no
 * group call. A stacked worktree (`base_task_id` or its `base_worktree_id`
 * alias) follows its root's group, as conversion and the automation form
 * have it.
 */
export function stepSidebarGroupField(
  step: Step,
  inputValues?: Readonly<Record<string, string>>,
): StepSidebarGroupField | undefined {
  const value = unescapeExpressions(stepText(step, 'group') ?? '');
  switch (step.uses) {
    case CREATE_BOT_ENTRY:
      return { kind: 'picker', scope: { appAdvisor: true }, value };
    case CREATE_WORKTREE:
      if (presentStepText(step, 'base_task_id', 'base_worktree_id'))
        return undefined;
      break;
    case CREATE_PROJECT_ENTRY:
      break;
    default:
      return undefined;
  }
  const projectId = stepProjectId(step, inputValues);
  return projectId === undefined
    ? { kind: 'text', value }
    : { kind: 'picker', scope: { workspaceLocalId: projectId }, value };
}

/**
 * The step with its group set to `name`, written as conversion writes it
 * (a literal the step interpolates to exactly that name); an empty name
 * removes the group.
 */
export function withStepSidebarGroup(step: Step, name: string): Step {
  const { group: _group, ...rest } = step.with ?? {};
  void _group;
  // Kept as typed, so a space between words survives each keystroke.
  const next =
    name.trim() === '' ? rest : { ...rest, group: escapeExpressions(name) };
  const updated = { ...step };
  if (Object.keys(next).length > 0) updated.with = next;
  else delete updated.with;
  return updated;
}
