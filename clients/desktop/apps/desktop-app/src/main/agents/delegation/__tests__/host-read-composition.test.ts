import { createDelegationRunState } from '@canopy/desktop-shared/node/delegation/lifecycle';
import type { StoredDelegation } from '@canopy/desktop-shared/node/delegation/broker';
import { FixtureDelegationReadMetadata } from '@canopy/desktop-shared/node/delegation/testing/record-read-metadata-fixture';
import type { DelegationRecordReadPort } from '../repository-transcript-port';
import type { DelegationRecordReadInput } from '../record-reader-contract';

const mockPort: jest.Mocked<DelegationRecordReadPort> = {
  generation: jest.fn(),
  resultByGeneration: jest.fn(),
  generationsPage: jest.fn(),
  getChildStreamState: jest.fn(),
  readStoredParentMessage: jest.fn(),
};
const mockGetter = jest.fn(() => mockPort);
const mockServiceModuleLoad = jest.fn();
jest.mock('../../../services/chat-state-service', () => {
  mockServiceModuleLoad();
  return { getChatStateService: (): DelegationRecordReadPort => mockGetter() };
});

function input(projectId: string, stream: boolean): DelegationRecordReadInput {
  const record: StoredDelegation = {
    version: 2,
    parent: {
      projectId,
      worktreeId: 'worktree',
      chatId: 'chat',
      harnessId: 'harness',
      sessionKey: 'session',
      turnId: 'turn',
      toolCallId: 'call',
      runtimeGeneration: 1,
      depth: 0,
    },
    task: {
      modelId: 'model',
      description: 'Task',
      prompt: 'Prompt',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
      executionMode: 'background',
    },
    state: createDelegationRunState('child', 1),
    callKey: 'call',
    requestHash: 'hash',
    createdAt: 10,
    launch: {
      version: 1,
      delegationId: 'child',
      launchKey: 'call',
      runGeneration: 1,
      phase: 'reserved',
    },
    delivery: { status: 'unclaimed' },
  };
  if (!stream) return { record };
  const fixture = new FixtureDelegationReadMetadata();
  fixture.stream('child', { originAt: 10, lastActivityAt: 20 });
  return { record, readMetadata: fixture.source(record) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPort.generation.mockResolvedValue(undefined);
  mockPort.resultByGeneration.mockResolvedValue(undefined);
  mockPort.generationsPage.mockResolvedValue({
    generations: [],
  });
  mockPort.getChildStreamState.mockResolvedValue(undefined);
  mockPort.readStoredParentMessage.mockResolvedValue(undefined);
});

test('evaluating the composition is lazy and exports the strict source', async () => {
  const composition = await import('../host-read-composition');
  expect(mockGetter).not.toHaveBeenCalled();
  expect(mockServiceModuleLoad).not.toHaveBeenCalled();
  expect(
    composition.readMetadataOfRecord(input('A', false).record),
  ).toBeUndefined();
});

test('every legacy resolver bypasses the lazy port', async () => {
  const { managedDelegationRecordReader: reader } =
    await import('../host-read-composition');
  const legacy = input('A', false);
  await reader.resolveActivity(legacy);
  await reader.resolveGenerationOutcome(legacy, 1);
  await reader.resolveGenerationHeader(legacy, 1);
  await reader.resolveGenerationList(legacy);
  expect(mockGetter).not.toHaveBeenCalled();
  expect(mockServiceModuleLoad).not.toHaveBeenCalled();
  for (const method of Object.values(mockPort))
    expect(method).not.toHaveBeenCalled();
});

test('each call routes by its record scope and a failed scope cannot poison another', async () => {
  const { managedDelegationRecordReader: reader } =
    await import('../host-read-composition');
  mockPort.getChildStreamState.mockImplementation((scope) =>
    scope.projectId === 'A'
      ? Promise.reject(new Error('scope A unavailable'))
      : Promise.resolve(undefined),
  );
  await expect(reader.resolveActivity(input('A', true))).rejects.toThrow(
    'scope A unavailable',
  );
  await expect(reader.resolveActivity(input('B', true))).resolves.toBe(20);
  await reader.resolveGenerationOutcome(input('B', true), 1);
  await reader.resolveGenerationHeader(input('A', true), 1);
  await reader.resolveGenerationList(input('B', true));
  expect(
    mockPort.getChildStreamState.mock.calls.map(([scope]) => scope.projectId),
  ).toEqual(['A', 'B']);
  expect(
    mockPort.generation.mock.calls.map(([scope]) => scope.projectId),
  ).toEqual(['B', 'A']);
  expect(mockPort.generationsPage.mock.calls[0]?.[0]).toEqual({
    projectId: 'B',
    worktreeId: 'worktree',
  });
});

test('stored anchors use the same per-call scope without overlay hydration', async () => {
  const { managedDelegationRecordReader: reader } =
    await import('../host-read-composition');
  mockPort.generation.mockResolvedValue({
    entry: {
      version: 1,
      kind: 'generation',
      chatId: 'chat',
      delegationId: 'child',
      runGeneration: 1,
      createdAt: 10,
      store: 'stream',
      origin: { kind: 'launch', anchorMessageId: 'anchor' },
      executionMode: 'background',
    },
    stream: null,
    result: null,
  });
  await reader.resolveGenerationHeader(input('B', true), 1);
  await reader.resolveGenerationHeader(input('A', true), 1);
  expect(mockPort.readStoredParentMessage.mock.calls).toEqual([
    [{ projectId: 'B', worktreeId: 'worktree' }, 'chat', 'anchor'],
    [{ projectId: 'A', worktreeId: 'worktree' }, 'chat', 'anchor'],
  ]);
});
