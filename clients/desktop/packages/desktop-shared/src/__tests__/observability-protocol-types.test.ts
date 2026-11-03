import type {
  AgentAuditDeferredResource,
  AgentAuditFileReference,
  AgentAuditModelSource,
  AgentAuditProvider,
} from '@canopy/protocol/observability';
import type { AgentProviderType, FileReference } from '../types';
import type { DeferredResourceSummary } from '../types/deferred-tools';
import type {
  ModelHarness,
  ModelHarnessSource,
} from '../types/model-harnesses';
import type { AgentExecutionHarness } from '@canopy/protocol/models';

type Same<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

// The protocol mirrors these desktop unions so it imports nothing local;
// any drift fails type checking here.
const mirrors: {
  provider: Same<AgentAuditProvider, AgentProviderType>;
  modelSource: Same<AgentAuditModelSource, ModelHarnessSource>;
  harness: Same<AgentExecutionHarness, ModelHarness>;
  fileReference: Same<AgentAuditFileReference, FileReference>;
  deferredResource: Same<AgentAuditDeferredResource, DeferredResourceSummary>;
} = {
  provider: true,
  modelSource: true,
  harness: true,
  fileReference: true,
  deferredResource: true,
};

describe('observability protocol mirrors', () => {
  it('match the desktop types they mirror', () => {
    expect(Object.values(mirrors).every(Boolean)).toBe(true);
  });
});
