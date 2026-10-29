import {
  parseProjectReadAction,
  type ProjectReadAction,
} from '@canopy/desktop-shared/lib/project-reads';
import {
  parseBotAction,
  type BotAction,
} from '@canopy/desktop-shared/lib/bot-discovery';
import type {
  AppAdvisorActionResponse,
  AppAdvisorJson,
} from '@canopy/desktop-shared/types';
import type { ProjectDiscoveryCaller } from '../index';
import { DiscoveryError } from '../errors';
import { requireBotAccess, resolveBotReadBinding } from '../bots/target';
import { toDiscoveryJson } from '../paging';
import { resolveReadBinding } from './binding';
import { ReadCursorStore } from './cursor-store';
import {
  readHistory,
  type ChatHistoryResult,
  type HistoryScan,
} from './history';
import {
  getLastUserMessage,
  getLastAgentResponse,
  type ChatLastMessageResult,
} from './last-message';
import { TranscriptReader } from './transcript';
import type { ChatReadContext } from '../chat-target';

const cursors = new ReadCursorStore();

export type BotReadAction = Extract<
  BotAction,
  {
    type:
      | 'bots.get_last_user_message'
      | 'bots.get_last_agent_response'
      | 'bots.read_history';
  }
>;

type ReadAction = ProjectReadAction | BotReadAction;

/** Read an explicit authorized target; never change selection or write chat state. */
export async function dispatchProjectReadAction(
  action: ProjectReadAction,
  caller: ProjectDiscoveryCaller,
): Promise<Omit<AppAdvisorActionResponse, 'requestId'>> {
  const parsed = parseProjectReadAction(action);
  if (!parsed.ok)
    return {
      ok: false,
      error: { code: 'invalid_payload', message: parsed.message },
    };
  const input = parsed.action;
  const handle =
    input.type === 'projects.read_history' ? input.cursor : undefined;
  try {
    if (handle !== undefined) cursors.get(handle);
    const { binding, context } = await resolveReadBinding(input, caller);
    const resolveLatestBinding = async (): Promise<string> =>
      (await resolveReadBinding(input, caller)).binding;
    const result = await runResolvedRead(
      input,
      binding,
      context,
      handle,
      resolveLatestBinding,
    );
    return { ok: true, result };
  } catch (error) {
    if (error instanceof DiscoveryError) {
      if (
        handle !== undefined &&
        (error.code === 'not_found' ||
          error.code === 'owner_context_unavailable')
      ) {
        return {
          ok: false,
          error: {
            code: 'cursor_context_changed',
            message: 'This history context changed. Restart the read.',
          },
        };
      }
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Project transcript could not be read.',
      },
    };
  }
}

/** Read a bot chat transcript without projecting its internal workspace ID. */
export async function dispatchBotReadAction(
  action: BotReadAction,
  caller: ProjectDiscoveryCaller,
): Promise<Omit<AppAdvisorActionResponse, 'requestId'>> {
  const parsed = parseBotAction(action);
  if (!parsed.ok)
    return {
      ok: false,
      error: { code: 'invalid_payload', message: parsed.message },
    };
  if (!isBotReadAction(parsed.action))
    return {
      ok: false,
      error: {
        code: 'invalid_payload',
        message: 'Only bot transcript read actions are supported here.',
      },
    };

  const input = parsed.action;
  const handle = input.type === 'bots.read_history' ? input.cursor : undefined;
  try {
    await requireBotAccess(caller);
    try {
      // The live bot gate must take precedence over every cursor state.
      if (handle !== undefined) cursors.get(handle);
      const { binding, context } = await resolveBotReadBinding(input, caller);
      const resolveLatestBinding = async (): Promise<string> =>
        (await resolveBotReadBinding(input, caller)).binding;
      const result = await runResolvedRead(
        input,
        binding,
        context,
        handle,
        resolveLatestBinding,
      );
      return { ok: true, result };
    } finally {
      // Recheck even if binding or transcript work failed while authorization
      // changed; a revoked bot read must never leak its earlier error or data.
      await requireBotAccess(caller);
    }
  } catch (error) {
    if (error instanceof DiscoveryError) {
      if (
        handle !== undefined &&
        (error.code === 'not_found' ||
          error.code === 'owner_context_unavailable')
      ) {
        return {
          ok: false,
          error: {
            code: 'cursor_context_changed',
            message: 'This history context changed. Restart the read.',
          },
        };
      }
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Bot transcript could not be read.',
      },
    };
  }
}

async function runResolvedRead<TContext extends ChatReadContext>(
  action: ReadAction,
  binding: string,
  context: TContext,
  handle: string | undefined,
  resolveLatestBinding: () => Promise<string>,
): Promise<AppAdvisorJson> {
  const cursor =
    handle !== undefined ? cursors.get(handle, binding) : undefined;
  const reader = new TranscriptReader(context, cursor?.transcriptRevision);
  let result:
    | ChatLastMessageResult<TContext['address']>
    | ChatHistoryResult<TContext['address']>;
  let historyScan: HistoryScan<TContext['address']> | undefined;
  if (
    action.type === 'projects.get_last_user_message' ||
    action.type === 'bots.get_last_user_message'
  )
    result = await getLastUserMessage(reader, context);
  else if (
    action.type === 'projects.get_last_agent_response' ||
    action.type === 'bots.get_last_agent_response'
  )
    result = await getLastAgentResponse(reader, context);
  else if (
    action.type === 'projects.read_history' ||
    action.type === 'bots.read_history'
  ) {
    historyScan = await readHistory(action, reader, context, cursor);
    result = { ...historyScan.result, nextCursor: null };
  } else {
    throw new DiscoveryError('invalid_payload', 'Unsupported transcript read.');
  }
  await reader.verifyRevision();
  if (binding !== (await resolveLatestBinding()))
    throw new DiscoveryError(
      'cursor_context_changed',
      'This history context changed. Restart the read.',
    );
  if (
    historyScan?.next &&
    (action.type === 'projects.read_history' ||
      action.type === 'bots.read_history')
  ) {
    result = {
      ...historyScan.result,
      nextCursor: cursors.put(binding, reader.revision, historyScan.next),
    };
  }
  return toDiscoveryJson(result);
}

function isBotReadAction(action: BotAction): action is BotReadAction {
  return (
    action.type === 'bots.get_last_user_message' ||
    action.type === 'bots.get_last_agent_response' ||
    action.type === 'bots.read_history'
  );
}
