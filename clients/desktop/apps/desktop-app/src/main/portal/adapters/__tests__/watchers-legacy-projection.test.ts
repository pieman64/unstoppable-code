import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAppAdvisorWatcherService } from '../../../app-advisor/watchers';
import { listPortalWatcherEntities } from '../watchers-adapter';

let mockDirectory = '';
jest.mock('../../../lib/paths', () => ({
  ...jest.requireActual<object>('../../../lib/paths'),
  getDataDir: (): string => mockDirectory,
  getWorktreeDataDir: (projectId: string, worktreeId: string): string =>
    join(mockDirectory, projectId, worktreeId),
  getAppAdvisorWatchersFilePath: (): string =>
    join(mockDirectory, 'watchers.json'),
}));
jest.mock('../../../agents/session-manager', () => ({
  getSessionManager: jest.fn(),
  getProviderAuthGeneration: (): number => 1,
}));
jest.mock('../../../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<null> => Promise.resolve(null),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));
jest.mock('../../../portal/portal-event-bus', () => ({
  isCanopyPortalActive: (): boolean => false,
  capturePortalEmissionContext: (): null => null,
}));
jest.mock('../../../pipelines/pipeline-service', () => ({}));
jest.mock('../../../services/background-execution-context', () => ({
  ...jest.requireActual<object>(
    '../../../services/background-execution-context',
  ),
  backgroundExecutionContextEnabled: (): boolean => false,
}));

const scope = { projectId: 'project', worktreeId: 'worktree' };
const parent = { ...scope, chatId: 'chat' };
/** Intentionally raw: no active watcher DTO can represent a retired kind. */
function legacy(
  id: string,
  options: {
    status?: string;
    resultIndex?: number | null;
    projectId?: string;
    worktreeId?: string;
  } = {},
): Record<string, unknown> & { target: Record<string, unknown> } {
  return {
    version: 1,
    id,
    trigger: 'managed_delegation_completion',
    status: options.status ?? 'firing',
    label: 'Delegate completion',
    target: {
      kind: 'managed_delegation',
      ...scope,
      projectId: options.projectId ?? scope.projectId,
      worktreeId: options.worktreeId ?? scope.worktreeId,
      mode: 'all',
      deadlineAt: 100,
      targetCount: 1,
      recipient: 'root',
    },
    destination: parent,
    createdAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2000-01-01T00:00:00.000Z',
    dedupeKey: id,
    runtimeState: {
      kind: 'managed_delegation',
      nextAttemptAt: '2000-01-01T00:00:00.000Z',
      requestHash: 'hash',
      invocationKey: id,
      recipient: { kind: 'root' },
      targets: [
        {
          delegationId: '00000000-0000-4000-8000-000000000001',
          runGeneration: 2,
          resultIndex:
            options.resultIndex === undefined ? 1 : options.resultIndex,
          status: 'completed',
        },
      ],
      pendingDelivery: {
        eventId: `event-${id}`,
        attempts: 0,
        event: {
          watcherId: id,
          outcome: 'completed',
          mode: 'all',
          deadlineAt: 100,
          targets: [
            {
              delegationId: '00000000-0000-4000-8000-000000000001',
              runGeneration: 2,
              status: 'completed',
              resultIndex: 1,
            },
          ],
        },
      },
    },
  };
}

it('projects ordinary watchers but never migration-only managed watcher rows to Portal', async () => {
  const service = getAppAdvisorWatcherService();
  service.shutdown();
  await service.drain();
  mockDirectory = await mkdtemp(join(tmpdir(), 'portal-legacy-watchers-'));
  try {
    const now = new Date().toISOString();
    await writeFile(
      join(mockDirectory, 'watchers.json'),
      JSON.stringify({
        version: 1,
        updatedAt: now,
        watchers: [
          legacy('retired', { status: 'active' }),
          {
            version: 1,
            id: 'ordinary',
            trigger: 'worktree_pipeline_completion',
            status: 'active',
            label: 'Build',
            target: {
              kind: 'worktree_pipeline',
              ...scope,
              pipelineName: 'Build',
              executionId: 'execution',
            },
            destination: parent,
            createdAt: now,
            updatedAt: now,
            dedupeKey: 'ordinary',
          },
        ],
      }),
    );
    expect(await service.listLegacyDelegateWatchers(scope)).toHaveLength(1);
    const rows = await listPortalWatcherEntities([parent]);
    expect(rows.map((row) => row.localId)).toEqual(['ordinary']);
    expect(JSON.stringify(rows)).not.toContain('managed_delegation');
  } finally {
    service.shutdown();
    await service.drain();
    await rm(mockDirectory, { recursive: true, force: true });
  }
});
