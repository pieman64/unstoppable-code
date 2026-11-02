import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ArchivedContainerManifestV1 } from '@canopy/desktop-shared/types';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import { costScopeKey } from '@canopy/protocol/cost-view';
import { CostIndexStore } from '../store';
import type { CostServiceError } from '../errors';
import type * as CostErrors from '../errors';
import type { CostIndexHost, CostScopeLocation } from '../types';
import {
  prepareEntryCostArchive,
  finishEntryCostArchive,
  restoreEntryCostArchive,
  removeEntryCost,
  archivedContainerSummaryWithCost,
} from '../lifecycle';

let root: string;
let store: CostIndexStore;
jest.mock('../service', () => ({
  getDesktopCostIndexStore: (): CostIndexStore => store,
  get CostServiceError(): typeof CostServiceError {
    return jest.requireActual<typeof CostErrors>('../errors').CostServiceError;
  },
}));
jest.mock('../../lib/paths', () => ({
  getEntryCostDir: (projectId: string, id: string): string =>
    join(root, projectId, 'cost', id),
  getArchivedContainerCostDir: (projectId: string, id: string): string =>
    join(root, projectId, 'archived-containers', id, 'cost'),
}));

const ORIGINAL_CREATED = '2026-10-08T00:00:00.000Z';
const RESTORED_CREATED = '2026-10-08T15:00:00.000Z';

describe.each([
  ['Code', 'code-project', 'worktree'],
  ['Cowork', 'cowork-project', 'work-entry'],
  ['App Advisor', 'app-advisor', 'work-entry'],
] as const)('%s persisted cost lifecycle', (_name, projectId, kind) => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cost-entry-lifecycle-'));
  });
  afterEach(async () => {
    await store.waitForIdle();
    await rm(root, { recursive: true, force: true });
  });

  it('captures the last flush, retains immutable sealed data and restores the same chats under a new incarnation', async () => {
    const scopes = new Map<string, CostScopeLocation>();
    const original: CostScopeRef = {
      kind: 'entry',
      projectId,
      worktreeId: 'entry-old',
    };
    const retained: CostScopeRef = {
      kind: 'retained',
      projectId,
      containerId: 'entry-old',
    };
    const restored: CostScopeRef = {
      kind: 'entry',
      projectId,
      worktreeId: 'entry-new',
    };
    const liveDir = join(root, projectId, 'cost', 'entry-old');
    const retainedDir = join(
      root,
      projectId,
      'archived-containers',
      'entry-old',
      'cost',
    );
    const restoredDir = join(root, projectId, 'cost', 'entry-new');
    scopes.set(costScopeKey(original), {
      scope: original,
      directory: liveDir,
      incarnation: ORIGINAL_CREATED,
      createdAt: ORIGINAL_CREATED,
    });
    const audit = join(root, 'audit', '2026-10-08.jsonl');
    await mkdir(dirname(audit), { recursive: true });
    const line = (
      id: string,
      worktreeId: string,
      usd: number,
      startedAt = '2026-10-08T12:00:00.000Z',
    ): string =>
      `${JSON.stringify({
        id,
        eventType: 'worktree_chat',
        status: 'success',
        provider: 'claude',
        label: 'Turn',
        projectId,
        worktreeId,
        chatId: 'same-chat',
        startedAt,
        completedAt: startedAt,
        billingBasis: 'api_key',
        totalCostUsd: usd,
        tokens: { input: 10, output: 2 },
        toolCounts: {},
      })}\n`;
    await writeFile(audit, line('first-turn', 'entry-old', 1));
    let flushPending = true;
    const host: CostIndexHost = {
      auditDirectory: (): string => dirname(audit),
      checkpointPath: (): string => join(root, 'cost-index', 'checkpoint.json'),
      resolveScope: (scope): Promise<CostScopeLocation | null> =>
        Promise.resolve(scopes.get(costScopeKey(scope)) ?? null),
      listRetainedScopes: (): Promise<readonly CostScopeLocation[]> =>
        Promise.resolve(
          Array.from(scopes.values()).filter(
            (location) => location.scope.kind === 'retained',
          ),
        ),
      withRetainedLock: <T>(
        _scope: CostScopeRef,
        action: () => Promise<T>,
      ): Promise<T> => action(),
      readChats: (): ReturnType<CostIndexHost['readChats']> =>
        Promise.resolve([
          {
            chatId: 'same-chat',
            label: 'Canonical renamed chat',
            state: 'open',
            running: true,
          },
        ]),
      readPipelineRun: (): ReturnType<CostIndexHost['readPipelineRun']> =>
        Promise.resolve(null),
      retentionDays: (): number => 7,
      flush: async (): Promise<void> => {
        if (!flushPending) return;
        flushPending = false;
        await appendFile(audit, line('last-flush-turn', 'entry-old', 2));
      },
    };
    store = new CostIndexStore(host);
    await prepareEntryCostArchive(projectId, 'entry-old');
    await cp(liveDir, retainedDir, { recursive: true });
    await finishEntryCostArchive(projectId, 'entry-old');
    scopes.set(costScopeKey(retained), {
      scope: retained,
      directory: retainedDir,
      incarnation: ORIGINAL_CREATED,
      createdAt: ORIGINAL_CREATED,
    });
    await removeEntryCost(projectId, 'entry-old');
    scopes.delete(costScopeKey(original));
    const sealedBytes = await readFile(
      join(retainedDir, 'summary.json'),
      'utf8',
    );
    const retainedView = await store.getScope({ scope: retained });
    expect(retainedView.status).toBe('ok');
    if (retainedView.status !== 'ok') throw new Error('Expected retained DTO');
    expect(retainedView.value.totals.usd).toBe(3);
    expect(retainedView.value.sealedAt).toBeDefined();
    expect(retainedView.value.chats[0]?.running).toBe(false);
    await expect(
      store.refresh({ scope: retained, trigger: 'manual' }),
    ).resolves.toMatchObject({ status: 'error', reason: 'SCOPE_SEALED' });
    const manifest: ArchivedContainerManifestV1 = {
      version: 1,
      projectId,
      id: 'entry-old',
      kind,
      name: 'Entry',
      createdAt: ORIGINAL_CREATED,
      archivedAt: '2026-10-08T14:00:00.000Z',
      expiresAt: '2026-10-15T14:00:00.000Z',
      retentionDays: 7,
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
    };
    expect(
      (await archivedContainerSummaryWithCost(manifest)).observedCostUsd,
    ).toBe(3);
    const deletedManifest: ArchivedContainerManifestV1 = { ...manifest };
    // Keep the legacy deletion marker on this archived-summary test input.
    Reflect.set(deletedManifest, 'deletedAt', '2026-10-08T14:01:00.000Z');
    expect(
      (await archivedContainerSummaryWithCost(deletedManifest)).observedCostUsd,
    ).toBe(3);
    await appendFile(audit, line('late-old-turn', 'entry-old', 100));
    await store.refreshInternal('idle');
    expect(await readFile(join(retainedDir, 'summary.json'), 'utf8')).toBe(
      sealedBytes,
    );
    scopes.set(costScopeKey(restored), {
      scope: restored,
      directory: restoredDir,
      incarnation: RESTORED_CREATED,
      createdAt: RESTORED_CREATED,
    });
    await restoreEntryCostArchive(
      projectId,
      'entry-old',
      'entry-new',
      RESTORED_CREATED,
    );
    await appendFile(
      audit,
      line('restored-turn', 'entry-new', 4, '2026-10-08T16:00:00.000Z'),
    );
    await store.refreshInternal('idle');
    const restoredView = await store.getScope({ scope: restored });
    if (restoredView.status !== 'ok') throw new Error('Expected restored DTO');
    expect(restoredView.value.totals.usd).toBe(7);
    expect(restoredView.value.chats[0]?.chatId).toBe('same-chat');
    expect(restoredView.value.sealedAt).toBeUndefined();
    expect(await readFile(join(retainedDir, 'summary.json'), 'utf8')).toBe(
      sealedBytes,
    );
    // Pipeline delegates carry a chat id, but belong only to their root run.
    const pipelineLine = (
      id: string,
      eventType: string,
      usd: number,
      extra: object = {},
    ): string =>
      `${JSON.stringify({
        id,
        eventType,
        status: 'success',
        provider: 'claude',
        label: 'Pipeline work',
        projectId,
        worktreeId: 'entry-new',
        pipelineExecutionId: 'root-run',
        rootPipelineExecutionId: 'root-run',
        pipelineName: 'Test pipeline',
        startedAt: '2026-10-08T17:00:00.000Z',
        completedAt: '2026-10-08T17:00:01.000Z',
        billingBasis: 'api_key',
        totalCostUsd: usd,
        tokens: { input: 10, output: 2 },
        toolCounts: {},
        ...extra,
      })}\n`;
    await appendFile(
      audit,
      pipelineLine('pipeline-agent', 'pipeline_agent_turn', 5, {
        jobId: 'job',
        stepId: 'agent',
        attempt: 1,
      }) +
        pipelineLine('pipeline-advisor', 'pipeline_advisor', 1) +
        pipelineLine('pipeline-delegate', 'managed_delegation', 2, {
          chatId: 'same-chat',
          delegation: {
            delegationId: 'delegate',
            runGeneration: 1,
            parentChatId: 'same-chat',
            parentPipelineExecutionId: 'root-run',
          },
        }),
    );
    await store.refreshInternal('idle');
    const beforeSeal = await store.getScope({ scope: restored });
    if (beforeSeal.status !== 'ok') throw new Error('Expected pipeline scope');
    expect(beforeSeal.value.pipelineRuns[0]?.totals.usd).toBe(8);
    expect(beforeSeal.value.chats[0]?.totals.usd).toBe(7);
    await store.sealScope(restored);
    const afterSeal = await store.getScope({ scope: restored });
    if (afterSeal.status !== 'ok')
      throw new Error('Expected sealed pipeline scope');
    expect(afterSeal.value.totals).toEqual(beforeSeal.value.totals);
    expect(afterSeal.value.pipelineRuns[0]?.totals).toEqual(
      beforeSeal.value.pipelineRuns[0]?.totals,
    );
    await removeEntryCost(projectId, 'entry-new');
    await rm(dirname(retainedDir), { recursive: true, force: true });
    await expect(
      readFile(join(restoredDir, 'summary.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(retainedDir, 'summary.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
