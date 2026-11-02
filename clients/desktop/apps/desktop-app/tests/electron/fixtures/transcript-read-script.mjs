import { readFileSync } from 'node:fs';
import {
  driveParentWatchFlow,
  hasToolName,
} from './delegation-capabilities/helpers.mjs';

const PERSISTED_PATH =
  /<persisted-output>\s*Output too large \([^)]*\)\. Full output saved to: (\S+)/;

/**
 * Claude saves a tool result over its MCP output limit to a file and gives the
 * model a preview. Read the saved reply, as an agent would.
 */
export function resolvePersistedOutput(text) {
  const savedPath = PERSISTED_PATH.exec(text)?.[1];
  if (!savedPath) return text;
  const saved = JSON.parse(readFileSync(savedPath, 'utf8'));
  const part = Array.isArray(saved)
    ? saved.find((item) => item?.type === 'text')
    : undefined;
  return typeof part?.text === 'string' ? part.text : JSON.stringify(saved);
}

/** The newest tool result in a request, parsed, following a saved reply. */
function latestResult(ctx) {
  const entries = ctx.results.split('\n');
  const content = JSON.parse(entries.at(-1) ?? 'null');
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.find((item) => item?.type === 'text')?.text
        : undefined;
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(resolvePersistedOutput(text));
  } catch {
    return undefined;
  }
}

// One tool per response, with locators taken from the preceding real result.
export function createTranscriptReadScript({
  fixture,
  foreignChatId,
  foreignDelegationId,
}) {
  let stage = 'search';
  let childRead = false;
  let sequence = 0;
  let contentLocator;
  const target = (delegationId) => ({
    kind: 'delegation',
    chatId: fixture.chatId,
    delegationId,
    runGeneration: 1,
  });
  const reply = (ctx, step) => {
    if (step.toolCalls) {
      if (step.toolCalls.length !== 1)
        throw new Error('Transcript read flow cannot batch tools');
      step.toolCalls = step.toolCalls.map((call) => ({
        ...call,
        id: `transcript-read-tool-${++sequence}`,
      }));
    }
    return ctx.reply(step);
  };
  const tool = (ctx, name, input) => {
    if (!hasToolName(ctx.item.toolNames, name))
      throw new Error(
        `Transcript read tool is not advertised: ${name} (offered: ${ctx.item.toolNames.join(', ')})`,
      );
    return reply(ctx, {
      toolCalls: [{ name, input }],
      stopReason: 'tool_use',
    });
  };
  const dispatch = (ctx, action) =>
    tool(ctx, ctx.toolName('DispatchAction', 'dispatch_action'), { action });
  const lastResult = (ctx) => {
    const result = latestResult(ctx);
    if (result?.ok !== true)
      throw new Error(`Transcript flow expected success at ${stage}`);
    return result;
  };
  // A provider retry repeats the request, so a failed step must not advance.
  const run = (ctx) => {
    if (ctx.role === 'child') {
      if (!childRead) {
        childRead = true;
        return reply(ctx, {
          toolCalls: [ctx.nativeRead('delegation-evidence.txt')],
          stopReason: 'tool_use',
        });
      }
      return ctx.reply({ text: ctx.finding, stopReason: 'end_turn' });
    }
    if (ctx.role !== 'parent') return undefined;
    // Tool-less helper requests (such as a title) carry the parent's text;
    // leave them to the runtime's default reply.
    if (!ctx.item.toolNames.length) return undefined;
    // After the first step the parent's own requests always carry results; a
    // side request without any gets a plain reply and never advances the flow.
    if (stage !== 'search' && !ctx.results)
      return ctx.reply({
        text: 'Waiting for the delegated task to settle.',
        stopReason: 'end_turn',
      });
    switch (stage) {
      case 'search':
        stage = 'spawn';
        return tool(ctx, ctx.toolName('SearchActions', 'search_actions'), {
          query: 'transcript content',
          category: 'chat',
          limit: 50,
        });
      case 'spawn': {
        const search = latestResult(ctx);
        const types = search?.actions?.map((action) => action.type) ?? [];
        if (
          ![
            'chat.transcript.page',
            'chat.content.read',
            'chat.transcript.blocks.page',
          ].every((type) => types.includes(type))
        )
          throw new Error('SearchActions did not advertise transcript reads');
        stage = 'settle';
        return tool(ctx, ctx.spawnTool, ctx.spawnInput);
      }
      case 'settle': {
        const watch = driveParentWatchFlow(ctx);
        if (watch) return reply(ctx, watch.step);
        if (!ctx.context.includes(ctx.finding)) {
          if (!ctx.results.includes('delegationId'))
            throw new Error(
              `DelegateTask returned no run: ${ctx.results.slice(0, 600)}`,
            );
          return ctx.reply({
            text: 'Waiting for the delegated task to settle.',
            stopReason: 'end_turn',
          });
        }
        stage = 'discovered';
        return tool(ctx, ctx.toolName('ListDelegates', 'list_delegates'), {});
      }
      case 'discovered': {
        const delegates = lastResult(ctx).value;
        if (!Array.isArray(delegates) || delegates.length !== 1)
          throw new Error('ListDelegates must discover exactly one live run');
        const run = delegates[0];
        if (
          run.status !== 'completed' ||
          typeof run.delegationId !== 'string' ||
          !Number.isSafeInteger(run.runGeneration) ||
          run.runGeneration < 1
        )
          throw new Error('ListDelegates did not expose a settled run locator');
        stage = 'live-page';
        return dispatch(ctx, {
          type: 'chat.transcript.page',
          target: {
            kind: 'delegation',
            chatId: fixture.chatId,
            delegationId: run.delegationId,
            runGeneration: run.runGeneration,
          },
        });
      }
      case 'live-page':
        lastResult(ctx);
        stage = 'newest';
        return dispatch(ctx, {
          type: 'chat.transcript.page',
          target: target(fixture.delegationId),
        });
      case 'newest': {
        const page = lastResult(ctx).result;
        const row = page.messages.find((message) =>
          message.blocks.some(
            (block) =>
              block.type === 'tool_result' && block.toolName === 'Read',
          ),
        );
        if (!row || typeof page.cursor !== 'string')
          throw new Error('Newest fixture page lacks its Read row or cursor');
        contentLocator = {
          target: target(fixture.delegationId),
          messageId: row.id,
          blockOrdinal: row.blocks.findIndex(
            (block) =>
              block.type === 'tool_result' && block.toolName === 'Read',
          ),
          field: 'output',
          fieldSource: 'logical',
        };
        stage = 'older';
        return dispatch(ctx, {
          type: 'chat.transcript.page',
          target: target(fixture.delegationId),
          cursor: page.cursor,
        });
      }
      case 'older':
        lastResult(ctx);
        stage = 'body-head';
        return dispatch(ctx, {
          type: 'chat.content.read',
          ...contentLocator,
          offset: 32,
          limit: 64,
        });
      case 'body-head': {
        const body = lastResult(ctx).result;
        if (!Number.isSafeInteger(body.byteLength) || body.byteLength < 64)
          throw new Error('Body range did not expose its stored byte length');
        stage = 'body-tail';
        return dispatch(ctx, {
          type: 'chat.content.read',
          ...contentLocator,
          offset: body.byteLength - 64,
          limit: 64,
        });
      }
      case 'body-tail':
        lastResult(ctx);
        stage = 'block-row';
        return dispatch(ctx, {
          type: 'chat.transcript.page',
          target: target(fixture.blocksDelegationId),
        });
      case 'block-row': {
        const page = lastResult(ctx).result;
        const row = page.messages.find((message) => message.blocksOmitted);
        if (!row) throw new Error('Block fixture page lacks its omitted row');
        stage = 'blocks';
        return dispatch(ctx, {
          type: 'chat.transcript.blocks.page',
          target: target(fixture.blocksDelegationId),
          messageId: row.id,
          firstBlockOrdinal: 0,
          limit: 16,
        });
      }
      case 'blocks':
        lastResult(ctx);
        stage = 'denied';
        // The foreign delegation exists and its owner reads it, so a not_found
        // here can only come from the workspace authorization.
        return dispatch(ctx, {
          type: 'chat.transcript.page',
          target: {
            kind: 'delegation',
            chatId: foreignChatId,
            delegationId: foreignDelegationId,
            runGeneration: 1,
          },
        });
      case 'denied': {
        const denied = latestResult(ctx);
        if (denied?.ok !== false || denied.error?.code !== 'not_found')
          throw new Error(
            `Foreign workspace transcript was not denied: ${JSON.stringify(
              denied ?? ctx.results.split('\n').at(-1),
            ).slice(0, 400)}`,
          );
        stage = 'done';
        return ctx.reply({
          text: 'Transcript action read flow complete.',
          stopReason: 'end_turn',
        });
      }
      default:
        return ctx.reply({
          text: 'Transcript action read flow complete.',
          stopReason: 'end_turn',
        });
    }
  };
  return (ctx) => {
    const before = stage;
    try {
      return run(ctx);
    } catch (error) {
      stage = before;
      throw error;
    }
  };
}
