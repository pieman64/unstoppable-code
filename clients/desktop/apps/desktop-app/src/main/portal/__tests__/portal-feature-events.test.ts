/**
 * Contract tests for the per-feature `portal.*.event` envelope builders.
 *
 * These pin the serialised payload shape to what the server's
 * `applyFeatureEntityEvent` (`state-cache-service.ts:494`) consumes, so a
 * future edit cannot quietly add an unconsumed `scope` / `target` field or
 * drop the `parentLocalId` worktree pointer.
 */
import type { PortalEntityEnvelope } from '@canopy/desktop-shared/types';
import {
  createFeatureRemoveEvent,
  createFeatureUpsertEvent,
} from '../portal-feature-events';

describe('createFeatureUpsertEvent', () => {
  it('emits a `portal.{script,hook,pipeline}.event` envelope wrapping the entity', () => {
    const entity: PortalEntityEnvelope = {
      entityType: 'script_run',
      localId: 'run-1',
      parentLocalId: 't-1',
      payload: { status: 'running' },
    };

    const event = createFeatureUpsertEvent({
      type: 'portal.script.event',
      commandId: 'cmd-1',
      entity,
    });

    expect(event.type).toBe('portal.script.event');
    expect(event.commandId).toBe('cmd-1');
    expect(event.payload).toEqual({ kind: 'upsert', entity });

    // Critical guard: the payload MUST NOT carry `scope` or `target` —
    // the server's projection layer ignores them and a stray field would
    // be dead weight on the wire.
    expect(event.payload).not.toHaveProperty('scope');
    expect(event.payload).not.toHaveProperty('target');
  });

  it('omits commandId on spontaneous (uncorrelated) emits', () => {
    const event = createFeatureUpsertEvent({
      type: 'portal.pipeline.event',
      entity: {
        entityType: 'pipeline_run',
        localId: 'run-1',
        payload: { status: 'queued' },
      },
    });
    expect(event.commandId).toBeUndefined();
  });
});

describe('createFeatureRemoveEvent', () => {
  it('emits a `kind: "remove"` payload keyed by entityType + localId + optional parent', () => {
    const event = createFeatureRemoveEvent({
      type: 'portal.hook.event',
      commandId: 'cmd-2',
      entityType: 'hook_run',
      localId: 'run-1',
      parentLocalId: 't-1',
    });

    expect(event.type).toBe('portal.hook.event');
    expect(event.commandId).toBe('cmd-2');
    expect(event.payload).toEqual({
      kind: 'remove',
      entityType: 'hook_run',
      localId: 'run-1',
      parentLocalId: 't-1',
    });
  });

  it('omits parentLocalId when the caller does not supply one', () => {
    const event = createFeatureRemoveEvent({
      type: 'portal.script.event',
      entityType: 'script_run',
      localId: 'run-1',
    });
    expect(event.payload).not.toHaveProperty('parentLocalId');
  });
});
