import {
  artifactInventoryScope,
  observeArtifactSkills,
} from '@/stores/agentArtifactInventoryStore';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useState, useEffect, useCallback } from 'react';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';

interface UseSkillListReturn {
  skills: InstalledSkillInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refreshOrThrow: () => Promise<void>;
}

export function useSkillList(): UseSkillListReturn {
  const contextEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const contextGeneration = useWorkspaceContextStore((state) =>
    contextEnabled ? state.appliedGeneration : 0,
  );
  const [skills, setSkills] = useState<InstalledSkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (throwOnError = false) => {
      const artifactScope = artifactInventoryScope();
      observeArtifactSkills(null);
      if (contextEnabled) setSkills([]);
      setLoading(true);
      setError(null);
      try {
        const result = await window.skills.loadSkills();
        if (
          contextEnabled &&
          useWorkspaceContextStore.getState().appliedGeneration !==
            contextGeneration
        )
          return;
        if (result.success && result.data) {
          setSkills(result.data);
          observeArtifactSkills(result.data, artifactScope);
        } else {
          const message = result.error || 'Failed to load skills';
          setError(message);
          if (throwOnError) throw new Error(message);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        if (throwOnError) throw err;
      } finally {
        setLoading(false);
      }
    },
    [contextEnabled, contextGeneration],
  );

  const refresh = useCallback(async () => {
    await load();
  }, [load]);
  const refreshOrThrow = useCallback(async () => {
    await load(true);
  }, [load]);

  useEffect(() => {
    void load();
    return window.installedItems?.onChanged(() => {
      void load();
    });
  }, [load]);

  return { skills, loading, error, refresh, refreshOrThrow };
}
