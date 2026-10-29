import { type JSX, useCallback, useMemo } from 'react';
import { type ShareGateContext, useShareAccess } from './useShareAccess';
import {
  SHARE_COLLECTION_GATE_CONTEXT,
  SHARE_PIPELINE_GATE_CONTEXT,
  SHARE_PLUGIN_GATE_CONTEXT,
  SHARE_SKILL_GATE_CONTEXT,
} from '@/lib/share-gate-context';

/** The reusable kinds a Share action opens a dialog for. */
export type ShareActionKind =
  | 'skill'
  | 'pipeline'
  | 'automation'
  | 'agent'
  | 'collection'
  | 'plugin';

/**
 * The sign-in prompt each gated kind shows. `null` marks a kind whose Share
 * opens its dialog directly: agents and automations have no sign-in gate,
 * because their dialog carries its own connect state.
 */
const GATE_CONTEXT: Record<ShareActionKind, ShareGateContext | null> = {
  skill: SHARE_SKILL_GATE_CONTEXT,
  pipeline: SHARE_PIPELINE_GATE_CONTEXT,
  collection: SHARE_COLLECTION_GATE_CONTEXT,
  plugin: SHARE_PLUGIN_GATE_CONTEXT,
  automation: null,
  agent: null,
};

export interface ShareAction {
  /** Whether a Share action renders for this kind at all. */
  canShare: (kind: ShareActionKind) => boolean;
  /**
   * Starts a share: runs `open` (which opens the kind's share dialog) once
   * the account can share, prompting for sign-in first when it cannot.
   */
  share: (
    kind: ShareActionKind,
    open: () => void,
    onCancelled?: () => void,
  ) => void;
  /** Render once in the host to back the sign-in prompt. */
  shareGateModal: JSX.Element | null;
}

/**
 * One entry point for every Share action on the desktop. A surface that
 * lists several kinds (the Marketplace) asks one hook whether each can be
 * shared and how to start it, instead of repeating each kind's gate.
 */
export function useShareAction(): ShareAction {
  const { requestShare, shareGateModal } = useShareAccess();
  const canShare = useCallback((): boolean => true, []);
  const share = useCallback(
    (
      kind: ShareActionKind,
      open: () => void,
      onCancelled?: () => void,
    ): void => {
      const context = GATE_CONTEXT[kind];
      if (context === null) {
        open();
        return;
      }
      requestShare(context, open, onCancelled);
    },
    [requestShare],
  );
  return useMemo(
    () => ({ canShare, share, shareGateModal }),
    [canShare, share, shareGateModal],
  );
}
