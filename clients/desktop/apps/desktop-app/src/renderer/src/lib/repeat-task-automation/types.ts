import type { HomeComposerMode } from '@/stores/homeComposerStore';

/**
 * The Home composer draft as it was submitted, captured before
 * `dispatchHomeSend()` resets the store.
 */
export interface HomeTaskSnapshot {
  /** Only the New task page (`page`) counts; empty-chat composers embed Home. */
  surface: 'page' | 'embedded';
  mode: HomeComposerMode;
  text: string;
  workspaceId: string | null;
  fileReferenceCount: number;
  attachmentCount: number;
  scheduled: boolean;
  /** `HomeLinkTargetState['status']`; anything but `'idle'` is link-routed. */
  linkTargetStatus: string;
  accountEpoch: number;
}
