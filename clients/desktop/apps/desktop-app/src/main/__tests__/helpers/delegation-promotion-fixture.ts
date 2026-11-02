import { join } from 'node:path';
import crypto from 'node:crypto';
import type { AgentDelegationTranscriptItem } from '@canopy/protocol/delegation';
import {
  delegationChildMessages,
  type DelegatedAgentCallBlock,
  type DelegationChildRow,
} from '@canopy/agent-transcript';
import type { AgentDelegationBrokerOptions } from '@canopy/desktop-shared/node/delegation/broker';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import { readMetadataOfRecord } from '@canopy/desktop-shared/node/delegation/record-v3';
import {
  baseTask,
  createBrokerHarness,
  rootParent,
  flushBroker,
} from '../../../../../../packages/desktop-shared/src/node/delegation/__tests__/broker-harness';
import { routeFixture } from '../../../../../../packages/desktop-shared/src/node/delegation/__tests__/fixtures';
import { ChatStorageV2 } from '../../lib/chat-storage-v2';
import { ChatDelegationLogs } from '../../lib/chat-delegation-log';
import { ChatStateService } from '../../services/chat-state-service';
import {
  ChatStateV2Repository,
  type ChatStateV2RepositoryOptions,
} from '../../services/chat-state-v2-repository';
import { RepositoryDelegationTranscriptPort } from '../../agents/delegation/repository-transcript-port';
import { message, scopeSource } from './chat-delta-journal-harness';

export const H_SCOPE = { projectId: 'h-project', worktreeId: 'h-scope' };
export const H_CHAT = 'h-chat';
export const H_PARENT = {
  ...rootParent,
  ...H_SCOPE,
  chatId: H_CHAT,
  sessionKey: 'h-project/h-scope/h-chat',
};
export const H_ID = '11111111-1111-4111-8111-111111111111';
export const H_INLINE = '22222222-2222-4222-8222-222222222222';
export const H_LOG = '33333333-3333-4333-8333-333333333333';
export const H_CONTROL = [
  '',
  '',
  '44444444-4444-4444-8444-444444444442',
  '44444444-4444-4444-8444-444444444443',
  '44444444-4444-4444-8444-444444444444',
  '44444444-4444-4444-8444-444444444445',
];
export const H_PROMPTS = [
  '',
  'First prompt 🌲',
  'Second prompt 漢',
  'Third prompt 🦎',
  'Fourth stream prompt 🌿',
  'Fifth compatibility prompt',
];
export const H_BODIES = [
  '',
  'First answer 🌲\ud800',
  'Second answer 漢\udc00',
  'Third answer 🦎',
  'Fourth stream answer 🌿',
];

export function hDirectory(root: string): string {
  return join(root, H_SCOPE.projectId, H_SCOPE.worktreeId);
}
export function hPaths(root: string): {
  tabs: string;
  archives: string;
  journal: string;
} {
  const directory = hDirectory(root);
  return {
    tabs: join(directory, `${H_SCOPE.worktreeId}.json`),
    archives: join(directory, 'archives.json'),
    journal: join(directory, 'journal.json'),
  };
}
export function hRuns(root: string): string {
  return join(hDirectory(root), 'delegation', 'runs');
}
export function hTarget(
  delegationId = H_ID,
  runGeneration = 1,
): {
  kind: 'delegation';
  chatId: string;
  delegationId: string;
  runGeneration: number;
} {
  return {
    kind: 'delegation' as const,
    chatId: H_CHAT,
    delegationId,
    runGeneration,
  };
}

function legacyCard(id: string, log: boolean): DelegatedAgentCallBlock {
  const { authAccountKey: _privateFixtureKey, ...route } = routeFixture();
  void _privateFixtureKey;
  return {
    type: 'delegated_agent_call',
    delegationId: id,
    runGeneration: 1,
    status: 'completed',
    outputTruncated: log,
    agentBlockId: `delegated-agent-${id}`,
    sequence: 1,
    parentHarnessId: 'claude',
    parentTurnId: 'turn-1',
    parentToolCallId: `call-${id}`,
    createdAt: 1,
    routeSnapshot: route,
    selectedModelId: 'logical-review-model',
    runtimeModelId: 'native-model',
    targetHarnessId: 'third-harness',
    description: log ? 'Log fixture' : 'Inline fixture',
    prompt: log ? 'Log prompt' : 'Inline prompt',
    executionMode: 'background',
    ...(log ? { transcriptStore: 'chat-log-v1' as const } : {}),
  };
}

export async function seedHLegacy(root: string): Promise<void> {
  const inline = legacyCard(H_INLINE, false);
  const log = legacyCard(H_LOG, true);
  const items: AgentDelegationTranscriptItem[] = [
    {
      id: 'inline-text',
      sequence: 0,
      occurredAt: 10,
      type: 'text',
      text: 'Inline 🌲\ud800',
      author: { kind: 'user' },
      delivery: 'steer',
    },
    {
      id: 'inline-tool',
      sequence: 1,
      occurredAt: 11,
      type: 'tool',
      toolName: 'shell',
      input: 'in🌲\ud800',
      output: 'out漢\udc00',
      truncated: true,
    },
  ];
  const store = new ChatStorageV2(hDirectory(root), H_SCOPE.worktreeId);
  await store.migrate(
    scopeSource([
      {
        id: H_CHAT,
        messages: [
          message(H_PARENT.turnId, 'First prompt 🌲', 'user'),
          { ...message(`delegated-agent-${H_INLINE}`, ''), blocks: [inline] },
          ...delegationChildMessages(inline.agentBlockId, items),
          { ...message(`delegated-agent-${H_LOG}`, ''), blocks: [log] },
        ],
      },
    ]),
  );
  const logs = new ChatDelegationLogs(join(store.directory, 'transcripts'));
  await logs.append(H_CHAT, hTarget(H_LOG), [
    {
      id: 'log-text',
      sequence: 0,
      occurredAt: 12,
      type: 'text',
      text: 'obsolete',
    },
    {
      id: 'log-tool',
      sequence: 1,
      occurredAt: 13,
      type: 'tool',
      toolName: 'shell',
      input: 'log input 漢',
      output: 'log output 🌲',
    },
  ]);
  await logs.append(H_CHAT, hTarget(H_LOG), [
    {
      id: 'log-text',
      sequence: 0,
      occurredAt: 12,
      type: 'text',
      text: 'Latest log 漢\ud800',
      author: { kind: 'user' },
      delivery: 'follow_up',
    },
  ]);
}

/** A file-backed broker and real parent ingestion; no stream/anchor proxy. */
export async function openH(
  root: string,
  enableFormat4: boolean,
  extra: Partial<AgentDelegationBrokerOptions> = {},
  repositoryOptions: ChatStateV2RepositoryOptions = {},
): Promise<HBacking> {
  function makeRepository(enabled: boolean): ChatStateV2Repository {
    return new ChatStateV2Repository({
      resolvePaths: (): ReturnType<typeof hPaths> => hPaths(root),
      enableFormat4: enabled,
      delegationReadMetadata: readMetadataOfRecord,
      deltaJournalIdleCheckpointMs: 3600_000,
      ...repositoryOptions,
    });
  }
  let repository = makeRepository(enableFormat4);
  let service = new ChatStateService({
    repository,
    recordDiagnostic: jest.fn(),
  });
  const forwarding = new Proxy(service, {
    get: (_target, key): unknown => {
      const member: unknown = Reflect.get(service, key);
      return typeof member === 'function' ? member.bind(service) : member;
    },
  });
  const port = new RepositoryDelegationTranscriptPort(forwarding, H_SCOPE);
  const storage = new FileDelegationStorage(hRuns(root));
  await storage.load();
  let ingress = Promise.resolve();
  const errors: unknown[] = [];
  const options: Partial<AgentDelegationBrokerOptions> = {
    transcriptPort: port,
    generationStore: async ({ record }) => {
      if (record.version === 3) return 'stream';
      const readiness = await service.generationStoreReadiness(H_SCOPE);
      if (!readiness.enableFormat4) return 'legacy';
      return readiness.formatVersion === 4
        ? 'stream'
        : {
            kind: 'refused',
            message: 'Delegation storage is not ready. Try again.',
          };
    },
    resolveRoute: () =>
      Promise.resolve({
        ok: true,
        value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
      }),
    onError: (error) => {
      errors.push(error);
    },
    onTranscript: (_parent, transcript) => {
      ingress = ingress.then(async () => {
        await service.ingestProviderEventWithOutcome({
          ...H_SCOPE,
          chatId: H_CHAT,
          data: {
            type: 'canopy_delegation',
            delegation: transcript,
            canopy_turn_user_message_id: transcript.parentTurnId,
          },
          mutationId: `h:${transcript.sequence}:${crypto.randomUUID()}`,
        });
      });
    },
    ...extra,
  };
  const harness = createBrokerHarness(options, storage);
  return {
    get repository(): ChatStateV2Repository {
      return repository;
    },
    get service(): ChatStateService {
      return service;
    },
    port,
    storage,
    harness,
    errors,
    async sync(): Promise<void> {
      await flushBroker();
      await ingress;
    },
    async reopen(enabled: boolean): Promise<void> {
      await ingress;
      await repository.drainAll();
      repository = makeRepository(enabled);
      service = new ChatStateService({
        repository,
        recordDiagnostic: jest.fn(),
      });
      await service.generationStoreReadiness(H_SCOPE);
    },
    async close(): Promise<void> {
      await harness.broker.close();
      await ingress;
      await repository.drainAll();
    },
  };
}
export interface HBacking {
  repository: ChatStateV2Repository;
  service: ChatStateService;
  port: RepositoryDelegationTranscriptPort;
  storage: FileDelegationStorage;
  harness: ReturnType<typeof createBrokerHarness>;
  errors: unknown[];
  sync(): Promise<void>;
  reopen(enabled: boolean): Promise<void>;
  close(): Promise<void>;
}

export async function hLaunch(f: HBacking, generation: number): Promise<void> {
  // A loaded host can take seconds to promote and launch; the parent build
  // needs the same allowance, so this is a deadline, not a timing assertion.
  for (let i = 0; i < 1200; i++) {
    if (
      f.harness.runner.starts.some(
        (run) => run.delegationId === H_ID && run.runGeneration === generation,
      )
    )
      break;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  expect(
    f.harness.runner.starts.filter(
      (run) => run.delegationId === H_ID && run.runGeneration === generation,
    ),
  ).toHaveLength(1);
  const sink = f.harness.runner.sinks.get(H_ID);
  if (!sink) throw new Error('Missing H native sink');
  await sink({
    delegationId: H_ID,
    runGeneration: generation,
    sequence: 1,
    occurredAt: Date.now(),
    event: { type: 'started', nativeSessionId: 'h-native' },
  });
  await f.sync();
}
export async function hBody(
  f: HBacking,
  generation: number,
  terminal = true,
): Promise<void> {
  const sink = f.harness.runner.sinks.get(H_ID);
  if (!sink) throw new Error('Missing H native sink');
  const occurredAt = Date.now() + 1;
  const request = f.harness.runner.starts.find(
    (run) => run.delegationId === H_ID && run.runGeneration === generation,
  );
  if (request?.transcriptStream) {
    // FakeRunner is deliberately event-only. Real stream runners write through
    // this port, not through legacy transcript events delivered to the broker.
    const parentBlockId = `delegated-agent-${H_ID}-run-${generation}`;
    const rows: DelegationChildRow[] = [
      {
        id: `${parentBlockId}:${H_CONTROL[generation]}`,
        role: 'user',
        timestamp: occurredAt,
        parentBlockId,
        delegationSequence: 0,
        delegationSegment: 'h-native',
        itemRevision: 0,
        final: true,
        delegationAuthor: { kind: 'user' },
        delegationDelivery: 'follow_up',
        blocks: [{ type: 'text', text: H_PROMPTS[generation] ?? '' }],
      },
      {
        id: `${parentBlockId}:body-${generation}`,
        role: 'assistant',
        timestamp: occurredAt + 1,
        parentBlockId,
        delegationSequence: 1,
        delegationSegment: 'h-native',
        itemRevision: 0,
        final: true,
        blocks: [{ type: 'text', text: H_BODIES[generation] ?? '' }],
      },
    ];
    expect(
      await f.port.appendChanges({
        target: request.transcriptStream.target,
        mutationKey: `h-native-body-${generation}`,
        changes: rows.map((row) => ({ row })),
      }),
    ).toMatchObject({ ok: true });
  }
  await sink({
    delegationId: H_ID,
    runGeneration: generation,
    sequence: 2,
    occurredAt,
    event: {
      type: 'transcript',
      items: [
        {
          id: `body-${generation}`,
          sequence: 1,
          occurredAt,
          type: 'text',
          text: H_BODIES[generation] ?? '',
        },
      ],
    },
  });
  if (terminal)
    await sink({
      delegationId: H_ID,
      runGeneration: generation,
      sequence: 3,
      occurredAt: occurredAt + 1,
      event: { type: 'terminal', status: 'completed' },
    });
  await f.sync();
}
export async function hFollow(f: HBacking, generation: number): Promise<void> {
  const control = H_CONTROL[generation];
  const prompt = H_PROMPTS[generation];
  if (!control || !prompt) throw new Error('Missing literal H generation');
  expect(
    await f.harness.broker.message(
      {
        ...H_PARENT,
        controlAuthor: 'user',
        toolCallId: `h-follow-${generation}`,
      },
      { delegationId: H_ID, operation: 'follow_up', message: prompt },
      control,
    ),
  ).toMatchObject({ ok: true });
  await hLaunch(f, generation);
}

export async function buildHLegacy(root: string): Promise<void> {
  await seedHLegacy(root);
  const f = await openH(root, false);
  try {
    await f.harness.broker.initialize();
    const uuid = jest.spyOn(crypto, 'randomUUID').mockReturnValueOnce(H_ID);
    try {
      expect(
        await f.harness.broker.spawn(H_PARENT, {
          ...baseTask,
          prompt: H_PROMPTS[1] ?? '',
        }),
      ).toMatchObject({ ok: true, value: { delegationId: H_ID } });
    } finally {
      uuid.mockRestore();
    }
    await hLaunch(f, 1);
    await hBody(f, 1);
    await hFollow(f, 2);
    await hBody(f, 2);
    await hFollow(f, 3);
    await hBody(f, 3);
    const record = await f.storage.loadOne(H_ID);
    expect(record).toMatchObject({
      version: 2,
      history: [{ runGeneration: 1 }, { runGeneration: 2 }],
      state: { runGeneration: 3 },
    });
  } finally {
    await f.close();
  }
}
