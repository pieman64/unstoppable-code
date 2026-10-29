import type { AgentActionHostCapabilities } from '../surface/capabilities';
import { REFERENCE_HOST_CAPABILITIES } from './reference-host';

/** The capability profiles the package runs the reference host under. */
export const REFERENCE_HOST_PROFILES: Readonly<
  Record<string, AgentActionHostCapabilities>
> = {
  'every capability': REFERENCE_HOST_CAPABILITIES,
  'current placement, no watchers, no limits': {
    ...REFERENCE_HOST_CAPABILITIES,
    chatCreatePlacements: ['current'],
    watcherTriggers: [],
    limits: false,
    split: { forked: false, branched: false },
  },
  'new_worktree placement only': {
    ...REFERENCE_HOST_CAPABILITIES,
    chatCreatePlacements: ['new_worktree'],
  },
  'hidden instructions, any watcher target': {
    ...REFERENCE_HOST_CAPABILITIES,
    hiddenInstructions: true,
    watcherTargetScope: 'any',
  },
  'reads only': {
    ...REFERENCE_HOST_CAPABILITIES,
    actionTypes: ['workspace.get', 'worktree.list', 'chat.list', 'chat.get'],
    chatCreatePlacements: [],
    watcherTriggers: [],
    limits: false,
  },
};
