import { randomUUID } from 'node:crypto';
import {
  LEDGER_GRANTS,
  LedgerAddEntryParamsSchema,
  LedgerUpdateEntryParamsSchema,
  type CanopyCallerDescriptor,
  type LedgerAuthorDetails,
  type LedgerContainer,
  type LedgerEntry,
  type LedgerGlobalOwner,
} from '@canopy/protocol/canopy-core';
import type { LedgerTaskViewScope } from '@canopy/protocol/ledger-view';
import { DESKTOP_LEDGER_TOOLS_HOST } from '../canopy-tools/ledger-tools-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { LEDGER_USER_ACTOR_DISPLAY_NAME } from './actor-directory';
import {
  getLedgerCallerBindingRegistry,
  type LedgerCallerBindingRegistration,
} from './caller-bindings';
import { withLedgerChangesWithheldForE2e } from './change-events';
import { resolveDesktopGlobalLedgerScope } from './core-ledger-adapter';
import {
  getLedgerPipelineAgentOwners,
  retireLedgerPipelineExecution,
} from './pipeline-agent-owners';
import { resolveLedgerContainerCreatedAt } from './scope-bindings';
import { ledgerContainerForViewScope } from './view-scope';

/*
 * E2E-only seeding for the Ledger panel specs. Every entry is written through
 * the desktop dispatcher, by the user, a chat, a pipeline agent or a managed
 * delegate, exactly as the panel and agent tools write; nothing reaches the
 * store directly.
 * Installed only in the E2E build (`__CANOPY_E2E__`).
 */

/**
 * Where a seeded entry goes: a task, or an owner's global (workflow) Ledger
 * for the signed-in account, which seeding binds as a pipeline run does.
 */
export type E2eLedgerScope =
  | LedgerTaskViewScope
  | { readonly kind: 'global'; readonly owner: LedgerGlobalOwner };

/** Who writes a seeded entry. */
export type E2eLedgerAuthor =
  | { readonly kind: 'user' }
  | {
      readonly kind: 'chat';
      readonly chatId: string;
      readonly displayName: string;
    }
  /** The agent of one step of a seeded pipeline execution's job. */
  | {
      readonly kind: 'pipeline';
      readonly executionId: string;
      readonly jobId: string;
      readonly stepId: string;
      readonly displayName: string;
    }
  /** A managed delegate that a seeded chat started. */
  | {
      readonly kind: 'delegate';
      readonly delegationId: string;
      readonly displayName: string;
      readonly rootChatId: string;
      readonly rootChatName: string;
    };

export interface E2eLedgerAddRequest {
  readonly scope: E2eLedgerScope;
  readonly author: E2eLedgerAuthor;
  readonly params: unknown;
}

export interface E2eLedgerUpdateRequest {
  readonly scope: E2eLedgerScope;
  readonly author: E2eLedgerAuthor;
  readonly params: unknown;
  /**
   * Commits without telling interfaces, as if the change had not reached
   * them yet: an open panel keeps the earlier revision.
   */
  readonly quiet?: boolean;
}

/** The agent session the E2E build gives a seeded pipeline agent. */
function e2ePipelineAgentSessionId(
  executionId: string,
  jobId: string,
  stepId: string,
): string {
  return `e2e-${executionId}-${jobId}-${stepId}`;
}

const SEEDED_AUTHOR_DETAILS: LedgerAuthorDetails = {
  harness: 'claude',
  model: 'claude-e2e',
  thinkingEffort: null,
  mode: null,
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: null,
};

const USER_AUTHOR_DETAILS: LedgerAuthorDetails = {
  ...SEEDED_AUTHOR_DETAILS,
  harness: null,
  model: null,
  unavailableReason: 'not_applicable',
};

/** The container incarnation a seeded entry goes to. */
async function incarnationFor(scope: E2eLedgerScope): Promise<{
  readonly container: LedgerContainer;
  readonly containerCreatedAt: string;
}> {
  if ('kind' in scope) {
    const bound = await resolveDesktopGlobalLedgerScope(scope.owner);
    return {
      container: bound.container,
      containerCreatedAt: bound.containerCreatedAt,
    };
  }
  const container = ledgerContainerForViewScope(scope);
  if (container === null) throw new Error('The scope has no Ledger.');
  const containerCreatedAt = await resolveLedgerContainerCreatedAt(container);
  if (containerCreatedAt === null) {
    throw new Error('The scope no longer exists.');
  }
  return { container, containerCreatedAt };
}

async function bindingFor(
  scope: E2eLedgerScope,
  author: E2eLedgerAuthor,
): Promise<LedgerCallerBindingRegistration> {
  const { container, containerCreatedAt } = await incarnationFor(scope);
  switch (author.kind) {
    case 'user':
      return {
        container,
        containerCreatedAt,
        actor: {
          kind: 'user',
          originKey: 'local',
          displayName: LEDGER_USER_ACTOR_DISPLAY_NAME,
        },
        role: 'user',
        authorDetails: USER_AUTHOR_DETAILS,
        runtimeGeneration: 0,
        ttlMs: 60_000,
      };
    case 'chat':
      return {
        container,
        containerCreatedAt,
        actor: {
          kind: 'chat',
          originKey: author.chatId,
          displayName: author.displayName,
        },
        role: 'interactive_chat',
        authorDetails: SEEDED_AUTHOR_DETAILS,
        runtimeGeneration: 0,
        ttlMs: 60_000,
      };
    case 'pipeline': {
      const agentSessionId = e2ePipelineAgentSessionId(
        author.executionId,
        author.jobId,
        author.stepId,
      );
      return {
        container,
        containerCreatedAt,
        actor: {
          kind: 'pipeline_agent',
          originKey: agentSessionId,
          displayName: author.displayName,
        },
        role: 'pipeline_agent',
        authorDetails: {
          ...SEEDED_AUTHOR_DETAILS,
          pipelineExecutionId: author.executionId,
        },
        runtimeGeneration: 0,
        ttlMs: 60_000,
        origin: {
          kind: 'pipeline_agent',
          executionId: author.executionId,
          physicalJobId: author.jobId,
          logicalJobId: author.jobId,
          stepId: author.stepId,
          attempt: 1,
          iteration: 0,
          agentSessionId,
        },
      };
    }
    case 'delegate':
      return {
        container,
        containerCreatedAt,
        actor: {
          kind: 'managed_delegation',
          originKey: author.delegationId,
          displayName: author.displayName,
        },
        role: 'managed_delegation',
        authorDetails: SEEDED_AUTHOR_DETAILS,
        // A delegate's binding generation is its run generation.
        runtimeGeneration: 1,
        ttlMs: 60_000,
        origin: {
          kind: 'managed_delegation',
          delegationId: author.delegationId,
          parent: {
            kind: 'chat',
            originKey: author.rootChatId,
            displayName: author.rootChatName,
          },
          root: { kind: 'chat', chatId: author.rootChatId },
          runGeneration: 1,
        },
      };
  }
}

async function runAs<Result>(
  scope: E2eLedgerScope,
  author: E2eLedgerAuthor,
  command: (
    dispatcher: NonNullable<
      ReturnType<typeof DESKTOP_LEDGER_TOOLS_HOST.dispatcher>
    >,
    principalId: string,
  ) => Promise<Result>,
): Promise<Result> {
  const dispatcher = DESKTOP_LEDGER_TOOLS_HOST.dispatcher();
  if (dispatcher === null) throw new Error('The Ledger runtime is not ready.');
  const registry = getLedgerCallerBindingRegistry();
  const bindingId = registry.register(await bindingFor(scope, author));
  try {
    return await command(dispatcher, bindingId);
  } finally {
    registry.revoke(bindingId);
  }
}

function callerFor(principalId: string): CanopyCallerDescriptor {
  return {
    principalId,
    clientInstanceId: 'desktop-main-e2e',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'daemon',
    grants: [LEDGER_GRANTS.read, LEDGER_GRANTS.write],
  };
}

/** Adds an entry as the given author; resolves with the committed entry. */
export async function addLedgerEntryForE2e(
  request: E2eLedgerAddRequest,
): Promise<LedgerEntry> {
  const params = LedgerAddEntryParamsSchema.parse(request.params);
  const idempotencyKey = `e2e:${randomUUID()}`;
  const receipt = await runAs(
    request.scope,
    request.author,
    (dispatcher, principalId) =>
      dispatcher.instruction(
        'core.ledger.entry.add',
        { ...params, _meta: { idempotencyKey } },
        { caller: callerFor(principalId), metadata: { idempotencyKey } },
      ),
  );
  return receipt.entry;
}

/** Updates an entry as the given author; resolves with the committed entry. */
export async function updateLedgerEntryForE2e(
  request: E2eLedgerUpdateRequest,
): Promise<LedgerEntry> {
  const params = LedgerUpdateEntryParamsSchema.parse(request.params);
  const update = (): Promise<LedgerEntry> => {
    const idempotencyKey = `e2e:${randomUUID()}`;
    return runAs(request.scope, request.author, (dispatcher, principalId) =>
      dispatcher.instruction(
        'core.ledger.entry.update',
        { ...params, _meta: { idempotencyKey } },
        { caller: callerFor(principalId), metadata: { idempotencyKey } },
      ),
    ).then((receipt) => receipt.entry);
  };
  return request.quiet === true
    ? withLedgerChangesWithheldForE2e(update)
    : update();
}

export interface E2ePausedPipelineAgent {
  readonly scope: E2eLedgerScope;
  readonly executionId: string;
  readonly jobId: string;
  readonly stepId: string;
  readonly displayName: string;
  readonly checkpointId: string;
}

/**
 * Records a pipeline agent paused on a recovery checkpoint, as the pipeline
 * host does when a real agent attempt pauses, so owner pickers offer it.
 */
export function pausePipelineAgentForE2e(agent: E2ePausedPipelineAgent): void {
  const container: LedgerContainer | null =
    'kind' in agent.scope
      ? { kind: 'global', owner: agent.scope.owner }
      : ledgerContainerForViewScope(agent.scope);
  if (container === null) throw new Error('The scope has no Ledger.');
  getLedgerPipelineAgentOwners().notePaused({
    agentSessionId: e2ePipelineAgentSessionId(
      agent.executionId,
      agent.jobId,
      agent.stepId,
    ),
    displayName: agent.displayName,
    executionId: agent.executionId,
    jobId: agent.jobId,
    stepId: agent.stepId,
    attempt: 1,
    container,
    checkpointId: agent.checkpointId,
    pausedAt: new Date().toISOString(),
  });
}

/** Resumes an execution's paused agents, as a saved resume does. */
export function resumePipelineExecutionForE2e(
  executionId: string,
): Promise<void> {
  return retireLedgerPipelineExecution(executionId);
}
