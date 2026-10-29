import type { FeedItem } from '../../feed';
import {
  REALTIME_EVENT_TYPES,
  REALTIME_NOTIFY_MAX_BYTES,
  REALTIME_OWNER_SCOPES,
  REALTIME_OWNER_SCOPE_TO_OWNER_TYPE,
  REALTIME_OWNER_TYPES,
  type CloudWorkspaceRealtimeSignal,
  type CreditPoolRealtimeSignal,
  type PlanRealtimeSignal,
  type RealtimeCreditPoolEnvelope,
  type RealtimeCloudWorkspaceEnvelope,
  type RealtimeEventEnvelope,
  type RealtimeFeedEnvelope,
  type RealtimePlanEnvelope,
  type RealtimeRunEnvelope,
  type RunRealtimeSignal,
  type RealtimeSharedContainerEnvelope,
  type SharedContainerRealtimeSignal,
} from '../index';

describe('realtime protocol contract', () => {
  it('pins the frozen event-type set', () => {
    expect(REALTIME_EVENT_TYPES).toEqual([
      'feed.item',
      'plan.detail',
      'run.detail',
      'credit.pool',
      'sharedcontainer.detail',
      'cloud.workspace',
    ]);
  });

  it('carries a cloud.workspace signal with identifiers only', () => {
    const signal: CloudWorkspaceRealtimeSignal = {
      workspaceId: 'workspace-uuid',
      chatId: 'chat-uuid',
    };
    const envelope: RealtimeCloudWorkspaceEnvelope = {
      type: 'cloud.workspace',
      eventId: 'cloud.workspace:chat-created:chat-uuid',
      occurredAt: '2026-10-12T00:00:00.000Z',
      sequence: 125,
      payload: signal,
    };
    expect(Object.keys(envelope.payload)).toEqual(['workspaceId', 'chatId']);
  });

  it('carries a sharedcontainer.detail refetch signal', () => {
    const signal: SharedContainerRealtimeSignal = {
      containerId: 'container-uuid',
      revision: 4,
    };
    const envelope: RealtimeSharedContainerEnvelope = {
      type: 'sharedcontainer.detail',
      eventId: 'sharedcontainer:container-uuid:recipient@4',
      occurredAt: '2026-08-26T00:00:00.000Z',
      sequence: 124,
      payload: signal,
    };
    expect(Object.keys(envelope.payload)).toEqual(['containerId', 'revision']);
  });

  it('carries a run.detail signal as a refetch trigger, never state', () => {
    const signal: RunRealtimeSignal = {
      runId: 'run-uuid',
      commentRevision: 7,
    };
    const envelope: RealtimeRunEnvelope = {
      type: 'run.detail',
      eventId: 'run.detail:run-uuid@2026-07-09T00:00:00.000Z',
      occurredAt: '2026-07-09T00:00:00.000Z',
      sequence: 99,
      payload: signal,
    };

    // Only the id + revision travel; comment bodies are refetched over the
    // durable read path.
    expect(Object.keys(envelope.payload)).toEqual(['runId', 'commentRevision']);
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  it('pins the unified owner-scope vocabulary', () => {
    expect(REALTIME_OWNER_SCOPES).toEqual(['private', 'team', 'organization']);
    expect(REALTIME_OWNER_TYPES).toEqual(['USER', 'TEAM', 'ORGANIZATION']);
  });

  it('maps each scope kind to its owner-type discriminant', () => {
    expect(REALTIME_OWNER_SCOPE_TO_OWNER_TYPE).toEqual({
      private: 'USER',
      team: 'TEAM',
      organization: 'ORGANIZATION',
    });
  });

  it('keeps the NOTIFY byte ceiling under the Postgres 8000-byte limit', () => {
    expect(REALTIME_NOTIFY_MAX_BYTES).toBe(7000);
    expect(REALTIME_NOTIFY_MAX_BYTES).toBeLessThan(8000);
  });

  it('carries a FeedItem payload as a typed envelope', () => {
    const feedItem: FeedItem = {
      id: 'feed-1',
      type: 'worktree_started',
      occurredAt: '2026-06-17T00:00:00.000Z',
      actor: { userId: 'user-1', displayName: 'Ada' },
      worktreeId: 'wt-1',
      branchName: 'feature/x',
      workspaceName: 'canopy',
    };

    const envelope: RealtimeFeedEnvelope = {
      type: 'feed.item',
      eventId: '00000000-0000-0000-0000-000000000001',
      occurredAt: feedItem.occurredAt,
      sequence: 42,
      payload: feedItem,
    };

    // The generic envelope accepts the same payload structurally.
    const generic: RealtimeEventEnvelope<FeedItem> = envelope;

    expect(generic.sequence).toBe(42);
    expect(generic.payload.type).toBe('worktree_started');
  });

  it('carries a plan.detail signal as a typed envelope', () => {
    const signal: PlanRealtimeSignal = {
      planId: '00000000-0000-0000-0000-0000000000aa',
      revision: 7,
    };
    const envelope: RealtimePlanEnvelope = {
      type: 'plan.detail',
      eventId: `plan.detail:${signal.planId}@2026-06-17T00:00:00.000Z`,
      occurredAt: '2026-06-17T00:00:00.000Z',
      sequence: 99,
      payload: signal,
    };

    const generic: RealtimeEventEnvelope<PlanRealtimeSignal> = envelope;
    expect(generic.payload.planId).toBe(signal.planId);
    expect(generic.payload.revision).toBe(7);
  });

  it('carries a credit.pool signal as a typed envelope', () => {
    const signal: CreditPoolRealtimeSignal = {
      balanceCredits: 1250,
    };
    const envelope: RealtimeCreditPoolEnvelope = {
      type: 'credit.pool',
      eventId: 'credit.pool:user-1@2026-06-17T00:00:00.000Z',
      occurredAt: '2026-06-17T00:00:00.000Z',
      sequence: 123,
      payload: signal,
    };

    const generic: RealtimeEventEnvelope<CreditPoolRealtimeSignal> = envelope;
    expect(generic.payload.balanceCredits).toBe(1250);
  });
});
