import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStateService } from '../../services/chat-state-service';
import { ChatStateV2Repository } from '../../services/chat-state-v2-repository';
import { isE2eBuild } from '../../lib/e2e-gate';
import { seedDelegationStreamFixture } from '../delegation-stream-fixture';
import { projectPersistedChatTranscript } from '@canopy/desktop-shared/portal/persisted-chat-projection';
import { isAgentDelegationCardData } from '@canopy/protocol/delegation';

jest.mock('../../lib/e2e-gate', () => ({ isE2eBuild: jest.fn() }));
jest.setTimeout(60_000);

describe('E2E retained stream fixture', () => {
  let root: string;
  let repository: ChatStateV2Repository;
  let service: ChatStateService;
  let specPath: string;
  const scope = {
    projectId: 'fixture-project',
    worktreeId: 'fixture-worktree',
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 's1-stream-fixture-'));
    repository = new ChatStateV2Repository({
      enableFormat4: true,
      resolvePaths: (): {
        tabs: string;
        archives: string;
        journal: string;
      } => ({
        tabs: join(root, 'chats', 'scope.json'),
        archives: join(root, 'archives', 'scope.json'),
        journal: join(root, 'journal.json'),
      }),
    });
    service = new ChatStateService({ repository });
    specPath = join(root, 'fixture.json');
    await writeFile(
      specPath,
      JSON.stringify({ version: 1, ...scope, chatId: 'stream-parent' }),
    );
    jest.mocked(isE2eBuild).mockReturnValue(true);
  });
  afterEach(async () => {
    await repository.drainAll();
    await rm(root, { recursive: true, force: true });
  });

  it('publishes a valid labelled card state for the Portal without stale children', async () => {
    await seedDelegationStreamFixture(service, specPath);
    const tabs = await service.getCompatibilityTabs(scope, {
      chatIds: ['stream-parent'],
    });
    const messages = tabs.tabs[0].messages;
    const card = messages
      .flatMap((row) => row.blocks)
      .find((block) => block.type === 'delegated_agent_call');
    expect(card).toMatchObject({
      status: 'completed',
      finalText: 'Stream review complete.',
      transcriptStore: 'chat-stream-v2',
      routeSnapshot: {
        selectedModelId: 'sonnet',
        selectedModelLabel: 'Claude Sonnet',
        runtimeModelId: 'claude-sonnet-4-6',
        runtimeModelLabel: 'Claude Sonnet 4.6',
      },
    });
    const projected = projectPersistedChatTranscript({
      scope: 'worktree',
      workspaceLocalId: scope.projectId,
      worktreeLocalId: scope.worktreeId,
      chatId: 'stream-parent',
      messages,
    });
    const agent = projected
      .flatMap((message) => message.parts ?? [])
      .find((part) => part.kind === 'agent');
    expect(agent?.data).toBeDefined();
    const data: unknown = agent?.data;
    if (
      typeof data !== 'object' ||
      data === null ||
      !('delegation' in data) ||
      !('subBlocks' in data)
    )
      throw new Error('Managed delegation projection missing');
    expect(isAgentDelegationCardData(data.delegation)).toBe(true);
    expect(data.delegation).toMatchObject({
      transcriptStore: 'chat-stream-v2',
      status: 'completed',
    });
    expect(data.subBlocks).toEqual([]);
    expect(JSON.stringify(projected)).not.toContain(
      'stale inline child sentinel',
    );
  });

  it('stores 501 distinct rows, a cursor, a real large body and settlement; retries do not duplicate', async () => {
    await seedDelegationStreamFixture(service, specPath);
    const tabs = await service.getCompatibilityTabs(scope);
    expect(tabs.tabs.map((tab) => tab.id)).toEqual(['stream-parent']);
    const target = {
      kind: 'delegation',
      chatId: 'stream-parent',
      delegationId: 'stream-parent-child',
      runGeneration: 1,
    } as const;
    const descriptor = await service.getChildStreamState(scope, target);
    expect(descriptor).toMatchObject({ status: 'settled' });
    if (!descriptor) throw new Error('fixture descriptor missing');
    let page = await service.getChildStreamPage(
      scope,
      target,
      descriptor.streamRevision,
      undefined,
      500,
    );
    expect(page.cursor).toEqual(expect.any(String));
    const ids = page.rows.map((row) => row.id);
    while (page.cursor) {
      page = await service.getChildStreamPage(
        scope,
        target,
        descriptor.streamRevision,
        page.cursor,
        500,
      );
      ids.push(...page.rows.map((row) => row.id));
    }
    expect(new Set(ids).size).toBe(501);
    const raw = await service.getTranscriptPage({
      ...scope,
      chatId: 'stream-parent',
      target,
    });
    const tool = raw.messages.find((row) => row.id === 'stream-row-500');
    const result = tool?.blocks.find((block) => block.type === 'tool_result');
    if (result?.type !== 'tool_result') throw new Error('tool result missing');
    expect(result.fullOutputRef?.byteLength).toBeGreaterThan(65_536);
    const body = await service.readChildStreamContent(
      scope,
      target,
      descriptor.streamRevision,
      'stream-row-500',
      2,
      'output',
      65_536,
      65_536,
    );
    expect(body.text).toContain('second content page sentinel');
    const receipt: unknown = JSON.parse(
      await readFile(`${specPath}.result.json`, 'utf8'),
    );
    expect(receipt).toMatchObject({
      rowCount: 501,
      status: 'settled',
      transcriptStore: 'chat-stream-v2',
      // Paged-row and primary evidence come from the same production reads.
      blocks: {
        messageId: 'blocks-row-1',
        omittedBlockCount: 46,
        storedOrdinal: 42,
      },
      primary: {
        storedMessageId: 'primary-read',
        inlineMessageId: 'primary-grep-result',
      },
    });
    await seedDelegationStreamFixture(service, specPath);
    expect((await service.getCompatibilityTabs(scope)).tabs).toHaveLength(1);
    expect(await service.getChildStreamState(scope, target)).toEqual(
      descriptor,
    );
    expect(
      await service.readStoredParentMessage(
        scope,
        'stream-parent',
        'stale-inline',
      ),
    ).toMatchObject({
      blocks: [{ type: 'text', text: 'stale inline child sentinel' }],
    });
    await repository.drainAll();
    repository = new ChatStateV2Repository({
      enableFormat4: false,
      resolvePaths: (): {
        tabs: string;
        archives: string;
        journal: string;
      } => ({
        tabs: join(root, 'chats', 'scope.json'),
        archives: join(root, 'archives', 'scope.json'),
        journal: join(root, 'journal.json'),
      }),
    });
    service = new ChatStateService({ repository });
    await seedDelegationStreamFixture(service, specPath);
    expect(await service.generationStoreReadiness(scope)).toEqual({
      formatVersion: 4,
      enableFormat4: false,
    });
    expect(await service.getChildStreamState(scope, target)).toEqual(
      descriptor,
    );
    const retained = await service.getTranscriptPage({
      ...scope,
      chatId: 'stream-parent',
      target,
    });
    expect(retained.messages.map((row) => row.id)).toContain('stream-row-500');
  });

  it('does not read even a malformed spec outside an E2E build', async () => {
    jest.mocked(isE2eBuild).mockReturnValue(false);
    await writeFile(specPath, 'not JSON');
    await seedDelegationStreamFixture(service, specPath);
    expect((await service.getCompatibilityTabs(scope)).tabs).toEqual([]);
  });
});
