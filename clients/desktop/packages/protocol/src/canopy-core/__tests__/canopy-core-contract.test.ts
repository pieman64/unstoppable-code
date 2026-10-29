import { z } from 'zod';

import {
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
  CanopyCallerDescriptorSchema,
  CanopyErrorPayloadSchema,
  CanopyRequestMetadataSchema,
  composeCanopyQueryRegistries,
  composeCanopyInstructionRegistries,
  composeCanopyStreamRegistries,
  defineCanopyCommand,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
  CanopyStreamCursorSchema,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  type CanopyQueryHandlerMap,
  type CanopyQueryName,
  type CanopyQueryParams,
  type CanopyQueryResult,
  type CanopyInstructionName,
  type CorePlaneQueryName,
  type WorkerPlaneQueryName,
  COST_GRANTS,
  COST_INSTRUCTION_DEFINITIONS,
  COST_QUERY_DEFINITIONS,
  CostRefreshRequestSchema,
  CostIndexRefreshParamsSchema,
  CostScopeGetResultSchema,
  CostScopeRequestSchema,
} from '..';
import {
  CORE_INSTRUCTION_DEFINITIONS,
  CORE_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
} from '../core';
import { CoreChatSnapshotGetResultSchema } from '../core/chat/snapshot';
import {
  CoreChatTranscriptPageParamsSchema,
  CoreChatTranscriptPageResultSchema,
  CoreChatTranscriptSearchParamsSchema,
  CoreChatTranscriptSearchResultSchema,
  CoreChatToolOutputReadParamsSchema,
  CoreChatToolOutputReadResultSchema,
} from '../core';
import {
  WORKER_QUERY_DEFINITIONS,
  WorkerFilesystemDirectoryListParamsSchema,
  WorkerFilesystemDirectoryListResultSchema,
  WorkerFilesystemRootsListParamsSchema,
  WorkerFilesystemRootsListResultSchema,
} from '../worker';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type _QueryNamesAreExact = Expect<
  Equal<
    CanopyQueryName,
    | 'worker.filesystem.roots.list'
    | 'worker.filesystem.directory.list'
    | 'core.chat.snapshot.get'
    | 'core.chat.list'
    | 'core.workspace.list'
    | 'core.workspace.get'
    | 'core.chat.transcript.page'
    | 'core.chat.transcript.search'
    | 'core.chat.toolOutput.read'
    | 'core.chat.visual.read'
    | 'core.chat.send.receipt'
    | 'core.ledger.entries.search'
    | 'core.ledger.entry.get'
    | 'core.ledger.owners.list'
    | 'core.ledger.changes.list'
    | 'core.cost.scope.get'
    | 'core.cost.chat.get'
    | 'core.cost.pipelineRun.get'
  >
>;
type _WorkerNamesAreExact = Expect<
  Equal<
    WorkerPlaneQueryName,
    'worker.filesystem.roots.list' | 'worker.filesystem.directory.list'
  >
>;
type _CoreNamesAreExact = Expect<
  Equal<
    CorePlaneQueryName,
    | 'core.chat.snapshot.get'
    | 'core.chat.list'
    | 'core.workspace.list'
    | 'core.workspace.get'
    | 'core.chat.transcript.page'
    | 'core.chat.transcript.search'
    | 'core.chat.toolOutput.read'
    | 'core.chat.visual.read'
    | 'core.ledger.entries.search'
    | 'core.ledger.entry.get'
    | 'core.ledger.owners.list'
    | 'core.ledger.changes.list'
    | 'core.cost.scope.get'
    | 'core.cost.chat.get'
    | 'core.cost.pipelineRun.get'
  >
>;
type _CostRefreshInstructionIsRegistered = Expect<
  Equal<
    Extract<CanopyInstructionName, 'core.cost.index.refresh'>,
    'core.cost.index.refresh'
  >
>;
type _RootsParamsAreMapped = Expect<
  Equal<
    CanopyQueryParams<'worker.filesystem.roots.list'>,
    {
      scope: {
        organizationId?: string;
        workspaceId?: string;
        worktreeId?: string;
        chatId?: string;
        operationId?: string;
        executionId?: string;
        repoId?: string;
        authorityId?: string;
        targetId?: string;
      };
    }
  >
>;
type CompileTimeAssertions = [
  _QueryNamesAreExact,
  _WorkerNamesAreExact,
  _CoreNamesAreExact,
  _CostRefreshInstructionIsRegistered,
  _RootsParamsAreMapped,
];
const compileTimeAssertions: CompileTimeAssertions = [
  true,
  true,
  true,
  true,
  true,
];
void compileTimeAssertions;

const typedHandlers: Pick<
  CanopyQueryHandlerMap<{ requestId: string }>,
  | WorkerPlaneQueryName
  | 'core.chat.snapshot.get'
  | 'core.chat.list'
  | 'core.chat.transcript.page'
  | 'core.chat.transcript.search'
> = {
  'core.chat.snapshot.get': (params) => ({
    workspaceId: params.scope.workspaceId,
    worktreeId: params.scope.worktreeId,
    revision: 0,
    tabs: { activeTabId: '', items: [] },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  }),
  'core.chat.list': () => ({ items: [], nextCursor: null }),
  'core.chat.transcript.page': () => ({
    messages: [],
    totalMessages: 0,
    transcriptRevision: 0,
  }),
  'core.chat.transcript.search': () => ({ matches: [], totalCount: 0 }),
  'core.chat.toolOutput.read': () => ({ text: '', byteLength: 0 }),
  'core.chat.visual.read': () => ({
    data: '',
    offset: 0,
    length: 0,
    byteLength: 0,
    sha256: '0'.repeat(64),
  }),
  'worker.filesystem.roots.list': (params, context) =>
    Promise.resolve({
      roots: [
        {
          fileRootId: `${context.requestId}:${params.scope.workspaceId}`,
          name: 'Workspace',
          kind: 'workspace-root',
        },
      ],
    }),
  'worker.filesystem.directory.list': (params) => ({
    entries: [
      {
        name: params.relativePath || 'src',
        relativePath: params.relativePath,
        kind: 'directory',
        isIgnored: false,
        isIndexExcluded: false,
        isSymlink: false,
        hasChildren: true,
      },
    ],
  }),
};
void typedHandlers;

const rootResult: CanopyQueryResult<'worker.filesystem.roots.list'> = {
  roots: [
    {
      fileRootId: 'workspace-root',
      name: 'Workspace',
      kind: 'workspace-root',
    },
  ],
};
void rootResult;

describe('core chat read DTOs', () => {
  const scope = {
    workspaceId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
  };
  it('serializes each request and result and rejects unknown request fields', () => {
    const pairs = [
      [
        CoreChatTranscriptPageParamsSchema,
        { scope },
        CoreChatTranscriptPageResultSchema,
        { messages: [], totalMessages: 0, transcriptRevision: 1 },
      ],
      [
        CoreChatTranscriptSearchParamsSchema,
        { scope, query: 'hello' },
        CoreChatTranscriptSearchResultSchema,
        { matches: [], totalCount: 0 },
      ],
      [
        CoreChatToolOutputReadParamsSchema,
        {
          scope,
          messageId: 'message-1',
          toolUseId: 'tool-1',
          reference: {
            version: 1,
            artifactId: `sha256-v1-${'a'.repeat(64)}`,
            byteLength: 4,
            sha256: 'a'.repeat(64),
            encoding: 'utf-8',
            mediaType: 'text/plain',
          },
          offset: 0,
          limit: 4,
        },
        CoreChatToolOutputReadResultSchema,
        { text: 'test', byteLength: 4 },
      ],
    ] as const;
    for (const [paramsSchema, params, resultSchema, result] of pairs) {
      expect(paramsSchema.parse(JSON.parse(JSON.stringify(params)))).toEqual(
        params,
      );
      expect(resultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(
        result,
      );
      expect(
        paramsSchema.safeParse({ ...params, absolutePath: '/private' }).success,
      ).toBe(false);
    }
    expect(
      CoreChatTranscriptPageResultSchema.safeParse({
        messages: [
          {
            id: 'message-1',
            role: 'assistant',
            timestamp: 1,
            blocks: [],
            absolutePath: '/private',
          },
        ],
        totalMessages: 1,
        transcriptRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      CoreChatTranscriptPageResultSchema.safeParse({
        messages: [
          {
            id: 'message-1',
            role: 'assistant',
            timestamp: 1,
            blocks: [{ type: 'text', text: '/Users/alice/project/file.ts' }],
          },
        ],
        totalMessages: 1,
        transcriptRevision: 1,
      }).success,
    ).toBe(true);
    for (const block of [
      { type: 'image', path: '/Users/alice/private.png', alt: 'image' },
      { type: 'compaction_info', transcriptPath: '/Users/alice/raw.jsonl' },
      { type: 'revert_info', attachmentPath: '/Users/alice/revert.md' },
    ]) {
      expect(
        CoreChatTranscriptPageResultSchema.safeParse({
          messages: [
            {
              id: 'message-1',
              role: 'assistant',
              timestamp: 1,
              blocks: [block],
            },
          ],
          totalMessages: 1,
          transcriptRevision: 1,
        }).success,
      ).toBe(false);
    }
    expect(
      CoreChatTranscriptPageResultSchema.safeParse({
        messages: [
          {
            id: 'hidden-1',
            role: 'system',
            timestamp: 1,
            blocks: [],
            hidden: true,
          },
        ],
        totalMessages: 1,
        transcriptRevision: 1,
      }).success,
    ).toBe(false);
    for (const invalidScope of [
      { ...scope, workspaceId: '../outside' },
      { ...scope, workspaceId: 'a'.repeat(257) },
    ]) {
      expect(
        CoreChatTranscriptPageParamsSchema.safeParse({ scope: invalidScope })
          .success,
      ).toBe(false);
      expect(
        CoreChatTranscriptSearchParamsSchema.safeParse({
          scope: invalidScope,
          query: 'hello',
        }).success,
      ).toBe(false);
    }
    for (const invalid of [
      { scope, turnId: 'turn-1' },
      { scope, view: 'turns', turnId: '../bad' },
      { scope, archivedContainerId: 'another-worktree' },
      { scope, archivedContainerId: scope.worktreeId, standaloneHistory: true },
    ]) {
      expect(
        CoreChatTranscriptPageParamsSchema.safeParse(invalid).success,
      ).toBe(false);
    }
  });

  it('rejects malformed tool-output references, ranges, and scopes', () => {
    const valid = {
      scope,
      messageId: 'message-1',
      toolUseId: 'tool-1',
      reference: {
        version: 1,
        artifactId: `sha256-v1-${'a'.repeat(64)}`,
        byteLength: 4,
        sha256: 'a'.repeat(64),
        encoding: 'utf-8',
        mediaType: 'text/plain',
      },
      offset: 0,
      limit: 4,
    };
    for (const invalid of [
      { ...valid, scope: { worktreeId: 'worktree-1', chatId: 'chat-1' } },
      { ...valid, scope: { ...scope, workspaceId: '../outside' } },
      { ...valid, reference: { ...valid.reference, artifactId: 'other' } },
      { ...valid, offset: 5 },
      { ...valid, standaloneHistory: true, archivedContainerId: 'worktree-1' },
      { ...valid, archivedContainerId: 'other-worktree' },
    ])
      expect(
        CoreChatToolOutputReadParamsSchema.safeParse(invalid).success,
      ).toBe(false);
  });
});

const compileTimeDefinition = defineCanopyQuery({
  error: CanopyErrorPayloadSchema,
  plane: 'worker',
  domain: 'filesystem',
  version: 1,
  placement: 'target-selectable',
  idempotency: 'inherent',
  requiredGrants: ['worker.filesystem.read'],
  params: z.strictObject({}),
  result: z.looseObject({}),
});

function assertInvalidDefinitionsFailToCompile(): void {
  // @ts-expect-error a worker definition cannot require a core-owned grant
  defineCanopyQuery({
    error: CanopyErrorPayloadSchema,
    plane: 'worker',
    domain: 'filesystem',
    version: 1,
    placement: 'target-selectable',
    idempotency: 'inherent',
    requiredGrants: ['core.filesystem.read'],
    params: z.strictObject({}),
    result: z.looseObject({}),
  });

  // @ts-expect-error a worker definition cannot declare core-only placement
  defineCanopyQuery({
    error: CanopyErrorPayloadSchema,
    plane: 'worker',
    domain: 'filesystem',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['worker.filesystem.read'],
    params: z.strictObject({}),
    result: z.looseObject({}),
  });

  defineCanopyQueryRegistry('worker', {
    // @ts-expect-error definition-site registry keys cannot double a plane prefix
    'worker.worker.filesystem.read': compileTimeDefinition,
  });
}
void assertInvalidDefinitionsFailToCompile;

describe('universal Canopy query registry', () => {
  it('accepts only portable pending approval and TODO projections', () => {
    const result = {
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
      revision: 1,
      tabs: { activeTabId: '', items: [] },
      archives: [],
      runtimeByChatId: {},
      queue: [],
      pendingApprovals: [{ id: 'approval-1' }],
      todos: [{ id: 'todo-1' }],
    };
    expect(CoreChatSnapshotGetResultSchema.safeParse(result).success).toBe(
      true,
    );
    expect(
      CoreChatSnapshotGetResultSchema.parse({
        ...result,
        futureField: 'ignored',
        tabs: { ...result.tabs, hostPath: '/private/worktree' },
      }),
    ).toEqual(result);
    expect(
      CoreChatSnapshotGetResultSchema.safeParse({
        ...result,
        pendingApprovals: [(): undefined => undefined],
      }).success,
    ).toBe(false);
    expect(
      CoreChatSnapshotGetResultSchema.safeParse({
        ...result,
        todos: [new Date()],
      }).success,
    ).toBe(false);
  });

  it('publishes closed core and worker registries with exact metadata', () => {
    expect(Object.keys(CORE_QUERY_DEFINITIONS)).toEqual([
      'core.chat.send.receipt',
      'core.chat.snapshot.get',
      'core.chat.list',
      'core.chat.transcript.page',
      'core.chat.transcript.search',
      'core.chat.toolOutput.read',
      'core.chat.visual.read',
      'core.workspace.list',
      'core.workspace.get',
      'core.worktree.list',
      'core.worktree.get',
      'core.ledger.entries.search',
      'core.ledger.entry.get',
      'core.ledger.owners.list',
      'core.ledger.changes.list',
      'core.cost.scope.get',
      'core.cost.chat.get',
      'core.cost.pipelineRun.get',
    ]);
    expect(Object.keys(WORKER_QUERY_DEFINITIONS)).toEqual([
      'worker.filesystem.roots.list',
      'worker.filesystem.directory.list',
    ]);
    expect(CANOPY_QUERY_DEFINITIONS).toEqual({
      ...CORE_QUERY_DEFINITIONS,
      ...WORKER_QUERY_DEFINITIONS,
    });

    for (const definition of Object.values(WORKER_QUERY_DEFINITIONS)) {
      expect(definition).toMatchObject({
        kind: 'query',
        plane: 'worker',
        domain: 'filesystem',
        version: 1,
        placement: 'target-selectable',
        idempotency: 'inherent',
        requiredGrants: ['worker.filesystem.read'],
      });
    }
  });

  it('strictly validates requests at every nesting level', () => {
    expect(
      WorkerFilesystemRootsListParamsSchema.parse({
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
      }),
    ).toEqual({
      scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
    });
    expect(
      WorkerFilesystemRootsListParamsSchema.parse({
        scope: {
          authorityId: 'primary-authority',
          targetId: 'worker-target',
        },
      }),
    ).toEqual({
      scope: {
        authorityId: 'primary-authority',
        targetId: 'worker-target',
      },
    });

    const invalidRootsRequests = [
      {
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
        principalId: 'spoofed',
      },
      { scope: { unexpectedScopeId: 'spoofed' } },
      {
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
        grants: ['worker.filesystem.read'],
      },
      {
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
        placement: 'worker-only',
      },
    ];
    for (const request of invalidRootsRequests) {
      expect(
        WorkerFilesystemRootsListParamsSchema.safeParse(request).success,
      ).toBe(false);
    }

    expect(
      WorkerFilesystemDirectoryListParamsSchema.safeParse({
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
        fileRootId: 'workspace-root',
        relativePath: '',
        clientInstanceId: 'spoofed',
      }).success,
    ).toBe(false);
    expect(
      WorkerFilesystemDirectoryListParamsSchema.safeParse({
        scope: {},
        fileRootId: 'r'.repeat(513),
        relativePath: '',
      }).success,
    ).toBe(false);
    expect(
      WorkerFilesystemRootsListResultSchema.safeParse({
        roots: [
          {
            fileRootId: 'r'.repeat(513),
            name: 'Repository',
            kind: 'git-repo',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      WorkerFilesystemDirectoryListParamsSchema.parse({
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
        fileRootId: 'workspace-root',
        relativePath: '',
      }),
    ).toEqual({
      scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
      fileRootId: 'workspace-root',
      relativePath: '',
    });
    expect(
      WorkerFilesystemDirectoryListParamsSchema.safeParse({
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
        fileRootId: 'workspace-root',
        relativePath: '',
        hostPath: '/spoofed/target',
      }).success,
    ).toBe(false);
  });

  it('bounds optional catalog revisions on both filesystem queries', () => {
    for (const name of [
      'worker.filesystem.roots.list',
      'worker.filesystem.directory.list',
    ] as const) {
      const definition = CANOPY_QUERY_DEFINITIONS[name];
      const params = {
        scope: {},
        ...(name.includes('directory')
          ? { fileRootId: 'repo', relativePath: '' }
          : {}),
      };
      const result = name.includes('directory')
        ? { entries: [] }
        : { roots: [] };
      expect(definition.params.safeParse(params).success).toBe(true);
      expect(definition.result.safeParse(result).success).toBe(true);
      for (const revision of ['', 'a'.repeat(129), 7, null]) {
        expect(
          definition.params.safeParse({ ...params, catalogRevision: revision })
            .success,
        ).toBe(false);
        expect(
          definition.result.safeParse({ ...result, catalogRevision: revision })
            .success,
        ).toBe(false);
      }
      expect(
        definition.params.safeParse({
          ...params,
          catalogRevision: 'a'.repeat(128),
        }).success,
      ).toBe(true);
      expect(
        definition.params.safeParse({
          ...params,
          catalogRevision: 'r',
          unexpected: true,
        }).success,
      ).toBe(false);
    }
  });

  it('registers core.cost DTOs as closed contracts with only the read grant', () => {
    expect(Object.keys(COST_QUERY_DEFINITIONS).sort()).toEqual([
      'core.cost.chat.get',
      'core.cost.pipelineRun.get',
      'core.cost.scope.get',
    ]);
    expect(Object.keys(COST_INSTRUCTION_DEFINITIONS)).toEqual([
      'core.cost.index.refresh',
    ]);
    const request: CanopyQueryParams<'core.cost.scope.get'> = {
      scope: { kind: 'entry', projectId: 'project', worktreeId: 'entry' },
    };
    expect(CostScopeRequestSchema.parse(request)).toEqual(request);
    expect(
      CostScopeRequestSchema.safeParse({ ...request, untrusted: true }).success,
    ).toBe(false);
    expect(
      CostScopeRequestSchema.safeParse({
        scope: {
          kind: 'entry',
          projectId: 'project',
          worktreeId: 'entry',
          hostPath: '/not-a-DTO-field',
        },
      }).success,
    ).toBe(false);
    expect(
      CostRefreshRequestSchema.safeParse({
        scope: { kind: 'retained', projectId: 'project', containerId: 'c1' },
        trigger: 'manual',
      }).success,
    ).toBe(true);

    const totals = {
      usd: 0,
      bySource: {
        chat: 0,
        pipeline: 0,
        subagents: 0,
        delegations: 0,
        background: 0,
      },
      byBilling: {
        subscription: 0,
        ai_credits: 0,
        account_proxy: 0,
        api_key: 0,
        org_gateway: 0,
        local: 0,
        unknown: 0,
      },
      tokens: {
        input: 0,
        output: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
      },
      notPricedCount: 0,
      hasEstimate: false,
    };
    const scopePayload = {
      scope: request.scope,
      updatedAt: null,
      building: false,
      retentionDays: 7,
      totals,
      chats: [],
      pipelineRuns: [],
      hasCodexEstimate: false,
    };
    const scopeResult: CanopyQueryResult<'core.cost.scope.get'> = scopePayload;
    expect(CostScopeGetResultSchema.parse(scopeResult)).toEqual(scopeResult);
    expect(
      CostScopeGetResultSchema.safeParse({
        ...scopePayload,
        futureField: true,
      }).success,
    ).toBe(false);
    expect(
      CostScopeGetResultSchema.safeParse({
        status: 'ok',
        value: scopePayload,
      }).success,
    ).toBe(false);
    // A chat the account proxy served names its accounts (CAN-4021).
    const proxyAccount = {
      accountKey: 'proxy:conn-1:a1f3c2d4a1f3c2d4',
      label: 'sam@example.com',
      provider: 'claude',
      turnShare: 1.5,
      requestCount: 4,
      usd: 0.25,
      notPricedCount: 0,
    };
    const proxyScope = {
      ...scopePayload,
      chats: [
        {
          chatId: 'chat-1',
          label: 'Chat',
          state: 'open',
          totals,
          turnCount: 2,
          lastActivityAt: '2026-10-08T12:00:00.000Z',
          running: false,
          models: [],
          proxyAccounts: [proxyAccount],
        },
      ],
    };
    expect(CostScopeGetResultSchema.parse(proxyScope)).toEqual(proxyScope);
    expect(
      CostScopeGetResultSchema.safeParse({
        ...proxyScope,
        chats: [
          {
            ...proxyScope.chats[0],
            proxyAccounts: [{ ...proxyAccount, email: 'sam@example.com' }],
          },
        ],
      }).success,
    ).toBe(false);

    for (const definition of Object.values(COST_QUERY_DEFINITIONS)) {
      expect(definition).toMatchObject({
        plane: 'core',
        domain: 'cost',
        version: 1,
        placement: 'core-only',
        idempotency: 'inherent',
        requiredGrants: [COST_GRANTS.read],
      });
      expect(definition.requiredGrants).toEqual(['core.cost.read']);
    }
    const refresh = COST_INSTRUCTION_DEFINITIONS['core.cost.index.refresh'];
    expect(refresh).toMatchObject({
      plane: 'core',
      domain: 'cost',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [COST_GRANTS.read],
    });
    expect(
      refresh.params.safeParse({
        scope: { kind: 'entry', projectId: 'project', worktreeId: 'worktree' },
        trigger: 'manual',
      }).success,
    ).toBe(false);
    expect(
      CostIndexRefreshParamsSchema.safeParse({
        scope: { kind: 'entry', projectId: 'project', worktreeId: 'worktree' },
        trigger: 'manual',
        _meta: { idempotencyKey: 'cost-refresh-1' },
      }).success,
    ).toBe(true);
    expect(refresh.requiredGrants).toEqual(['core.cost.read']);
    expect(Object.keys(CORE_INSTRUCTION_DEFINITIONS)).toContain(
      'core.cost.index.refresh',
    );
  });

  it('retains additive fields at the result and row levels', () => {
    expect(
      WorkerFilesystemRootsListResultSchema.parse({
        roots: [
          {
            fileRootId: 'repo-1',
            name: 'repo',
            kind: 'git-repo',
            hostPath: '/must-not-cross-the-portable-boundary',
            futureRootField: { supported: true },
          },
        ],
        nextRootCursor: 'cursor',
      }),
    ).toEqual({
      roots: [
        {
          fileRootId: 'repo-1',
          name: 'repo',
          kind: 'git-repo',
          futureRootField: { supported: true },
        },
      ],
      nextRootCursor: 'cursor',
    });

    expect(
      WorkerFilesystemDirectoryListResultSchema.parse({
        entries: [
          {
            name: 'index.ts',
            relativePath: 'src/index.ts',
            hostPath: '/must-not-cross-the-portable-boundary/index.ts',
            kind: 'file',
            isIgnored: false,
            isIndexExcluded: false,
            isSymlink: false,
            hasChildren: false,
            futureEntryField: 1,
          },
        ],
        snapshotVersion: 2,
      }),
    ).toMatchObject({
      entries: [{ futureEntryField: 1 }],
      snapshotVersion: 2,
    });
    expect(
      WorkerFilesystemDirectoryListResultSchema.parse({
        entries: [
          {
            name: 'index.ts',
            relativePath: 'src/index.ts',
            hostPath: '/must-not-cross-the-portable-boundary/index.ts',
            kind: 'file',
            isIgnored: false,
            isIndexExcluded: false,
            isSymlink: false,
            hasChildren: false,
          },
        ],
      }).entries[0],
    ).not.toHaveProperty('hostPath');
  });

  it('rejects non-JSON-safe additive filesystem result fields', () => {
    const root = {
      fileRootId: 'repo-1',
      name: 'repo',
      kind: 'git-repo',
    } as const;
    const entry = {
      name: 'index.ts',
      relativePath: 'src/index.ts',
      kind: 'file',
      isIgnored: false,
      isIndexExcluded: false,
      isSymlink: false,
      hasChildren: false,
    } as const;

    expect(
      WorkerFilesystemRootsListResultSchema.safeParse({
        roots: [{ ...root, futureRootField: new Date() }],
      }).success,
    ).toBe(false);
    expect(
      WorkerFilesystemRootsListResultSchema.safeParse({
        roots: [root],
        futureResultField: new Map(),
      }).success,
    ).toBe(false);
    expect(
      WorkerFilesystemDirectoryListResultSchema.safeParse({
        entries: [{ ...entry, futureEntryField: new Error('nope') }],
      }).success,
    ).toBe(false);
    expect(
      WorkerFilesystemDirectoryListResultSchema.safeParse({
        entries: [entry],
        futureResultField: () => undefined,
      }).success,
    ).toBe(false);
  });

  it('validates additive fields without capping normal directory listings', () => {
    const entries = Array.from({ length: 300 }, (_, index) => ({
      name: `file-${index}.ts`,
      relativePath: `src/file-${index}.ts`,
      kind: 'file' as const,
      isIgnored: false,
      isIndexExcluded: false,
      isSymlink: false,
      hasChildren: false,
      futureEntryField: { sequence: index },
    }));

    const result = WorkerFilesystemDirectoryListResultSchema.parse({
      entries,
      futureResultField: { snapshotVersion: 2 },
    });
    expect(result.entries).toHaveLength(300);
    expect(result.entries[299]).toMatchObject({
      relativePath: 'src/file-299.ts',
    });
    expect(result.futureResultField).toEqual({ snapshotVersion: 2 });
  });

  it('enforces registry name, metadata, grant, placement, and uniqueness invariants', () => {
    const definition = defineCanopyQuery({
      error: CanopyErrorPayloadSchema,
      plane: 'worker',
      domain: 'filesystem',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: ['worker.filesystem.read'],
      params: z.strictObject({}),
      result: z.looseObject({}),
    });

    const invalidRegistries = [
      ['core.filesystem.read', definition],
      ['worker.session.read', definition],
      [
        'worker.filesystem.read',
        { ...definition, requiredGrants: ['core.filesystem.read'] },
      ],
      ['worker.filesystem.read', { ...definition, placement: 'core-only' }],
      ['worker.worker.filesystem.read', definition],
    ] as const;

    for (const [name, invalidDefinition] of invalidRegistries) {
      expect(() =>
        defineCanopyQueryRegistry('worker', {
          [name]: invalidDefinition,
        }),
      ).toThrow();
    }

    const first = defineCanopyQueryRegistry('worker', {
      'worker.filesystem.read': definition,
    });
    const duplicate = { ...first };
    expect(() => composeCanopyQueryRegistries(first, duplicate)).toThrow(
      /duplicate/i,
    );
  });
});

describe('common request and error contracts', () => {
  it('keeps trusted caller data separate and strict', () => {
    const caller = {
      principalId: 'principal',
      clientInstanceId: 'desktop:1',
      authorityId: 'local-desktop',
      interfaceKind: 'desktop',
      grants: ['worker.filesystem.read'],
    };
    expect(CanopyCallerDescriptorSchema.parse(caller)).toEqual(caller);
    expect(
      CanopyCallerDescriptorSchema.safeParse({ ...caller, placement: 'worker' })
        .success,
    ).toBe(false);

    const metadata = {
      idempotencyKey: 'request-key',
      deadlineAt: '2026-08-21T15:00:00.000Z',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'vendor=value',
    };
    expect(CanopyRequestMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(
      CanopyRequestMetadataSchema.safeParse({ ...metadata, requestId: 'nope' })
        .success,
    ).toBe(false);
  });

  it('round-trips stable errors and rejects non-JSON details', () => {
    const payload = {
      kind: 'permission_denied',
      message: 'The caller does not have the required grant.',
      code: 'worker.filesystem.grantMissing',
      details: {
        operation: 'worker.filesystem.directory.list',
        requiredGrants: ['worker.filesystem.read'],
      },
      retry: { kind: 'after_refresh', resource: 'caller-grants', delayMs: 10 },
    };
    const parsed = CanopyErrorPayloadSchema.parse(payload);
    expect(
      CanopyErrorPayloadSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(payload);

    for (const details of [
      new Date(),
      new Error('nope'),
      new Map([['key', 'value']]),
      new Set(['value']),
      1n,
      (): undefined => undefined,
    ]) {
      expect(
        CanopyErrorPayloadSchema.safeParse({
          kind: 'internal',
          message: 'Failure',
          details,
          retry: { kind: 'never' },
        }).success,
      ).toBe(false);
    }

    expect(
      CanopyErrorPayloadSchema.safeParse({
        kind: 'internal',
        message: 'Failure',
        details: { oversized: 'x'.repeat(32_769) },
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
  });

  it('registers core queries, chat instructions and events, and aliases command to instruction', () => {
    expect(Object.keys(CORE_QUERY_DEFINITIONS).sort()).toEqual([
      'core.chat.list',
      'core.chat.send.receipt',
      'core.chat.snapshot.get',
      'core.chat.toolOutput.read',
      'core.chat.transcript.page',
      'core.chat.transcript.search',
      'core.chat.visual.read',
      'core.cost.chat.get',
      'core.cost.pipelineRun.get',
      'core.cost.scope.get',
      'core.ledger.changes.list',
      'core.ledger.entries.search',
      'core.ledger.entry.get',
      'core.ledger.owners.list',
      'core.workspace.get',
      'core.workspace.list',
      'core.worktree.get',
      'core.worktree.list',
    ]);
    expect(Object.keys(CANOPY_INSTRUCTION_DEFINITIONS).sort()).toEqual([
      'core.chat.archive',
      'core.chat.create',
      'core.chat.delete',
      'core.chat.fork',
      'core.chat.message.send',
      'core.chat.queue.entry.cancel',
      'core.chat.queue.entry.force',
      'core.chat.queue.entry.update',
      'core.chat.update',
      'core.cost.index.refresh',
      'core.ledger.entry.add',
      'core.ledger.entry.update',
      'core.ledger.summary.publish',
    ]);
    expect(Object.keys(CANOPY_STREAM_DEFINITIONS)).toEqual([
      'core.chat.events',
    ]);
    expect(defineCanopyCommand).toBe(defineCanopyInstruction);
    const instruction = defineCanopyInstruction({
      plane: 'core',
      domain: 'example',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.example.write'],
      params: z.strictObject({}),
      result: z.strictObject({}),
      error: CanopyErrorPayloadSchema,
    });
    const registry = defineCanopyInstructionRegistry('core', {
      'core.example.write': instruction,
    });
    expect(composeCanopyInstructionRegistries(registry)).toEqual(registry);
    expect(() =>
      composeCanopyInstructionRegistries(registry, registry),
    ).toThrow('Duplicate');
    expect(() =>
      defineCanopyInstructionRegistry('core', {
        'core.example.write': { ...instruction, kind: 'query' },
      }),
    ).toThrow('kind instruction');
  });

  it('keeps handler-less transport definitions out of the dispatched registries', () => {
    expect(Object.keys(CORE_TRANSPORT_QUERY_DEFINITIONS)).toEqual([
      'core.runtime.initialize',
      'core.runtime.health.get',
      'core.runtime.manifest.get',
    ]);
    expect(Object.keys(CORE_TRANSPORT_INSTRUCTION_DEFINITIONS)).toEqual([
      'core.client.lease.acquire',
      'core.client.lease.renew',
      'core.client.lease.release',
      'core.client.capabilities.register',
      'core.events.ack',
    ]);
    expect(Object.keys(CORE_TRANSPORT_STREAM_DEFINITIONS)).toEqual([
      'core.runtime.events',
      'core.events.subscribe',
    ]);
    // Composing proves the names are disjoint from the dispatched registries.
    expect(() =>
      composeCanopyQueryRegistries(
        CANOPY_QUERY_DEFINITIONS,
        CORE_TRANSPORT_QUERY_DEFINITIONS,
      ),
    ).not.toThrow();
    expect(() =>
      composeCanopyInstructionRegistries(
        CANOPY_INSTRUCTION_DEFINITIONS,
        CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
      ),
    ).not.toThrow();
    expect(() =>
      composeCanopyStreamRegistries(
        CANOPY_STREAM_DEFINITIONS,
        CORE_TRANSPORT_STREAM_DEFINITIONS,
      ),
    ).not.toThrow();
    expect(
      CORE_TRANSPORT_QUERY_DEFINITIONS['core.runtime.initialize']
        .requiredGrants,
    ).toEqual([]);
    const acquire =
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.client.lease.acquire'];
    expect(acquire.idempotency).toBe('keyed');
    const params = {
      clientInstanceId: 'client-1',
      interfaceKind: 'cli',
      label: 'CLI',
      interactive: true,
      foreground: true,
      renewalIntervalMs: 15_000,
    };
    expect(acquire.params.safeParse(params).success).toBe(false);
    expect(
      acquire.params.safeParse({ ...params, _meta: { idempotencyKey: 'k1' } })
        .success,
    ).toBe(true);
    expect(
      acquire.params.safeParse({
        ...params,
        interfaceKind: 'worker',
        _meta: { idempotencyKey: 'k1' },
      }).success,
    ).toBe(false);
  });

  it('requires the fields of each chat change variant', () => {
    const item = {
      schemaVersion: 1,
      eventId: 'event-1',
      occurredAt: '2026-09-30T19:00:00Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 0,
      revision: 1,
      changes: [{ type: 'tab.removed' }],
    };
    const schema = CANOPY_STREAM_DEFINITIONS['core.chat.events'].item;
    expect(schema.safeParse(item).success).toBe(false);
    expect(
      schema.safeParse({
        ...item,
        changes: [{ type: 'tab.removed', tabId: 'tab-1' }],
      }).success,
    ).toBe(true);
  });

  it('requires an explicit chat event scope and rejects host paths in blocks', () => {
    const stream = CANOPY_STREAM_DEFINITIONS['core.chat.events'];
    expect(stream.params.safeParse({}).success).toBe(false);
    expect(stream.params.safeParse({ scope: 'all' }).success).toBe(true);
    expect(
      stream.params.safeParse({
        scope: { projectId: 'project-1', worktreeId: 'worktree-1' },
      }).success,
    ).toBe(true);
    const item = {
      schemaVersion: 1,
      eventId: 'event-1',
      occurredAt: '2026-09-30T19:00:00Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 0,
      revision: 1,
      changes: [
        {
          type: 'message.upserted',
          chatId: 'tab-1',
          message: {
            id: 'message-1',
            role: 'user',
            timestamp: 1,
            blocks: [
              { type: 'image', path: '/private/image.png', alt: 'image' },
            ],
          },
        },
      ],
    };
    expect(stream.item.safeParse(item).success).toBe(false);
    item.changes[0].message.blocks[0].path = '';
    expect(stream.item.safeParse(item).success).toBe(false);
    const portableImage = { type: 'image', alt: 'image' };
    expect(
      stream.item.safeParse({
        ...item,
        changes: [
          {
            ...item.changes[0],
            message: { ...item.changes[0].message, blocks: [portableImage] },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('validates stream cursors and kind metadata', () => {
    expect(
      CanopyStreamCursorSchema.safeParse({ daemonEpoch: 'epoch', sequence: 0 })
        .success,
    ).toBe(true);
    expect(
      CanopyStreamCursorSchema.safeParse({ daemonEpoch: 'epoch', sequence: -1 })
        .success,
    ).toBe(false);
    expect(
      CanopyStreamCursorSchema.safeParse({
        daemonEpoch: 'epoch',
        sequence: 0,
        extra: true,
      }).success,
    ).toBe(false);
    const stream = defineCanopyStream({
      plane: 'core',
      domain: 'example',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.example.read'],
      params: z.strictObject({
        cursor: CanopyStreamCursorSchema.nullable().optional(),
      }),
      item: z.strictObject({ value: z.string() }),
      end: z.strictObject({
        cursor: CanopyStreamCursorSchema,
        outcome: z.enum(['completed', 'cancelled', 'error']),
        error: CanopyErrorPayloadSchema.nullable(),
      }),
      error: CanopyErrorPayloadSchema,
    });
    const registry = defineCanopyStreamRegistry('core', {
      'core.example.events': stream,
    });
    expect(composeCanopyStreamRegistries(registry)).toEqual(registry);
    expect(() => composeCanopyStreamRegistries(registry, registry)).toThrow(
      'Duplicate',
    );
    expect(() =>
      defineCanopyStreamRegistry('core', {
        'core.example.events': { ...stream, idempotency: 'keyed' },
      }),
    ).toThrow('inherently idempotent');
  });
});
