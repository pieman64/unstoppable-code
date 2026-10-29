import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopPublisherSkill } from '@canopy/desktop-shared/types/skills';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

/** Page-scoped metadata read. Search filters these rows locally, without refetching. */
export function usePublisherSkills(): {
  skills: DesktopPublisherSkill[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [skills, setSkills] = useState<DesktopPublisherSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const contextEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const contextGeneration = useWorkspaceContextStore((state) =>
    contextEnabled ? state.appliedGeneration : 0,
  );
  const refresh = useCallback(async (): Promise<void> => {
    const request = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const rows = await window.skills.listMarketplace();
      if (request === sequence.current) setSkills(rows);
    } catch {
      if (request === sequence.current) {
        setSkills([]);
        setError('Publisher skills could not be loaded. Try again.');
      }
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const changed = (): void => {
      setSkills([]);
      void refresh();
    };
    changed();
    window.addEventListener('canopy:skills-changed', changed);
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, changed);
    return (): void => {
      sequence.current += 1;
      window.removeEventListener('canopy:skills-changed', changed);
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, changed);
    };
  }, [refresh, contextGeneration]);
  return { skills, loading, error, refresh };
}
