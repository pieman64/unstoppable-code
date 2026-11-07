import type { GitHubTokenProvider } from '@github/copilot-sdk';
import { randomUUID } from 'node:crypto';
import {
  COPILOT_RECIPIENT_REASONING_EFFORTS,
  CopilotAssistantPatchSchema,
  type CopilotCallbackReply,
  type CopilotCallbackRequest,
  type CopilotRecipientResult,
} from '@canopy/protocol/copilot-recipient';
import {
  startCopilotRuntime,
  type CopilotRuntimeOptions,
  type OwnedCopilotRuntime,
} from './runtime';
import type { CopilotLocalExecution, CopilotLocalRuntime } from './local-host';
import type { CopilotSessionPolicy } from './session-policy';
import { runCopilotTurn, type CopilotTurnOptions } from './turn-driver';

/** These paths, server credentials and tool definitions are trusted host projections. */
export interface CopilotLocalPolicy extends Pick<
  CopilotSessionPolicy,
  | 'workingDirectory'
  | 'configDirectory'
  | 'systemPrompt'
  | 'mcpServers'
  | 'skillDirectories'
> {
  readonly tools?: CopilotSessionPolicy['tools'];
}
function unavailable(): never {
  throw new Error('Copilot recipient unavailable.');
}
async function notice(
  context: CopilotLocalExecution,
  request: Extract<CopilotCallbackRequest, { kind: 'notice' }>,
): Promise<void> {
  const reply = await context.callback(request);
  if (reply.kind !== 'notice' || !reply.accepted) unavailable();
}
function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > 65_536) unavailable();
  return encoded;
}
function allowed(
  reply: CopilotCallbackReply,
  kind: 'approval' | 'permission',
): boolean {
  return reply.kind === kind && reply.allow;
}

/** Wraps the extracted P3 engine, without exposing its SDK client or callbacks. */
type DriverRuntime = Pick<
  OwnedCopilotRuntime,
  'identity' | 'exited' | 'isClosed' | 'close'
> & {
  client: CopilotTurnOptions['runtime']['client'] & {
    rpc: {
      models: Pick<OwnedCopilotRuntime['client']['rpc']['models'], 'list'>;
      account: Pick<
        OwnedCopilotRuntime['client']['rpc']['account'],
        'getQuota'
      >;
    };
  };
};
export function bindCopilotLocalRuntime(
  owned: DriverRuntime,
  policy: CopilotLocalPolicy,
): CopilotLocalRuntime {
  return {
    identity: owned.identity,
    exited: owned.exited,
    isClosed: () => owned.isClosed(),
    close: () => owned.close(),
    async execute(purpose, context) {
      context.signal.throwIfAborted();
      if (purpose === 'models' || purpose === 'setup-probe') {
        const gitHubToken = await context.token();
        context.admit();
        context.signal.throwIfAborted();
        const response = await owned.client.rpc.models.list({ gitHubToken });
        context.signal.throwIfAborted();
        if (purpose === 'setup-probe')
          return { kind: 'setup-probe', available: true };
        if (response.models.length > 256) unavailable();
        return {
          kind: 'models',
          models: response.models
            .filter((model) => model.policy?.state === 'enabled')
            .map(
              (
                model,
              ): Extract<
                CopilotRecipientResult,
                { kind: 'models' }
              >['models'][number] => {
                const contextWindow =
                  model.capabilities.limits?.max_context_window_tokens;
                return {
                  id: model.id,
                  name: model.name,
                  supportsVision: model.capabilities.supports?.vision === true,
                  reasoningEfforts: (
                    ['none', ...COPILOT_RECIPIENT_REASONING_EFFORTS] as const
                  ).filter(
                    (effort) =>
                      model.capabilities.supports?.reasoningEffort === true &&
                      model.supportedReasoningEfforts?.includes(effort),
                  ),
                  ...(typeof contextWindow === 'number' &&
                  Number.isSafeInteger(contextWindow) &&
                  contextWindow > 0
                    ? { contextWindow }
                    : {}),
                };
              },
            ),
        };
      }
      if (purpose === 'quota') {
        const gitHubToken = await context.token();
        context.admit();
        context.signal.throwIfAborted();
        const response = await owned.client.rpc.account.getQuota({
          gitHubToken,
        });
        context.signal.throwIfAborted();
        return {
          kind: 'quota',
          snapshots: Object.entries(response.quotaSnapshots)
            .slice(0, 16)
            .flatMap(([id, quota]) =>
              quota
                ? [
                    {
                      id,
                      unlimited: quota.isUnlimitedEntitlement === true,
                      ...(Number.isFinite(quota.remainingPercentage) &&
                      quota.remainingPercentage >= 0 &&
                      quota.remainingPercentage <= 100
                        ? { remainingPercentage: quota.remainingPercentage }
                        : {}),
                      ...(quota.resetDate &&
                      Number.isFinite(Date.parse(quota.resetDate))
                        ? { resetsAt: new Date(quota.resetDate).toISOString() }
                        : {}),
                    },
                  ]
                : [],
            ),
        };
      }
      const turn = context.turn;
      if (!turn) unavailable();
      const token = await context.token();
      context.admit();
      context.signal.throwIfAborted();
      const result = await runCopilotTurn({
        ...policy,
        deferSuccessfulClose: true,
        model: turn.model,
        reasoningEffort: turn.reasoningEffort,
        prompt: turn.prompt,
        turnId: context.audience.operationId,
        sessionId:
          context.audience.kind === 'resume'
            ? context.audience.sessionId
            : undefined,
        signal: context.signal,
        secretValues: [token],
        runtime: {
          ...owned,
          tokenProviderForSession: (sessionId): GitHubTokenProvider => {
            // A resume token must never authorize a silent create recovery.
            if (
              context.audience.kind === 'resume' &&
              sessionId !== context.audience.sessionId
            )
              unavailable();
            return async ({ host, sessionId: requested }) => {
              if (
                !requested ||
                (sessionId !== undefined && requested !== sessionId)
              )
                unavailable();
              return context.sessionToken(host, requested);
            };
          },
        },
        tools: policy.tools?.map((tool) => ({
          ...tool,
          handler: async (args, invocation): Promise<string> => {
            const reply = await context.callback({
              kind: 'tool',
              toolCallId: invocation.toolCallId,
              toolName: tool.name,
              argumentsJson: json(args),
            });
            if (reply.kind !== 'tool') unavailable();
            return reply.result;
          },
        })),
        authorize: async (input) => {
          const reply = await context.callback({
            kind: 'approval',
            toolCallId: randomUUID(),
            toolName: input.toolName,
            argumentsJson: json(input.toolArgs),
          });
          if (reply.kind !== 'approval' || !reply.allow)
            return { decision: 'deny' };
          const modifiedArgs: unknown =
            reply.modifiedArgumentsJson === undefined
              ? undefined
              : JSON.parse(reply.modifiedArgumentsJson);
          return {
            decision: 'allow',
            ...(modifiedArgs === undefined ? {} : { modifiedArgs }),
          };
        },
        requestManagedPermission: async (request) => ({
          kind: allowed(
            await context.callback({
              kind: 'permission',
              requestJson: json(request),
            }),
            'permission',
          )
            ? 'approved'
            : 'reject',
        }),
        onUserInputRequest: async (
          request,
        ): Promise<{ answer: string; wasFreeform: boolean }> => {
          const reply = await context.callback({
            kind: 'input',
            question: request.question,
            choices: request.choices ?? [],
            allowFreeform: request.allowFreeform !== false,
          });
          if (reply.kind !== 'input') unavailable();
          return { answer: reply.answer, wasFreeform: reply.wasFreeform };
        },
        onSession: (sessionId) =>
          notice(context, { kind: 'notice', name: 'session', sessionId }),
        onPromptAccepted: (sessionId) =>
          notice(context, {
            kind: 'notice',
            name: 'prompt-accepted',
            sessionId,
          }),
        onToolsReady: (snapshot, servers) =>
          notice(context, {
            kind: 'notice',
            name: 'tools-ready',
            digest: snapshot.digest,
            servers: servers.map((server) => ({
              name: server.name,
              status: server.status,
            })),
          }),
        beforePrompt: () =>
          notice(context, { kind: 'notice', name: 'before-prompt' }),
        preparePrompt: async (sessionId) => {
          const reply = await context.callback({ kind: 'history', sessionId });
          if (reply.kind !== 'history') unavailable();
          return reply.prompt;
        },
        onSessionUnavailable: turn.recoverMissingSession
          ? async (): Promise<never> => {
              await notice(context, {
                kind: 'notice',
                name: 'session-unavailable',
              });
              // Recovery requires a new create audience/lease, not rebinding this one.
              unavailable();
            }
          : undefined,
        emit: (event): void => {
          context.emit({
            kind: 'patch',
            patch: CopilotAssistantPatchSchema.parse(event),
          });
        },
      });
      return { kind: 'turn', ...result };
    },
  };
}

/** Unselected daemon composition helper; no launch until explicitly invoked. */
export async function startCopilotLocalRuntime(
  options: CopilotRuntimeOptions,
  policy: CopilotLocalPolicy,
): Promise<CopilotLocalRuntime> {
  if (options.workingDirectory !== policy.workingDirectory) unavailable();
  return bindCopilotLocalRuntime(await startCopilotRuntime(options), policy);
}
