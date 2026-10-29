import {
  startClientOperation,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';
import type { ShareRequestSource } from '@canopy/desktop-shared/lib/skill-share-nudge';

const OPERATION_NAME = 'canopy.share_dialog';

/**
 * Records that a chat-side share dialog actually opened (after the sign-in
 * gate). Context is the resource kind and the entry point only: no names,
 * content, usage counts or registry state. A rejected target or a gate that
 * never led to a dialog records nothing.
 */
export function trackShareDialogOpen(
  resourceKind: 'skill' | 'plugin' | 'pipeline',
  source: ShareRequestSource,
): void {
  const context = { resource_kind: resourceKind, source };
  startClientOperation(OPERATION_NAME, { context });
  succeedClientOperation(OPERATION_NAME, { context });
}
