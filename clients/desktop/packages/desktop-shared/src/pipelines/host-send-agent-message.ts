/**
 * Browser-safe contract for the `send-agent-message` host step.
 *
 * The executor parses inputs here, reads `text_file`, contains `attachments`
 * and resolves model aliases; desktop main applies owner, target, agent
 * authority and send policy and sends through the admitted-send path. The step
 * has no Node fallback, so the CLI fails it with `needs_desktop`.
 *
 * Message text, file contents and paths are user data: no parse error here
 * echoes them.
 */
import {
  isChatAttachmentPromptKind,
  type ChatAttachmentPromptContext,
  type ChatInterfaceMode,
  type FileReference,
} from '@canopy/agent-transcript/types';
import { isCodexSpeed, type CodexSpeed } from '@canopy/protocol/automations';
import {
  isValidatedConfiguredPromptReferences,
  validateConfiguredPromptReferences,
  type ConfiguredPromptReference,
} from '@canopy/protocol/configured-prompt-references';
import {
  normalizeShareablePluginRef,
  type ShareablePluginRef,
} from '@canopy/protocol/plugins';
import { WorkerPipelineChatSendRecordSchema } from '@canopy/protocol/canopy-core';
import { isThinkingLevel, THINKING_LEVELS } from '@canopy/protocol/thinking';
import type { ThinkingLevel } from '@canopy/protocol/thinking';
import { normalizePluginSelections } from '../lib/plugin-selections-normalization';
import type { ChatTabPluginSelections } from '../types';
import { APPROVAL_MODES, type ApprovalMode } from '../types/approvals';
import type { PipelineChatSendRecord } from '@canopy/execution-engine/types/pipeline';
import {
  presentInput,
  SAFE_BOT_ID_RE,
  SAFE_ID_RE,
  type HostInputParse,
} from './host-actions';

const STEP = 'send-agent-message';

export type SendAgentMessageTarget =
  | { kind: 'project'; projectId: string; taskId: string; chatId?: string }
  | { kind: 'bot'; botId: string; taskId: string; chatId?: string };

export interface SendAgentMessageSettings {
  /** As authored; the runner resolves aliases before raising the request. */
  model?: string;
  thinkingEffort?: ThinkingLevel;
  fastMode?: boolean;
  /** `speed`: the Codex speed, Ultra fast included; never with `fastMode`. */
  speed?: CodexSpeed;
  planMode?: boolean;
  approvalMode?: ApprovalMode;
  plugins?: ShareablePluginRef[];
  /**
   * `plugin_selections`: local plugin selections, normalized, as a chat
   * automation stores them (CAN-5479).
   */
  pluginSelections?: ChatTabPluginSelections;
  /** New chats only. */
  interfaceMode?: ChatInterfaceMode;
}

export type SendAgentMessageInputMode = 'typed' | 'voice';

export type SendAgentMessageMode = 'queue' | 'steer';

export interface SendAgentMessageInputs {
  target: SendAgentMessageTarget;
  /**
   * `plugin_collection_id`: a pipeline plugin collection the runner turns
   * into `settings.pluginSelections` before the request is raised (CAN-5479).
   * Never with `plugin_selections`.
   */
  pluginCollectionId?: string;
  /** `text`, or `text_file` read by the runner; never both. */
  text: { kind: 'inline'; text: string } | { kind: 'file'; path: string };
  mode: SendAgentMessageMode;
  settings: SendAgentMessageSettings;
  textReferences?: ConfiguredPromptReference[];
  /** Relative to the step's working folder; existing chats only. */
  attachments?: string[];
  /**
   * `attachment_paths`: absolute paths, as a chat automation stores them
   * (CAN-5479). Existing chats only; desktop main refuses any path outside the
   * target task's attachments folder. Never with `attachments`.
   */
  attachmentPaths?: string[];
  /** `attachment_prompt_contexts`: existing chats only. */
  attachmentPromptContexts?: ChatAttachmentPromptContext[];
  /** `file_references`: legacy composer file references; existing chats only. */
  fileReferences?: FileReference[];
  /** `input_mode`: existing chats only. */
  inputMode?: SendAgentMessageInputMode;
  /**
   * `literal_text`: the runner left `text` and `text_references` as written,
   * expressions included (CAN-4551). Inline text only.
   */
  literalText?: true;
  /**
   * `replace_empty_chat`: in a run an automation started, a new chat replaces
   * the task's only chat when it is still empty, so the task keeps one chat
   * (CAN-4551). New chats only; other runs ignore it.
   */
  replaceEmptyChat?: true;
  /**
   * `new_chat`: always a new chat, never the task's empty one, which may be a
   * person's draft (CAN-4551). New chats only.
   */
  newChat?: true;
}

/**
 * After the runner: inline text, resolved model, a plugin collection as
 * selections, absolute contained paths.
 */
export interface ResolvedSendAgentMessageInputs extends Omit<
  SendAgentMessageInputs,
  'text' | 'attachments' | 'pluginCollectionId'
> {
  text: string;
  /**
   * Absolute realpaths inside the working folder. A resumed execution keeps
   * its working folder (a global run's scratch folder is derived from the
   * execution id), so these are stable across a replay and the adapter
   * fingerprints them as they are.
   */
  attachments?: string[];
}

export const SEND_AGENT_MESSAGE_TEXT_FILE_MAX_BYTES = 1024 * 1024;

/** Inputs an agent-originated run may not set with `chat_id` (D11); shared by save-time and run-time checks. */
export const SEND_AGENT_MESSAGE_AUTHORITY_INPUTS = [
  'approval_mode',
  'model',
  'plan_mode',
  'plugins',
  'plugin_selections',
  'plugin_collection_id',
] as const;

export const SEND_AGENT_MESSAGE_INTERFACE_MODES: readonly ChatInterfaceMode[] =
  ['canopy', 'claude-code', 'auto'];

/** Why a `mode: steer` send stayed queued (D7). */
export const SEND_AGENT_MESSAGE_STEER_UNAVAILABLE_REASONS = [
  'missing_capability',
] as const;

export type SendAgentMessageSteerUnavailableReason =
  (typeof SEND_AGENT_MESSAGE_STEER_UNAVAILABLE_REASONS)[number];

/**
 * Every output the action declares except `failure_reason`, which the
 * executor adds.
 */
export const SEND_AGENT_MESSAGE_OUTPUTS = [
  'chat_id',
  'state',
  'project_id',
  'bot_id',
  'task_id',
  'chat_created',
  'message_id',
  'queued_message_id',
  'turn_id',
  'accepted_at',
  'steer_unavailable_reason',
] as const;

/** Every output `''` except `chat_created: 'false'`; the shape every typed failure carries. */
export function emptySendAgentMessageOutputs(): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const name of SEND_AGENT_MESSAGE_OUTPUTS) {
    outputs[name] = '';
  }
  outputs.chat_created = 'false';
  return outputs;
}

const CHAT_ID_MAX = 512;
const WHITESPACE_RE = /\s/;
const NON_WHITESPACE_RE = /\S/;

function failure<T>(message: string): HostInputParse<T> {
  return { ok: false, message };
}

function parseTarget(
  inputs: Record<string, string | undefined>,
): HostInputParse<SendAgentMessageTarget> {
  const projectId = presentInput(inputs, 'project_id');
  const botId = presentInput(inputs, 'bot_id');
  const taskId = presentInput(inputs, 'task_id');
  const chatId = presentInput(inputs, 'chat_id');
  if ((projectId === undefined) === (botId === undefined)) {
    return failure(`${STEP} requires exactly one of "project_id" or "bot_id"`);
  }
  if (taskId === undefined) {
    return failure(`${STEP} requires "task_id"`);
  }
  if (!SAFE_ID_RE.test(taskId)) {
    return failure(
      `${STEP} "task_id" must be lowercase alphanumeric with hyphens`,
    );
  }
  if (
    chatId !== undefined &&
    (chatId.length > CHAT_ID_MAX || WHITESPACE_RE.test(chatId))
  ) {
    return failure(
      `${STEP} "chat_id" must be at most ${CHAT_ID_MAX} characters with no spaces`,
    );
  }
  const chat = chatId !== undefined ? { chatId } : {};
  if (projectId !== undefined) {
    return SAFE_ID_RE.test(projectId)
      ? {
          ok: true,
          value: { kind: 'project', projectId, taskId, ...chat },
        }
      : failure(
          `${STEP} "project_id" must be lowercase alphanumeric with hyphens`,
        );
  }
  const bot = botId ?? '';
  return SAFE_BOT_ID_RE.test(bot)
    ? { ok: true, value: { kind: 'bot', botId: bot, taskId, ...chat } }
    : failure(
        `${STEP} "bot_id" must be lowercase alphanumeric with hyphens or underscores`,
      );
}

function parseText(
  inputs: Record<string, string | undefined>,
): HostInputParse<SendAgentMessageInputs['text']> {
  // `text` is not trimmed: leading and trailing whitespace is the author's.
  const text = inputs.text;
  const hasText = text !== undefined && text !== '';
  const file = presentInput(inputs, 'text_file');
  if (hasText === (file !== undefined)) {
    return failure(`${STEP} requires exactly one of "text" or "text_file"`);
  }
  if (file !== undefined) {
    return { ok: true, value: { kind: 'file', path: file } };
  }
  return text !== undefined && NON_WHITESPACE_RE.test(text)
    ? { ok: true, value: { kind: 'inline', text } }
    : failure(`${STEP} "text" must contain a non-space character`);
}

function parseMode(
  inputs: Record<string, string | undefined>,
): HostInputParse<SendAgentMessageMode> {
  const mode = presentInput(inputs, 'mode')?.toLowerCase();
  if (mode === undefined || mode === 'queue') {
    return { ok: true, value: 'queue' };
  }
  return mode === 'steer'
    ? { ok: true, value: 'steer' }
    : failure(`${STEP} "mode" must be "queue" or "steer"`);
}

function parseBoolean(
  inputs: Record<string, string | undefined>,
  name: string,
): HostInputParse<boolean | undefined> {
  const value = presentInput(inputs, name)?.toLowerCase();
  if (value === undefined) return { ok: true, value: undefined };
  if (value === 'true') return { ok: true, value: true };
  if (value === 'false') return { ok: true, value: false };
  return failure(`${STEP} "${name}" must be "true" or "false"`);
}

function parseJsonArray(
  inputs: Record<string, string | undefined>,
  name: string,
): HostInputParse<unknown[] | undefined> {
  const raw = presentInput(inputs, name);
  if (raw === undefined) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failure(`${STEP} "${name}" must be a JSON array`);
  }
  return Array.isArray(parsed)
    ? { ok: true, value: parsed }
    : failure(`${STEP} "${name}" must be a JSON array`);
}

function parsePlugins(
  inputs: Record<string, string | undefined>,
): HostInputParse<ShareablePluginRef[] | undefined> {
  const array = parseJsonArray(inputs, 'plugins');
  if (!array.ok) return array;
  if (array.value === undefined) return { ok: true, value: undefined };
  const plugins: ShareablePluginRef[] = [];
  for (const entry of array.value) {
    try {
      plugins.push(normalizeShareablePluginRef(entry));
    } catch {
      return failure(`${STEP} "plugins" holds an invalid plugin reference`);
    }
  }
  return { ok: true, value: plugins };
}

function parseAttachments(
  inputs: Record<string, string | undefined>,
): HostInputParse<string[] | undefined> {
  const array = parseJsonArray(inputs, 'attachments');
  if (!array.ok) return array;
  if (array.value === undefined) return { ok: true, value: undefined };
  const paths: string[] = [];
  for (const entry of array.value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return failure(`${STEP} "attachments" must list non-empty paths`);
    }
    paths.push(entry);
  }
  return { ok: true, value: paths };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePluginSelections(
  inputs: Record<string, string | undefined>,
): HostInputParse<ChatTabPluginSelections | undefined> {
  const raw = presentInput(inputs, 'plugin_selections');
  if (raw === undefined) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  return isPlainObject(parsed)
    ? { ok: true, value: normalizePluginSelections(parsed) }
    : failure(`${STEP} "plugin_selections" must be a JSON object`);
}

function parsePluginCollectionId(
  inputs: Record<string, string | undefined>,
): HostInputParse<string | undefined> {
  const id = presentInput(inputs, 'plugin_collection_id');
  if (id === undefined) return { ok: true, value: undefined };
  return presentInput(inputs, 'plugin_selections') === undefined
    ? { ok: true, value: id }
    : failure(
        `${STEP} "plugin_collection_id" and "plugin_selections" can't both be set`,
      );
}

function parseAttachmentPaths(
  inputs: Record<string, string | undefined>,
): HostInputParse<string[] | undefined> {
  const array = parseJsonArray(inputs, 'attachment_paths');
  if (!array.ok) return array;
  if (array.value === undefined) return { ok: true, value: undefined };
  const paths: string[] = [];
  for (const entry of array.value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return failure(`${STEP} "attachment_paths" must list non-empty paths`);
    }
    paths.push(entry);
  }
  return { ok: true, value: paths };
}

function parseAttachmentPromptContexts(
  inputs: Record<string, string | undefined>,
): HostInputParse<ChatAttachmentPromptContext[] | undefined> {
  const array = parseJsonArray(inputs, 'attachment_prompt_contexts');
  if (!array.ok) return array;
  if (array.value === undefined) return { ok: true, value: undefined };
  const contexts: ChatAttachmentPromptContext[] = [];
  for (const entry of array.value) {
    const attachmentPath: unknown = isPlainObject(entry)
      ? entry.attachmentPath
      : undefined;
    const promptKind: unknown = isPlainObject(entry)
      ? entry.promptKind
      : undefined;
    if (
      typeof attachmentPath !== 'string' ||
      !isChatAttachmentPromptKind(promptKind)
    ) {
      return failure(
        `${STEP} "attachment_prompt_contexts" holds an invalid attachment context`,
      );
    }
    contexts.push({ attachmentPath, promptKind });
  }
  return { ok: true, value: contexts };
}

function parseFileReference(entry: unknown): FileReference | undefined {
  if (!isPlainObject(entry)) return undefined;
  const { displayPath, absolutePath, repoName, kind, textStart } = entry;
  if (
    typeof displayPath !== 'string' ||
    typeof absolutePath !== 'string' ||
    (repoName !== undefined && typeof repoName !== 'string') ||
    (kind !== undefined && typeof kind !== 'string') ||
    (textStart !== undefined && typeof textStart !== 'number')
  ) {
    return undefined;
  }
  return {
    displayPath,
    absolutePath,
    ...(repoName !== undefined ? { repoName } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(textStart !== undefined ? { textStart } : {}),
  };
}

function parseFileReferences(
  inputs: Record<string, string | undefined>,
): HostInputParse<FileReference[] | undefined> {
  const array = parseJsonArray(inputs, 'file_references');
  if (!array.ok) return array;
  if (array.value === undefined) return { ok: true, value: undefined };
  const references: FileReference[] = [];
  for (const entry of array.value) {
    const reference = parseFileReference(entry);
    if (!reference) {
      return failure(
        `${STEP} "file_references" holds an invalid file reference`,
      );
    }
    references.push(reference);
  }
  return { ok: true, value: references };
}

function parseInputMode(
  inputs: Record<string, string | undefined>,
): HostInputParse<SendAgentMessageInputMode | undefined> {
  const mode = presentInput(inputs, 'input_mode');
  if (mode === undefined) return { ok: true, value: undefined };
  if (mode === 'typed' || mode === 'voice') return { ok: true, value: mode };
  return failure(`${STEP} "input_mode" must be "typed" or "voice"`);
}

/** The composer payload a chat automation stores (CAN-5479); existing chats only. */
interface ComposerPayload {
  attachmentPaths?: string[];
  attachmentPromptContexts?: ChatAttachmentPromptContext[];
  fileReferences?: FileReference[];
  inputMode?: SendAgentMessageInputMode;
}

/** Each composer field and its input, for the existing-chat check. */
const COMPOSER_INPUTS: ReadonlyArray<readonly [keyof ComposerPayload, string]> =
  [
    ['attachmentPaths', 'attachment_paths'],
    ['attachmentPromptContexts', 'attachment_prompt_contexts'],
    ['fileReferences', 'file_references'],
    ['inputMode', 'input_mode'],
  ];

function parseComposerPayload(
  inputs: Record<string, string | undefined>,
): HostInputParse<ComposerPayload> {
  const attachmentPaths = parseAttachmentPaths(inputs);
  if (!attachmentPaths.ok) return attachmentPaths;
  const contexts = parseAttachmentPromptContexts(inputs);
  if (!contexts.ok) return contexts;
  const fileReferences = parseFileReferences(inputs);
  if (!fileReferences.ok) return fileReferences;
  const inputMode = parseInputMode(inputs);
  if (!inputMode.ok) return inputMode;
  return {
    ok: true,
    value: {
      ...(attachmentPaths.value !== undefined
        ? { attachmentPaths: attachmentPaths.value }
        : {}),
      ...(contexts.value !== undefined
        ? { attachmentPromptContexts: contexts.value }
        : {}),
      ...(fileReferences.value !== undefined
        ? { fileReferences: fileReferences.value }
        : {}),
      ...(inputMode.value !== undefined ? { inputMode: inputMode.value } : {}),
    },
  };
}

/**
 * The longest prompt the shape-only check will synthesize. Offsets count
 * UTF-16 code units, and a `text_file` is at most
 * {@link SEND_AGENT_MESSAGE_TEXT_FILE_MAX_BYTES} bytes.
 */
const REFERENCE_PROMPT_MAX = SEND_AGENT_MESSAGE_TEXT_FILE_MAX_BYTES;

/**
 * A prompt that places each reference's `displayText` at its `textStart`, so
 * the shared validator checks the references' shape before the text is known.
 * `null` when an entry can't be placed; the validator then reports it.
 */
function synthesizeReferencePrompt(references: unknown[]): string | null {
  let prompt = '';
  for (const entry of references) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const textStart: unknown = Reflect.get(entry, 'textStart');
    const displayText: unknown = Reflect.get(entry, 'displayText');
    if (
      typeof textStart !== 'number' ||
      !Number.isSafeInteger(textStart) ||
      textStart < prompt.length ||
      typeof displayText !== 'string' ||
      textStart + displayText.length > REFERENCE_PROMPT_MAX
    ) {
      return null;
    }
    prompt = prompt.padEnd(textStart, ' ') + displayText;
  }
  return prompt;
}

function referencesFailure(error: string): HostInputParse<never> {
  // The shared validator's messages name entry indexes and fields, never text.
  return failure(`${STEP} "text_references" is invalid: ${error}`);
}

function parseTextReferences(
  inputs: Record<string, string | undefined>,
  text: SendAgentMessageInputs['text'],
): HostInputParse<ConfiguredPromptReference[] | undefined> {
  const array = parseJsonArray(inputs, 'text_references');
  if (!array.ok) return array;
  if (array.value === undefined) return { ok: true, value: undefined };
  const references = array.value;
  const prompt =
    text.kind === 'inline' ? text.text : synthesizeReferencePrompt(references);
  if (
    prompt !== null &&
    isValidatedConfiguredPromptReferences(prompt, references)
  ) {
    return { ok: true, value: references };
  }
  return referencesFailure(
    validateConfiguredPromptReferences(prompt ?? '', references) ??
      'promptReferences could not be placed in order.',
  );
}

function parseSettings(
  inputs: Record<string, string | undefined>,
): HostInputParse<SendAgentMessageSettings> {
  const settings: SendAgentMessageSettings = {};
  const model = presentInput(inputs, 'model');
  if (model !== undefined) settings.model = model;

  const thinking = presentInput(inputs, 'thinking_effort');
  if (thinking !== undefined) {
    if (!isThinkingLevel(thinking)) {
      return failure(
        `${STEP} "thinking_effort" must be one of: ${THINKING_LEVELS.join(', ')}`,
      );
    }
    settings.thinkingEffort = thinking;
  }

  const fastMode = parseBoolean(inputs, 'fast_mode');
  if (!fastMode.ok) return fastMode;
  if (fastMode.value !== undefined) settings.fastMode = fastMode.value;

  const speed = presentInput(inputs, 'speed');
  if (speed !== undefined) {
    if (!isCodexSpeed(speed)) {
      return failure(`${STEP} "speed" must be standard, fast or ultrafast`);
    }
    if (settings.fastMode !== undefined) {
      return failure(`${STEP} "speed" and "fast_mode" can't both be set`);
    }
    settings.speed = speed;
  }

  const planMode = parseBoolean(inputs, 'plan_mode');
  if (!planMode.ok) return planMode;
  if (planMode.value !== undefined) settings.planMode = planMode.value;

  const approval = presentInput(inputs, 'approval_mode');
  if (approval !== undefined) {
    const approvalMode = APPROVAL_MODES.find((mode) => mode === approval);
    if (approvalMode === undefined) {
      return failure(
        `${STEP} "approval_mode" must be one of: ${APPROVAL_MODES.join(', ')}`,
      );
    }
    settings.approvalMode = approvalMode;
  }

  const plugins = parsePlugins(inputs);
  if (!plugins.ok) return plugins;
  if (plugins.value !== undefined) settings.plugins = plugins.value;

  const pluginSelections = parsePluginSelections(inputs);
  if (!pluginSelections.ok) return pluginSelections;
  if (pluginSelections.value !== undefined)
    settings.pluginSelections = pluginSelections.value;

  const interface_ = presentInput(inputs, 'interface_mode');
  if (interface_ !== undefined) {
    const interfaceMode = SEND_AGENT_MESSAGE_INTERFACE_MODES.find(
      (mode) => mode === interface_,
    );
    if (interfaceMode === undefined) {
      return failure(
        `${STEP} "interface_mode" must be one of: ${SEND_AGENT_MESSAGE_INTERFACE_MODES.join(', ')}`,
      );
    }
    settings.interfaceMode = interfaceMode;
  }
  return { ok: true, value: settings };
}

/**
 * The parser knows nothing about the target's type or owner: `bot_id` with
 * `mode: steer` parses, and the host refuses it after the owner check.
 */
export function parseSendAgentMessageInputs(
  inputs: Record<string, string | undefined>,
): HostInputParse<SendAgentMessageInputs> {
  const target = parseTarget(inputs);
  if (!target.ok) return target;
  const text = parseText(inputs);
  if (!text.ok) return text;
  const mode = parseMode(inputs);
  if (!mode.ok) return mode;
  const hasChat = target.value.chatId !== undefined;
  if (mode.value === 'steer' && !hasChat) {
    return failure(`${STEP} "mode: steer" requires "chat_id"`);
  }
  const settings = parseSettings(inputs);
  if (!settings.ok) return settings;
  const pluginCollectionId = parsePluginCollectionId(inputs);
  if (!pluginCollectionId.ok) return pluginCollectionId;
  if (settings.value.interfaceMode !== undefined && hasChat) {
    return failure(
      `${STEP} "interface_mode" applies only to a new chat; remove "chat_id" or "interface_mode"`,
    );
  }
  const references = parseTextReferences(inputs, text.value);
  if (!references.ok) return references;
  const attachments = parseAttachments(inputs);
  if (!attachments.ok) return attachments;
  if (attachments.value !== undefined && !hasChat) {
    return failure(`${STEP} "attachments" requires "chat_id"`);
  }
  const composer = parseComposerPayload(inputs);
  if (!composer.ok) return composer;
  if (!hasChat) {
    for (const [field, name] of COMPOSER_INPUTS) {
      if (composer.value[field] !== undefined) {
        return failure(`${STEP} "${name}" requires "chat_id"`);
      }
    }
  }
  if (
    attachments.value !== undefined &&
    composer.value.attachmentPaths !== undefined
  ) {
    return failure(
      `${STEP} "attachments" and "attachment_paths" can't both be set`,
    );
  }
  const literalText = parseBoolean(inputs, 'literal_text');
  if (!literalText.ok) return literalText;
  if (literalText.value === true && text.value.kind !== 'inline') {
    return failure(`${STEP} "literal_text" applies only to "text"`);
  }
  const replaceEmptyChat = parseBoolean(inputs, 'replace_empty_chat');
  if (!replaceEmptyChat.ok) return replaceEmptyChat;
  if (replaceEmptyChat.value === true && hasChat) {
    return failure(
      `${STEP} "replace_empty_chat" applies only to a new chat; remove "chat_id" or "replace_empty_chat"`,
    );
  }
  const newChat = parseBoolean(inputs, 'new_chat');
  if (!newChat.ok) return newChat;
  if (newChat.value === true && hasChat) {
    return failure(
      `${STEP} "new_chat" applies only to a new chat; remove "chat_id" or "new_chat"`,
    );
  }
  return {
    ok: true,
    value: {
      target: target.value,
      text: text.value,
      mode: mode.value,
      settings: settings.value,
      ...(pluginCollectionId.value !== undefined
        ? { pluginCollectionId: pluginCollectionId.value }
        : {}),
      ...(references.value !== undefined
        ? { textReferences: references.value }
        : {}),
      ...(attachments.value !== undefined
        ? { attachments: attachments.value }
        : {}),
      ...composer.value,
      ...(literalText.value === true ? { literalText: true } : {}),
      ...(replaceEmptyChat.value === true ? { replaceEmptyChat: true } : {}),
      ...(newChat.value === true ? { newChat: true } : {}),
    },
  };
}

/** `text_references` against the final text; for `text_file`, the runner calls it after reading. Returns the error, or `null`. */
export function checkSendAgentMessageReferences(
  text: string,
  references: ConfiguredPromptReference[] | undefined,
): string | null {
  const error = validateConfiguredPromptReferences(text, references);
  return error === null
    ? null
    : `${STEP} "text_references" is invalid: ${error}`;
}

/**
 * Mirrors {@link PipelineChatSendRecord}; strict, so extra keys are refused.
 * The same schema bounds the record across the local worker boundary.
 */
export const pipelineChatSendRecordSchema = WorkerPipelineChatSendRecordSchema;

/** Validates an adapter's record before the runner copies it; `undefined` when malformed. */
export function parsePipelineChatSendRecord(
  value: unknown,
): PipelineChatSendRecord | undefined {
  const parsed = pipelineChatSendRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
