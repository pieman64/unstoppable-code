import type {
  PortalChangedFile,
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import { PORTAL_EVENT_BATCH_MAX_BYTES } from '@canopy/protocol/portal';
import { handlePortalDiffRead } from '../diff-adapter';
import type { PortalAdapterContext } from '../types';
import { readDiff } from '../../../services/diff-service';
import { createCommandCompletedPayload } from '../../portal-event-bus';
import { portalEventMaxRoutedByteLength } from '../../portal-outbox';

jest.mock('../../../services/diff-service', () => ({
  readDiff: jest.fn(),
}));

const mockedReadDiff = jest.mocked(readDiff);

function rosterOf(count: number): PortalChangedFile[] {
  return Array.from({ length: count }, (_, index) => ({
    filePath: `generated/component-library/src/widgets/file-${String(index).padStart(5, '0')}.tsx`,
    status: 'added',
    insertions: 1,
    deletions: 0,
  }));
}

function command(
  filePath: string,
  repoId?: string,
): PortalCommandEnvelope<PortalCommandPayloadMap['portal.diff.read']> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    sequence: 7,
    type: 'portal.diff.read',
    createdAt: '2026-05-06T00:00:00.000Z',
    expiresAt: null,
    payload: {
      workspaceId: 'workspace',
      worktreeId: 'worktree',
      path: filePath,
      ...(repoId ? { repoId } : {}),
      source: 'uncommitted',
    },
  };
}

function capture(): {
  context: PortalAdapterContext;
  events: PortalEventEnvelope[];
  results: unknown[];
} {
  const events: PortalEventEnvelope[] = [];
  const results: unknown[] = [];
  const context = {
    enqueueEvent: (event: PortalEventEnvelope): void => {
      events.push(event);
    },
    complete: (_command: PortalCommandEnvelope, result?: unknown): void => {
      results.push(result);
    },
    fail: jest.fn(),
  } as unknown as PortalAdapterContext;
  return { context, events, results };
}

describe('handlePortalDiffRead roster bound', () => {
  beforeEach(() => mockedReadDiff.mockReset());

  it('cuts an over-cap roster, keeps the selected file, and marks it truncated', async () => {
    const files = rosterOf(12_000);
    const selected = files[11_999];
    mockedReadDiff.mockResolvedValue({
      workspaceLocalId: 'workspace',
      worktreeLocalId: 'worktree',
      filePath: selected.filePath,
      files,
      patch: '@@ -0,0 +1 @@\n+x\n',
    });
    const readCommand = command(selected.filePath);
    const { context, events, results } = capture();

    await handlePortalDiffRead(readCommand, context);

    const snapshot = events[0];
    expect(portalEventMaxRoutedByteLength(snapshot)).toBeLessThanOrEqual(
      PORTAL_EVENT_BATCH_MAX_BYTES - 4096,
    );
    const snapshotPayload = snapshot.payload as {
      files: PortalChangedFile[];
      truncated?: boolean;
    };
    expect(snapshotPayload.truncated).toBe(true);
    expect(snapshotPayload.files.length).toBeLessThan(files.length);
    expect(snapshotPayload.files[0]?.filePath).toBe(selected.filePath);

    const result = results[0] as {
      files: PortalChangedFile[];
      truncated?: boolean;
    };
    expect(result.truncated).toBe(true);
    expect(result.files).toEqual(snapshotPayload.files);
    expect(
      portalEventMaxRoutedByteLength({
        type: 'portal.command.completed',
        commandId: readCommand.id,
        eventId: '00000000-0000-4000-8000-000000000000',
        clientEventId: '00000000-0000-4000-8000-000000000000',
        occurredAt: new Date().toISOString(),
        payload: createCommandCompletedPayload(readCommand, result),
      }),
    ).toBeLessThanOrEqual(PORTAL_EVENT_BATCH_MAX_BYTES - 4096);
  });

  it('keeps a selected file in a repo-scoped roster without repo IDs', async () => {
    const files = rosterOf(12_000);
    const selected = files[11_999];
    mockedReadDiff.mockResolvedValue({
      workspaceLocalId: 'workspace',
      worktreeLocalId: 'worktree',
      filePath: selected.filePath,
      files,
      patch: '@@ -0,0 +1 @@\n+x\n',
    });
    const readCommand = command(selected.filePath, 'repo-a');
    const { context, events, results } = capture();

    await handlePortalDiffRead(readCommand, context);

    const snapshot = events[0];
    expect(portalEventMaxRoutedByteLength(snapshot)).toBeLessThanOrEqual(
      PORTAL_EVENT_BATCH_MAX_BYTES - 4096,
    );
    const snapshotPayload = snapshot.payload as {
      files: PortalChangedFile[];
      truncated?: boolean;
    };
    expect(snapshotPayload.truncated).toBe(true);
    expect(snapshotPayload.files.length).toBeLessThan(files.length);
    expect(snapshotPayload.files[0]?.filePath).toBe(selected.filePath);

    const result = results[0] as {
      files: PortalChangedFile[];
      truncated?: boolean;
    };
    expect(result.truncated).toBe(true);
    expect(result.files[0]?.filePath).toBe(selected.filePath);
    expect(result.files).toEqual(snapshotPayload.files);
    expect(
      portalEventMaxRoutedByteLength({
        type: 'portal.command.completed',
        commandId: readCommand.id,
        eventId: '00000000-0000-4000-8000-000000000000',
        clientEventId: '00000000-0000-4000-8000-000000000000',
        occurredAt: new Date().toISOString(),
        payload: createCommandCompletedPayload(readCommand, result),
      }),
    ).toBeLessThanOrEqual(PORTAL_EVENT_BATCH_MAX_BYTES - 4096);
  });

  it('leaves a roster that fits unchanged and unmarked', async () => {
    const files = rosterOf(20);
    mockedReadDiff.mockResolvedValue({
      workspaceLocalId: 'workspace',
      worktreeLocalId: 'worktree',
      filePath: files[3].filePath,
      files,
      patch: '',
    });
    const { context, events, results } = capture();

    await handlePortalDiffRead(command(files[3].filePath), context);

    const snapshotPayload = events[0].payload as Record<string, unknown>;
    expect(snapshotPayload.files).toEqual(files);
    expect('truncated' in snapshotPayload).toBe(false);
    expect(results[0]).toEqual(expect.objectContaining({ files }));
    expect('truncated' in (results[0] as object)).toBe(false);
  });
});
