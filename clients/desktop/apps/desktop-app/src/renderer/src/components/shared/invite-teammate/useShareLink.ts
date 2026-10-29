import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SharedContainerLink,
  SharedContainerLinkAudience,
  SharedContainerSummary,
} from '@canopy/protocol/shared-containers';
import type {
  SetSharedContainerLinkIpcRequest,
  SetSharedContainerLinkIpcResponse,
  SharedContainerPublicationState,
  SharedContainerTargetRequest,
} from '@canopy/desktop-shared/types';
import { resolveSharedContainerLinkUrl } from '@/lib/share-links';
import {
  LINK_LOAD_FAILURE_LABEL,
  LINK_UPDATE_FAILURE_LABEL,
} from './shareCopy';
import { flushShareLayoutSave } from './useSharePreview';

export interface UseShareLinkOptions {
  /** The owner's container; null before the first invite or link. */
  containerId: string | null;
  /** Local target used to create the first owner container and link. */
  createTarget: SharedContainerTargetRequest | null;
  /**
   * The first link created the owner container. Its first publication is
   * already scheduled; `publicationState` is the queued record main wrote.
   */
  onContainerCreated?: (
    container: SharedContainerSummary,
    publicationState: SharedContainerPublicationState | undefined,
  ) => void;
}

export interface UseShareLinkResult {
  containerId: string | null;
  /** The live link, or `null` while link sharing is off. */
  link: SharedContainerLink | null;
  /** The link projected onto the configured web origin, for Copy link. */
  url: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** `null` turns the link off. Resolves `true` when the change landed. */
  setAudience: (
    audience: SharedContainerLinkAudience | null,
  ) => Promise<boolean>;
  reset: () => Promise<boolean>;
}

/**
 * The owner's capability link for one container: load, change the audience,
 * turn it off, and rotate it. Every answer is dropped when the container it
 * was asked about is no longer the one on screen.
 */
export function useShareLink({
  containerId,
  createTarget,
  onContainerCreated,
}: UseShareLinkOptions): UseShareLinkResult {
  const [link, setLink] = useState<SharedContainerLink | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epochRef = useRef(0);

  const applyLink = useCallback(
    async (next: SharedContainerLink | null, epoch: number): Promise<void> => {
      const nextUrl = next
        ? await resolveSharedContainerLinkUrl(next.url)
        : null;
      if (epoch !== epochRef.current) return;
      setLink(next);
      setUrl(nextUrl);
    },
    [],
  );

  useEffect(() => {
    const epoch = ++epochRef.current;
    setLink(null);
    setUrl(null);
    setError(null);
    setSaving(false);
    const bridge = window.api?.sharedContainers;
    if (!containerId || !bridge) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async (): Promise<void> => {
      try {
        const current = await bridge.getLink({ containerId });
        await applyLink(current, epoch);
      } catch {
        if (epoch === epochRef.current) setError(LINK_LOAD_FAILURE_LABEL);
      } finally {
        if (epoch === epochRef.current) setLoading(false);
      }
    })();
  }, [containerId, applyLink]);

  const mutate = useCallback(
    async (
      run: () => Promise<SetSharedContainerLinkIpcResponse>,
    ): Promise<boolean> => {
      const epoch = epochRef.current;
      setSaving(true);
      setError(null);
      try {
        const next = await run();
        await applyLink(next.link, epoch);
        if (epoch === epochRef.current && next.container) {
          onContainerCreated?.(next.container, next.publicationState);
        }
        return epoch === epochRef.current;
      } catch {
        if (epoch === epochRef.current) setError(LINK_UPDATE_FAILURE_LABEL);
        return false;
      } finally {
        if (epoch === epochRef.current) setSaving(false);
      }
    },
    [applyLink, onContainerCreated],
  );

  const setAudience = useCallback(
    (audience: SharedContainerLinkAudience | null): Promise<boolean> =>
      mutate(async () => {
        let request: SetSharedContainerLinkIpcRequest;
        if (containerId) {
          request = { containerId, audience };
        } else {
          if (!createTarget || audience === null) {
            throw new Error('Link target is unavailable');
          }
          // Creating the share saves the layout, so main must read the one
          // on screen rather than the last debounced save.
          await flushShareLayoutSave(
            createTarget.projectId,
            createTarget.worktreeId,
          );
          request = { ...createTarget, containerId: null, audience };
        }
        return window.api.sharedContainers.setLink(request);
      }),
    [containerId, createTarget, mutate],
  );

  const reset = useCallback(
    (): Promise<boolean> =>
      mutate(async () => {
        if (!containerId) throw new Error('Link target is unavailable');
        return {
          link: await window.api.sharedContainers.resetLink({ containerId }),
        };
      }),
    [containerId, mutate],
  );

  return {
    containerId,
    link,
    url,
    loading,
    saving,
    error,
    setAudience,
    reset,
  };
}
