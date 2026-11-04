/**
 * Browser-safe contract for the `create-project-entry` and `create-bot-entry`
 * host steps.
 *
 * The executor parses inputs here; desktop main creates the task through the
 * explicit-target `projects.create_task` / `bots.create_task` actions. Neither
 * step has a Node fallback, so the CLI fails them with `needs_desktop`.
 */
import {
  presentInput,
  SAFE_BOT_ID_RE,
  SAFE_ID_RE,
  type HostInputParse,
} from './host-actions';

export interface CreateProjectEntryInputs {
  projectId: string;
  title?: string;
  /** A group name; creation never removes or addresses a group by id. */
  group?: string;
}

export interface CreateBotEntryInputs {
  botId: string;
  title?: string;
  /** A group name; creation never removes or addresses a group by id. */
  group?: string;
}

/** The shared `titleSchema` max for `*.create_task`; never above it. */
export const CREATE_ENTRY_TITLE_MAX = 200;

const CREATE_ENTRY_COMMON_OUTPUTS = [
  'task_id',
  'chat_id',
  'task_created',
  'chat_created',
  'group_id',
  'group_created',
  'grouped',
  'not_grouped_reason',
] as const;

/**
 * Every output the action declares except `failure_reason`, which the
 * executor adds.
 */
export const CREATE_PROJECT_ENTRY_OUTPUTS: readonly string[] = [
  'project_id',
  ...CREATE_ENTRY_COMMON_OUTPUTS,
];

export const CREATE_BOT_ENTRY_OUTPUTS: readonly string[] = [
  'bot_id',
  ...CREATE_ENTRY_COMMON_OUTPUTS,
];

const CREATE_ENTRY_FLAG_OUTPUTS = [
  'task_created',
  'chat_created',
  'group_created',
  'grouped',
];

function emptyOutputs(names: readonly string[]): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const name of names) {
    outputs[name] = CREATE_ENTRY_FLAG_OUTPUTS.includes(name) ? 'false' : '';
  }
  return outputs;
}

/** Every output `''` except the boolean flags, which are `'false'`. */
export function emptyCreateProjectEntryOutputs(): Record<string, string> {
  return emptyOutputs(CREATE_PROJECT_ENTRY_OUTPUTS);
}

/** Every output `''` except the boolean flags, which are `'false'`. */
export function emptyCreateBotEntryOutputs(): Record<string, string> {
  return emptyOutputs(CREATE_BOT_ENTRY_OUTPUTS);
}

/** Messages name inputs only; titles and group names are user text. */
function parseTitleAndGroup(
  step: string,
  inputs: Record<string, string | undefined>,
): HostInputParse<{ title?: string; group?: string }> {
  const title = presentInput(inputs, 'title');
  if (title !== undefined && title.length > CREATE_ENTRY_TITLE_MAX) {
    return {
      ok: false,
      message: `${step} "title" must be at most ${CREATE_ENTRY_TITLE_MAX} characters`,
    };
  }
  // Creating never removes a group: `none` is a name to join here, and means
  // "remove" only to move-to-group (CAN-5479).
  const group = presentInput(inputs, 'group');
  return {
    ok: true,
    value: {
      ...(title !== undefined ? { title } : {}),
      ...(group !== undefined ? { group } : {}),
    },
  };
}

export function parseCreateProjectEntryInputs(
  inputs: Record<string, string | undefined>,
): HostInputParse<CreateProjectEntryInputs> {
  const step = 'create-project-entry';
  const projectId = presentInput(inputs, 'project_id');
  if (projectId === undefined) {
    return { ok: false, message: `${step} requires "project_id"` };
  }
  if (!SAFE_ID_RE.test(projectId)) {
    return {
      ok: false,
      message: `${step} "project_id" must be lowercase alphanumeric with hyphens`,
    };
  }
  const rest = parseTitleAndGroup(step, inputs);
  return rest.ok
    ? { ok: true, value: { projectId, ...rest.value } }
    : { ok: false, message: rest.message };
}

/** Unknown bots are refused by the host as `not_found`, not here. */
export function parseCreateBotEntryInputs(
  inputs: Record<string, string | undefined>,
): HostInputParse<CreateBotEntryInputs> {
  const step = 'create-bot-entry';
  const botId = presentInput(inputs, 'bot_id') ?? 'app_advisor';
  if (!SAFE_BOT_ID_RE.test(botId)) {
    return {
      ok: false,
      message: `${step} "bot_id" must be lowercase alphanumeric with hyphens or underscores`,
    };
  }
  const rest = parseTitleAndGroup(step, inputs);
  return rest.ok
    ? { ok: true, value: { botId, ...rest.value } }
    : { ok: false, message: rest.message };
}
