import { isE2eBuild } from '../lib/e2e-gate';
import type { ChatStateService } from '../services/chat-state-service';
import type {
  DelegatedAgentCallBlock,
  DelegationChildRow,
} from '@canopy/agent-transcript';
import type {
  ChatTranscriptBlocksPage,
  PersistedChatBlock,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { readFile, writeFile } from 'node:fs/promises';

interface FixtureSpec {
  version: 1;
  projectId: string;
  worktreeId: string;
  chatId: string;
}

function parseSpec(value: unknown): FixtureSpec {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('projectId' in value) ||
    typeof value.projectId !== 'string' ||
    !value.projectId ||
    !('worktreeId' in value) ||
    typeof value.worktreeId !== 'string' ||
    !value.worktreeId ||
    !('chatId' in value) ||
    typeof value.chatId !== 'string' ||
    !value.chatId
  ) {
    throw new Error('Invalid E2E stream fixture spec');
  }
  return {
    version: 1,
    projectId: value.projectId,
    worktreeId: value.worktreeId,
    chatId: value.chatId,
  };
}

const CREATED_AT = 1_788_825_601_000;
const SECOND_PAGE = 'second content page sentinel\n';
const PRIMARY_STORED_TAIL = 'primary stored tail sentinel';
const PRIMARY_INLINE_TAIL = 'primary inline tail sentinel';

// A second run whose newest child row exceeds the page budget, so its page
// carries `blocksOmitted` and the reader must open its blocks page by page.
export const PAGED_BLOCK_COUNT = 46;
const PAGED_FILLER = 'B'.repeat(24_000);

// A third run that stays open: its newest row is paged too, and a release
// control appends a row and publishes a committed card update after mount.
const LIVE_BLOCK_COUNT = 42;
const LIVE_RELEASE_KEY = '__CANOPY_E2E_STREAM_LIVE_RELEASE__';

function fixtureCard(
  spec: FixtureSpec,
  run: RunName,
  description: string,
): DelegatedAgentCallBlock {
  const delegationId = `${spec.chatId}-${run}`;
  const agentBlockId = `delegated-agent-${delegationId}`;
  return {
    type: 'delegated_agent_call',
    delegationId,
    agentBlockId,
    runGeneration: 1,
    status: 'completed',
    outputTruncated: false,
    transcriptStore: 'chat-stream-v2',
    sequence: { child: 1, blocks: 2, live: 3 }[run],
    parentHarnessId: 'claude',
    parentTurnId: 'stream-request',
    parentToolCallId: `stream-spawn-${run}`,
    selectedModelId: 'sonnet',
    runtimeModelId: 'claude-sonnet-4-6',
    targetHarnessId: 'claude',
    routeSnapshot: {
      selectedModelId: 'sonnet',
      runtimeModelId: 'claude-sonnet-4-6',
      harnessId: 'claude',
      runtimeKind: 'local-sdk',
      runnerRegistrationId: 'claude-local',
      runtimeVersion: '1',
      adapterVersion: '1',
      modelSource: 'test',
      providerType: 'test',
      assignmentRevision: 'a1',
      billingAuthority: 'native',
      aiCreditsRouted: false,
      capabilities: ['read'],
      supportedThinkingLevels: ['low'],
      capabilitySnapshotHash: 'c1',
      capabilityGeneration: 1,
      policyRevision: 'p1',
    },
    description,
    prompt: `${description}.`,
    executionMode: 'background',
    createdAt: CREATED_AT,
    finalText: 'Stream review complete.',
  };
}

function fixtureTab(spec: FixtureSpec): PersistedChatTab {
  const card = fixtureCard(spec, 'child', 'Review retained stream evidence');
  const blocksCard = fixtureCard(spec, 'blocks', 'Review paged evidence');
  const liveCard = fixtureCard(spec, 'live', 'Review live evidence');
  return {
    id: spec.chatId,
    title: 'Retained stream review',
    providerType: 'claude',
    createdAt: new Date(CREATED_AT).toISOString(),
    messages: [
      {
        id: 'stream-request',
        role: 'user',
        timestamp: CREATED_AT - 1000,
        blocks: [
          { type: 'text', text: 'Review the retained stream evidence.' },
        ],
      },
      {
        id: card.agentBlockId,
        role: 'assistant',
        timestamp: CREATED_AT,
        blocks: [card],
      },
      {
        id: 'stale-inline',
        role: 'assistant',
        parentBlockId: card.agentBlockId,
        timestamp: CREATED_AT + 1,
        blocks: [{ type: 'text', text: 'stale inline child sentinel' }],
      },
      {
        id: blocksCard.agentBlockId,
        role: 'assistant',
        timestamp: CREATED_AT + 2,
        blocks: [blocksCard],
      },
      {
        id: liveCard.agentBlockId,
        role: 'assistant',
        timestamp: CREATED_AT + 3,
        blocks: [liveCard],
      },
      // Primary tool results: one stored by reference and paired in its row,
      // and one inline result longer than the Portal preview, paired across rows.
      {
        id: 'primary-read',
        role: 'assistant',
        timestamp: CREATED_AT + 10,
        blocks: [
          { type: 'text', text: 'Reading the primary evidence.' },
          {
            type: 'tool_use',
            toolUseId: 'primary-read-call',
            toolName: 'Read',
            input: JSON.stringify({ file_path: 'primary-evidence.txt' }),
          },
          {
            type: 'tool_result',
            toolUseId: 'primary-read-call',
            toolName: 'Read',
            isError: false,
            output: 'P'.repeat(70_000) + PRIMARY_STORED_TAIL,
          },
        ],
      },
      {
        id: 'primary-grep-call',
        role: 'assistant',
        timestamp: CREATED_AT + 11,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'primary-grep',
            toolName: 'Grep',
            input: JSON.stringify({ pattern: 'evidence' }),
          },
        ],
      },
      {
        id: 'primary-grep-result',
        role: 'user',
        timestamp: CREATED_AT + 12,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'primary-grep',
            toolName: 'Grep',
            isError: false,
            output: 'G'.repeat(6_000) + PRIMARY_INLINE_TAIL,
          },
        ],
      },
      {
        id: 'stream-answer',
        role: 'assistant',
        timestamp: CREATED_AT + 2000,
        blocks: [{ type: 'text', text: 'Stream review complete.' }],
      },
    ],
  };
}

function fixtureRows(spec: FixtureSpec): DelegationChildRow[] {
  return Array.from(
    { length: 501 },
    (_, index): DelegationChildRow => ({
      id: `stream-row-${index}`,
      role: 'assistant',
      timestamp: CREATED_AT + index,
      parentBlockId: `delegated-agent-${spec.chatId}-child`,
      delegationSequence: index,
      itemRevision: 0,
      final: true,
      blocks: [
        { type: 'text', text: `Retained child row ${index}` },
        ...(index === 500
          ? [
              {
                type: 'tool_use' as const,
                toolUseId: 'stream-large-result',
                toolName: 'Read',
                input: JSON.stringify({ file_path: 'retained-evidence.txt' }),
              },
              {
                type: 'tool_result' as const,
                toolUseId: 'stream-large-result',
                toolName: 'Read',
                isError: false,
                output: 'A'.repeat(65_536) + SECOND_PAGE.repeat(3000),
              },
            ]
          : []),
      ],
    }),
  );
}

function pagedRows(spec: FixtureSpec): DelegationChildRow[] {
  const parentBlockId = `delegated-agent-${spec.chatId}-blocks`;
  const filler = Array.from({ length: 40 }, (_, index) => ({
    type: 'text' as const,
    text: `${index === 20 ? 'paged block middle sentinel ' : ''}${PAGED_FILLER}`,
  }));
  return [
    {
      id: 'blocks-row-0',
      role: 'assistant',
      timestamp: CREATED_AT,
      parentBlockId,
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
      blocks: [{ type: 'text', text: 'Paged review started.' }],
    },
    {
      id: 'blocks-row-1',
      role: 'assistant',
      timestamp: CREATED_AT + 1,
      parentBlockId,
      delegationSequence: 1,
      itemRevision: 0,
      final: true,
      blocks: [
        { type: 'text', text: 'paged block first sentinel' },
        ...filler,
        {
          type: 'tool_use',
          toolUseId: 'paged-dup',
          toolName: 'Read',
          input: JSON.stringify({ file_path: 'paged-evidence.txt' }),
        },
        {
          type: 'tool_result',
          toolUseId: 'paged-dup',
          toolName: 'Read',
          isError: false,
          output: 'R'.repeat(70_000) + 'paged stored tail sentinel',
        },
        {
          type: 'tool_use',
          toolUseId: 'paged-dup',
          toolName: 'Read',
          input: JSON.stringify({ file_path: 'paged-evidence-2.txt' }),
        },
        {
          type: 'tool_result',
          toolUseId: 'paged-dup',
          toolName: 'Read',
          isError: false,
          output: 'second duplicate result',
        },
        { type: 'text', text: 'paged block last sentinel' },
      ],
    },
  ];
}

function liveRows(spec: FixtureSpec): DelegationChildRow[] {
  const parentBlockId = `delegated-agent-${spec.chatId}-live`;
  return [
    {
      id: 'live-row-0',
      role: 'assistant',
      timestamp: CREATED_AT,
      parentBlockId,
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
      blocks: [{ type: 'text', text: 'Live review started.' }],
    },
    {
      id: 'live-row-1',
      role: 'assistant',
      timestamp: CREATED_AT + 1,
      parentBlockId,
      delegationSequence: 1,
      itemRevision: 0,
      final: true,
      blocks: [
        { type: 'text', text: 'live block first sentinel' },
        ...Array.from({ length: LIVE_BLOCK_COUNT - 2 }, () => ({
          type: 'text' as const,
          text: PAGED_FILLER,
        })),
        { type: 'text', text: 'live block last sentinel' },
      ],
    },
  ];
}

type RunName = 'child' | 'blocks' | 'live';

interface RunSpec {
  readonly run: RunName;
  readonly prompt: string;
  readonly rows: DelegationChildRow[];
}

type CardDraft = Parameters<
  ChatStateService['updateCardState']
>[1]['cardDraft'];

function runningDraft(prompt: string): CardDraft {
  return {
    version: 2,
    status: 'running',
    outputTruncated: false,
    prompt,
    nestedDelegation: 'not_enabled',
    childDelegationIds: [],
    routeSnapshot: {
      selectedModelId: 'sonnet',
      selectedModelLabel: 'Claude Sonnet',
      runtimeModelId: 'claude-sonnet-4-6',
      runtimeModelLabel: 'Claude Sonnet 4.6',
      harnessId: 'claude',
      runtimeKind: 'local-sdk',
      runnerRegistrationId: 'claude-local',
      runtimeVersion: '1',
      adapterVersion: '1',
      modelSource: 'test',
      providerType: 'test',
      assignmentRevision: 'a1',
      billingAuthority: 'native',
      aiCreditsRouted: false,
      capabilities: ['read'],
      supportedThinkingLevels: ['low'],
      capabilitySnapshotHash: 'c1',
      capabilityGeneration: 1,
      policyRevision: 'p1',
    },
  };
}

async function seedRun(
  service: ChatStateService,
  scope: { projectId: string; worktreeId: string },
  spec: FixtureSpec,
  run: RunSpec,
): Promise<{
  kind: 'delegation';
  chatId: string;
  delegationId: string;
  runGeneration: number;
}> {
  const target = {
    kind: 'delegation',
    chatId: spec.chatId,
    delegationId: `${spec.chatId}-${run.run}`,
    runGeneration: 1,
  } as const;
  const existing = await service.getChildStreamState(scope, target);
  // The live run stays open, so any existing descriptor means it is seeded.
  if (existing?.status === 'settled' || (run.run === 'live' && existing))
    return target;
  await service.registerGeneration(scope, {
    chatId: spec.chatId,
    delegationId: target.delegationId,
    runGeneration: 1,
    createdAt: CREATED_AT,
    store: 'stream',
    origin: {
      kind: 'launch',
      anchorMessageId: `delegated-agent-${target.delegationId}`,
    },
    executionMode: 'background',
  });
  await service.openChildStream(scope, target);
  // Format 4 strips mutable fields from the creation row. Publish the same
  // running draft as the broker; settlement supplies completed/finalText.
  await service.updateCardState(scope, {
    target,
    cardRevision: 1,
    cardDraft: runningDraft(run.prompt),
  });
  await service.commitChildStream(
    scope,
    target,
    `e2e-stream-rows-${run.run}-v1`,
    run.rows,
  );
  if (run.run === 'live') return target;
  await service.settleDelegationResult(scope, {
    target,
    settlementKey: `e2e-stream-settlement-${run.run}-v1`,
    resultIndex: 1,
    outcome: { status: 'completed', finishedAt: CREATED_AT + 1000 },
    finalChanges: [],
    answer: { role: 'final', text: 'Stream review complete.' },
  });
  return target;
}

/** E2E startup only; never registered as an application operation. */
export async function seedDelegationStreamFixture(
  service: ChatStateService,
  specPath = process.env.CANOPY_E2E_SEED_STREAM_FIXTURE,
): Promise<void> {
  if (!isE2eBuild() || !specPath) return;
  const spec = parseSpec(JSON.parse(await readFile(specPath, 'utf8')));
  const scope = { projectId: spec.projectId, worktreeId: spec.worktreeId };
  const target = {
    kind: 'delegation',
    chatId: spec.chatId,
    delegationId: `${spec.chatId}-child`,
    runGeneration: 1,
  } as const;
  const tabs = await service.getCompatibilityTabs(scope);
  if (!tabs.tabs.some((tab) => tab.id === spec.chatId)) {
    const readiness = await service.generationStoreReadiness(scope);
    if (!readiness.enableFormat4 || readiness.formatVersion !== 4) {
      throw new Error('E2E stream seeding requires the format-4 write option');
    }
    await service.replaceCompatibilityTabs(
      scope,
      {
        ...tabs,
        tabs: [...tabs.tabs, fixtureTab(spec)],
        activeTabId: spec.chatId,
      },
      { changedTabIds: [spec.chatId], activeTabId: spec.chatId },
    );
  }
  await seedRun(service, scope, spec, {
    run: 'child',
    prompt: 'Review retained stream evidence.',
    rows: fixtureRows(spec),
  });
  const blocksTarget = await seedRun(service, scope, spec, {
    run: 'blocks',
    prompt: 'Review paged evidence.',
    rows: pagedRows(spec),
  });
  const liveTarget = await seedRun(service, scope, spec, {
    run: 'live',
    prompt: 'Review live evidence.',
    rows: liveRows(spec),
  });
  await service.flushScope(spec.projectId, spec.worktreeId);
  const descriptor = await service.getChildStreamState(scope, target);
  if (!descriptor || descriptor.status !== 'settled')
    throw new Error('E2E stream not settled');
  const first = await service.getChildStreamPage(
    scope,
    target,
    descriptor.streamRevision,
    undefined,
    500,
  );
  const ids = new Set(first.rows.map((row): string => row.id));
  let cursor = first.cursor;
  while (cursor) {
    const page = await service.getChildStreamPage(
      scope,
      target,
      descriptor.streamRevision,
      cursor,
      500,
    );
    for (const row of page.rows) ids.add(row.id);
    cursor = page.cursor;
  }
  const rawPage = await service.getTranscriptPage({
    ...scope,
    chatId: spec.chatId,
    target,
  });
  const row = rawPage.messages.find(
    (message): boolean => message.id === 'stream-row-500',
  );
  const output = row?.blocks[2];
  const reference =
    output?.type === 'tool_result' ? output.fullOutputRef : undefined;
  const second = await service.readChildStreamContent(
    scope,
    target,
    descriptor.streamRevision,
    'stream-row-500',
    2,
    'output',
    65_536,
    65_536,
  );
  if (
    ids.size !== 501 ||
    !first.cursor ||
    !reference ||
    reference.byteLength <= 65_536 ||
    !second.text.includes(SECOND_PAGE.trim())
  ) {
    throw new Error(
      `E2E stream fixture preconditions failed: rows=${ids.size}, cursor=${!!first.cursor}, reference=${reference?.byteLength}, second=${second.text.length}`,
    );
  }
  const blocks = await verifyPagedRun(service, scope, spec, blocksTarget);
  const primary = await verifyPrimaryResults(service, scope, spec);
  const live = await verifyLiveRun(service, scope, spec, liveTarget);
  // This receipt is evidence from production reads, not a hand-written storage manifest.
  await writeFile(
    `${specPath}.result.json`,
    JSON.stringify({
      version: 1,
      ...scope,
      target,
      rowCount: ids.size,
      cursor: first.cursor,
      streamRevision: descriptor.streamRevision,
      status: descriptor.status,
      transcriptStore: 'chat-stream-v2',
      fullOutputRef: reference,
      secondPageLength: second.text.length,
      blocks,
      primary,
      live,
    }),
  );
  installLiveRelease(service, scope, spec, liveTarget);
}

async function verifyLiveRun(
  service: ChatStateService,
  scope: { projectId: string; worktreeId: string },
  spec: FixtureSpec,
  target: Awaited<ReturnType<typeof seedRun>>,
): Promise<Record<string, unknown>> {
  const descriptor = await service.getChildStreamState(scope, target);
  const page = await service.getTranscriptPage({
    ...scope,
    chatId: spec.chatId,
    target,
  });
  const ids = page.messages.map((message): string => message.id);
  const paged = page.messages.find(
    (message): boolean => message.id === 'live-row-1',
  );
  const omitted = paged?.blocksOmitted?.blockCount;
  if (
    descriptor?.status !== 'open' ||
    descriptor.cardState?.version !== 2 ||
    omitted !== LIVE_BLOCK_COUNT ||
    ids.includes('live-row-0')
  ) {
    throw new Error(
      `E2E live run preconditions failed: status=${descriptor?.status}, omitted=${omitted}, newest=${ids.join(',')}`,
    );
  }
  return {
    target,
    anchorMessageId: `delegated-agent-${target.delegationId}`,
    status: descriptor.status,
    pagedMessageId: 'live-row-1',
    omittedBlockCount: omitted,
    newestRowIds: ids,
    streamRevision: descriptor.streamRevision,
    cardRevision: descriptor.cardState.cardRevision,
  };
}

/**
 * E2E only: after the reader mounts, append one child row to the open live
 * run and publish its committed card update, through the production methods.
 */
function installLiveRelease(
  service: ChatStateService,
  scope: { projectId: string; worktreeId: string },
  spec: FixtureSpec,
  target: Awaited<ReturnType<typeof seedRun>>,
): void {
  const anchorMessageId = `delegated-agent-${target.delegationId}`;
  const release = async (label: string): Promise<Record<string, unknown>> => {
    const before = await service.getChildStreamState(scope, target);
    if (before?.status !== 'open' || before.cardState?.version !== 2)
      throw new Error('E2E live run is not open');
    const rowId = `live-release-${label}`;
    await service.commitChildStream(scope, target, `e2e-stream-${rowId}`, [
      {
        id: rowId,
        role: 'assistant',
        timestamp: CREATED_AT + 10 + before.committedRowCount,
        parentBlockId: anchorMessageId,
        delegationSequence: before.committedRowCount,
        itemRevision: 0,
        final: true,
        blocks: [{ type: 'text', text: `Live release sentinel ${label}.` }],
      },
    ]);
    await service.updateCardState(scope, {
      target,
      cardRevision: before.cardState.cardRevision + 1,
      cardDraft: runningDraft('Review live evidence.'),
    });
    const after = await service.getChildStreamState(scope, target);
    const page = await service.getTranscriptPage({
      ...scope,
      chatId: spec.chatId,
      target,
    });
    const newestRowIds = page.messages.map((message): string => message.id);
    if (
      after?.cardState?.version !== 2 ||
      after.streamRevision <= before.streamRevision ||
      after.cardState.cardRevision <= before.cardState.cardRevision ||
      !newestRowIds.includes(rowId)
    ) {
      throw new Error(`E2E live release ${label} was not committed`);
    }
    return {
      target,
      anchorMessageId,
      rowId,
      before: {
        streamRevision: before.streamRevision,
        cardRevision: before.cardState.cardRevision,
      },
      after: {
        streamRevision: after.streamRevision,
        cardRevision: after.cardState.cardRevision,
      },
      newestRowIds,
    };
  };
  let previous: Promise<unknown> = Promise.resolve();
  Object.defineProperty(globalThis, LIVE_RELEASE_KEY, {
    configurable: true,
    value: (label: unknown): Promise<Record<string, unknown>> => {
      if (typeof label !== 'string' || !/^[a-z0-9-]{1,32}$/.test(label))
        return Promise.reject(new Error('Invalid E2E live release label'));
      // Releases run one at a time, so each reads the previous one's revisions.
      const next = previous.then(() => release(label));
      previous = next.catch(() => undefined);
      return next;
    },
  });
}

async function verifyPagedRun(
  service: ChatStateService,
  scope: { projectId: string; worktreeId: string },
  spec: FixtureSpec,
  target: Awaited<ReturnType<typeof seedRun>>,
): Promise<Record<string, unknown>> {
  const page = await service.getTranscriptPage({
    ...scope,
    chatId: spec.chatId,
    target,
  });
  const row = page.messages.find(
    (message): boolean => message.id === 'blocks-row-1',
  );
  const omitted = row?.blocksOmitted?.blockCount;
  const read = (
    firstBlockOrdinal: number,
    limit: number,
  ): Promise<ChatTranscriptBlocksPage> =>
    service.getTranscriptBlocks({
      ...scope,
      chatId: spec.chatId,
      target,
      messageId: 'blocks-row-1',
      firstBlockOrdinal,
      limit,
    });
  const head = await read(0, 1);
  const tail = await read(PAGED_BLOCK_COUNT - 1, 1);
  const stored = await read(42, 1);
  const storedBlock = stored.blocks[0];
  const storedRef =
    storedBlock?.type === 'tool_result' ? storedBlock.fullOutputRef : undefined;
  const storedTail = storedRef
    ? await service.readTranscriptContent({
        ...scope,
        chatId: spec.chatId,
        target,
        messageId: 'blocks-row-1',
        blockOrdinal: 42,
        field: 'output',
        requestId: 'e2e-paged-tail',
        offset: storedRef.byteLength - 64,
        limit: 64,
      })
    : undefined;
  const first = head.blocks[0];
  const last = tail.blocks[0];
  if (
    row?.blocks.length !== 0 ||
    omitted !== PAGED_BLOCK_COUNT ||
    head.blockCount !== PAGED_BLOCK_COUNT ||
    first?.type !== 'text' ||
    !first.text.includes('paged block first sentinel') ||
    last?.type !== 'text' ||
    !last.text.includes('paged block last sentinel') ||
    !storedTail?.text.includes('paged stored tail sentinel')
  ) {
    throw new Error(
      `E2E paged run preconditions failed: omitted=${omitted}, count=${head.blockCount}, stored=${storedRef?.byteLength}`,
    );
  }
  return {
    target,
    messageId: 'blocks-row-1',
    omittedBlockCount: omitted,
    storedOrdinal: 42,
    storedByteLength: storedRef?.byteLength,
    transcriptRevision: head.transcriptRevision,
  };
}

async function verifyPrimaryResults(
  service: ChatStateService,
  scope: { projectId: string; worktreeId: string },
  spec: FixtureSpec,
): Promise<Record<string, unknown>> {
  const page = await service.getTranscriptPage({
    ...scope,
    chatId: spec.chatId,
  });
  const block = (
    messageId: string,
    ordinal: number,
  ): PersistedChatBlock | undefined =>
    page.messages.find((message): boolean => message.id === messageId)?.blocks[
      ordinal
    ];
  const stored = block('primary-read', 2);
  const storedRef =
    stored?.type === 'tool_result' ? stored.fullOutputRef : undefined;
  const storedTail = storedRef
    ? await service.readTranscriptContent({
        ...scope,
        chatId: spec.chatId,
        messageId: 'primary-read',
        blockOrdinal: 2,
        field: 'output',
        requestId: 'e2e-primary-tail',
        offset: storedRef.byteLength - 64,
        limit: 64,
      })
    : undefined;
  const inline = block('primary-grep-result', 0);
  const inlineLength =
    inline?.type === 'tool_result' && inline.fullOutputRef === undefined
      ? inline.output.length
      : 0;
  if (
    !storedTail?.text.includes(PRIMARY_STORED_TAIL) ||
    inlineLength <= 4_000
  ) {
    throw new Error(
      `E2E primary preconditions failed: stored=${storedRef?.byteLength}, inline=${inlineLength}`,
    );
  }
  return {
    storedMessageId: 'primary-read',
    storedByteLength: storedRef?.byteLength,
    inlineMessageId: 'primary-grep-result',
    inlineLength,
  };
}
