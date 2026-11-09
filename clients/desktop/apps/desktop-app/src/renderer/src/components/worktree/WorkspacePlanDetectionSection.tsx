import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  PlanDetectionPreferences,
  PlanDetectionRule,
  WorkspacePlanDetectionConfig,
} from '@canopy/desktop-shared/types';
import { PlanDetectionRulesEditor } from '@/components/shared/PlanDetectionRulesEditor';
import {
  getWorkspaceInheritedRows,
  makeRuleId,
} from '@/components/settings/planDetectionTabState';
import {
  Stack,
  LoadingIndicator,
  type SettingsSaveState,
} from '@canopy/ui-shared/components';

interface LoadedState {
  globalPrefs: PlanDetectionPreferences;
  canopyRules: PlanDetectionRule[];
  local: WorkspacePlanDetectionConfig;
}

export interface WorkspacePlanDetectionSectionProps {
  workspaceId: string;
  /** Show the explanation above the rules; a page that already says it hides it. */
  showIntro?: boolean;
  /** Reports each save, for a page that shows one save line. */
  onSaveStateChange?: (state: SettingsSaveState) => void;
}

export function WorkspacePlanDetectionSection({
  workspaceId,
  showIntro = true,
  onSaveStateChange,
}: WorkspacePlanDetectionSectionProps): JSX.Element {
  const onSaveStateChangeRef = useRef(onSaveStateChange);
  onSaveStateChangeRef.current = onSaveStateChange;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [data, setData] = useState<LoadedState | null>(null);

  useEffect((): (() => void) => {
    let cancelled = false;
    setStatus('loading');
    void Promise.all([
      window.api.loadPreferences(),
      window.api.getWorkspaceSettingsData({ workspaceId }),
    ])
      .then(([prefs, settings]) => {
        if (cancelled) {
          return;
        }
        setData({
          globalPrefs: prefs.planDetection,
          canopyRules: settings.manifest?.planDetection?.rules ?? [],
          local: settings.localConfig.planDetection ?? {},
        });
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const persist = useCallback(
    async (next: WorkspacePlanDetectionConfig): Promise<void> => {
      setData((prev) => (prev ? { ...prev, local: next } : prev));
      onSaveStateChangeRef.current?.('saving');
      await window.api
        .saveWorkspacePlanDetection({ workspaceId, planDetection: next })
        .then(() => onSaveStateChangeRef.current?.('saved'))
        .catch(() => {
          // Non-fatal: optimistic UI persists for this session.
          onSaveStateChangeRef.current?.('error');
        });
    },
    [workspaceId],
  );

  if (status !== 'ready' || !data) {
    return (
      <div className="text-s fg-secondary">
        {status === 'error' ? (
          'Unable to load plan detection settings.'
        ) : (
          <LoadingIndicator />
        )}
      </div>
    );
  }

  const disabledRuleIds = data.local.disabledRuleIds ?? [];
  const customRules = data.local.customRules ?? [];

  return (
    <Stack gap="group" data-testid="workspace-plan-detection">
      {showIntro && (
        <p className="text-s fg-secondary">
          Detect plan documents in agent chats. Inherited rules come from your
          global settings and this project&apos;s canopy.json; disable any you
          don&apos;t want here, or add project-only rules.
        </p>
      )}
      <PlanDetectionRulesEditor
        dataTestIdPrefix="workspace-plan-detection"
        inherited={getWorkspaceInheritedRows({
          globalPrefs: data.globalPrefs,
          canopyRules: data.canopyRules,
          disabledRuleIds,
        })}
        customRules={customRules}
        onToggleInherited={(ruleId, disabled): void => {
          const set = new Set(disabledRuleIds);
          if (disabled) {
            set.add(ruleId);
          } else {
            set.delete(ruleId);
          }
          void persist({ ...data.local, disabledRuleIds: Array.from(set) });
        }}
        onAddCustomRule={(rule): void => {
          const next: PlanDetectionRule = { ...rule, id: makeRuleId() };
          void persist({
            ...data.local,
            customRules: [...customRules, next],
          });
        }}
        onRemoveCustomRule={(ruleId): void => {
          void persist({
            ...data.local,
            customRules: customRules.filter((r) => r.id !== ruleId),
          });
        }}
      />
    </Stack>
  );
}
