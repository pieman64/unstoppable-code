import {
  prMergeStartsAgentChat,
  type MergeQueueAgentHandling,
  type PrStatusData,
} from '@canopy/desktop-shared/types/github';

import type { PrMergeRoute } from '@canopy/ui-app/pull-requests';

// The Merge button's presentation (route glyph and idle help) is shared with
// the web header (REG-3025); only the route resolution reads desktop state.
export {
  describeMergeButton,
  type MergeButtonPresentation,
  type PrMergeRoute,
} from '@canopy/ui-app/pull-requests';

export function resolvePrMergeRoute(args: {
  status: Pick<PrStatusData, 'mergeQueue'>;
  handling: MergeQueueAgentHandling;
  queueRemovedHookActive: boolean;
}): PrMergeRoute {
  if (prMergeStartsAgentChat(args)) return 'chat';
  return args.status.mergeQueue?.required === true ? 'queue' : 'direct';
}
