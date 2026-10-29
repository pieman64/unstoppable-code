import type {
  PortalEntityEnvelope,
  PortalEntityType,
} from '@canopy/desktop-shared/types';
import { enqueuePortalEvent } from '../portal/portal-event-bus';
import {
  createFeatureRemoveEvent,
  createFeatureUpsertEvent,
  type PortalFeatureEventType,
} from '../portal/portal-feature-events';

export function emitPortalFeatureUpsert(input: {
  type: PortalFeatureEventType;
  commandId?: string;
  entity: PortalEntityEnvelope;
}): void {
  enqueuePortalEvent(createFeatureUpsertEvent(input));
}

export function emitPortalFeatureRemove(input: {
  type: PortalFeatureEventType;
  commandId?: string;
  entityType: PortalEntityType;
  localId: string;
  parentLocalId?: string;
}): void {
  enqueuePortalEvent(createFeatureRemoveEvent(input));
}
