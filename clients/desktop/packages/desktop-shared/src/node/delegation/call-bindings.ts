import { createHash, randomBytes } from 'node:crypto';
import {
  parseAgentDelegationSpawnRequest,
  type AgentDelegationResult,
  type AgentDelegationSpawnRequest,
} from '@canopy/protocol/delegation';
import {
  hasValidDelegationLineage,
  type DelegationParentContext,
} from './types';

export type DelegationParentOwner = Omit<DelegationParentContext, 'toolCallId'>;

function ownerKey(owner: DelegationParentOwner): string {
  return JSON.stringify([
    owner.harnessId,
    owner.projectId,
    owner.worktreeId,
    owner.chatId,
    owner.sessionKey,
    owner.turnId,
    owner.runtimeGeneration,
    owner.depth,
    owner.parentDelegationId,
    owner.parentRunGeneration,
  ]);
}

function requestKey(request: AgentDelegationSpawnRequest): string | undefined {
  const parsed = parseAgentDelegationSpawnRequest(request);
  return parsed.ok
    ? createHash('sha256').update(JSON.stringify(parsed.value)).digest('hex')
    : undefined;
}

function unavailable(): AgentDelegationResult<never> {
  return {
    ok: false,
    error: {
      code: 'parent_unavailable',
      message:
        'The delegation caller is unavailable or does not match this request.',
      retryable: false,
    },
  };
}

/** Host-only bridge between a provider hook and its MCP transport. */
export class DelegationCallBindings {
  private readonly byCall = new Map<
    string,
    { token: string; requestKey: string; context: DelegationParentContext }
  >();
  private readonly byToken = new Map<
    string,
    { requestKey: string; context: DelegationParentContext }
  >();
  private readonly owner: DelegationParentOwner;
  private readonly key: string;
  private disposed = false;
  private readonly onAbort = (): void => {
    this.dispose();
  };

  constructor(
    owner: DelegationParentOwner,
    private readonly signal: AbortSignal,
  ) {
    this.owner = Object.freeze({
      harnessId: owner.harnessId,
      projectId: owner.projectId,
      worktreeId: owner.worktreeId,
      chatId: owner.chatId,
      sessionKey: owner.sessionKey,
      turnId: owner.turnId,
      runtimeGeneration: owner.runtimeGeneration,
      depth: owner.depth,
      parentDelegationId: owner.parentDelegationId,
      parentRunGeneration: owner.parentRunGeneration,
      parentDescription: owner.parentDescription,
      userMessageId: owner.userMessageId,
    });
    this.key = ownerKey(this.owner);
    signal.addEventListener('abort', this.onAbort, { once: true });
    if (signal.aborted) this.dispose();
  }

  bind(
    toolCallId: string,
    request: AgentDelegationSpawnRequest,
  ): AgentDelegationResult<string> {
    if (
      this.disposed ||
      this.signal.aborted ||
      !hasValidDelegationLineage(this.owner) ||
      !Number.isSafeInteger(this.owner.runtimeGeneration) ||
      this.owner.runtimeGeneration < 1 ||
      !toolCallId ||
      toolCallId.length > 512 ||
      [
        this.owner.harnessId,
        this.owner.projectId,
        this.owner.worktreeId,
        this.owner.chatId,
        this.owner.sessionKey,
        this.owner.turnId,
      ].some((id) => !id || id.length > 512)
    )
      return unavailable();
    const fingerprint = requestKey(request);
    if (!fingerprint) return unavailable();
    const prior = this.byCall.get(toolCallId);
    if (prior)
      return prior.requestKey === fingerprint
        ? { ok: true, value: prior.token }
        : unavailable();
    if (this.byCall.size >= 64)
      return {
        ok: false,
        error: {
          code: 'capacity_exceeded',
          message: 'The parent turn reached its delegation call limit.',
          retryable: false,
        },
      };
    const token = randomBytes(32).toString('base64url');
    const binding = {
      token,
      requestKey: fingerprint,
      context: Object.freeze({ ...this.owner, toolCallId }),
    };
    this.byCall.set(toolCallId, binding);
    this.byToken.set(token, binding);
    return { ok: true, value: token };
  }

  resolve(
    token: string,
    request: AgentDelegationSpawnRequest,
    owner: DelegationParentOwner,
  ): AgentDelegationResult<DelegationParentContext> {
    if (this.disposed || this.signal.aborted || this.key !== ownerKey(owner))
      return unavailable();
    const binding = this.byToken.get(token);
    if (!binding || binding.requestKey !== requestKey(request))
      return unavailable();
    return { ok: true, value: binding.context };
  }

  dispose(): void {
    this.disposed = true;
    this.signal.removeEventListener('abort', this.onAbort);
    this.byCall.clear();
    this.byToken.clear();
  }
}
