import { useEffect, useState, type JSX } from 'react';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
import type {
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStartPageStore } from '@/stores/startPageStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  StartPageSettingControl,
  type StartPageSettingValue,
} from './StartPageSettingControl';
import {
  AddToWorktreeActionControls,
  SaveLocalButton,
  SourceLocalToggle,
  SourceWorktreePicker,
} from '../../worktree/WorktreeSettingsControls';
import type {
  AddToWorktreeFeedback,
  AddToWorktreeTarget,
} from '../../worktree/worktree-settings-controls-state';

interface CodeStartPageSettingsProps {
  project: SingleRepoSidebarItem | MultiRepoSidebarItem;
  initialWorktreeId?: string;
  initialMode?: 'source' | 'local';
  prefill?: ProjectStartPage | null;
}

export function CodeStartPageSettings({
  project,
  initialWorktreeId,
  initialMode = 'local',
  prefill,
}: CodeStartPageSettingsProps): JSX.Element {
  const [mode, setMode] = useState<'source' | 'local'>(initialMode);
  const [worktreeId, setWorktreeId] = useState(initialWorktreeId);
  const [value, setValue] = useState<StartPageSettingValue>(
    prefill === undefined ? project.startPage : prefill,
  );
  const [saving, setSaving] = useState(false);
  const [startPageValid, setStartPageValid] = useState(true);
  const [error, setError] = useState('');
  const [worktreePickerOpen, setWorktreePickerOpen] = useState(false);
  const [existingWorktreePickerOpen, setExistingWorktreePickerOpen] =
    useState(false);
  const [addFeedback, setAddFeedback] = useState<AddToWorktreeFeedback>({
    phase: 'idle',
  });

  useEffect(() => {
    if (mode === 'local') {
      setValue(prefill === undefined ? project.startPage : prefill);
      setStartPageValid(true);
      return;
    }
    setStartPageValid(false);
    let canceled = false;
    void window.api
      .getWorkspaceSettingsData({ workspaceId: project.id, worktreeId })
      .then((response) => {
        if (!canceled) {
          setValue(
            prefill !== undefined
              ? prefill
              : (response.manifest?.startPage ?? null),
          );
          setStartPageValid(true);
        }
      })
      .catch((cause) => {
        if (!canceled)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not load the start page.',
          );
      });
    return (): void => {
      canceled = true;
    };
  }, [mode, prefill, project.id, project.startPage, worktreeId]);

  const save = async (sourceTarget?: AddToWorktreeTarget): Promise<void> => {
    if (!startPageValid) return;
    setSaving(true);
    setError('');
    if (mode === 'source') {
      const targetLabel =
        sourceTarget?.mode === 'existing'
          ? (project.worktrees.find(
              (worktree) => worktree.id === sourceTarget.worktreeId,
            )?.branchName ?? sourceTarget.worktreeId)
          : 'new worktree';
      setAddFeedback({ phase: 'applying', targetLabel });
    }
    try {
      if (mode === 'local') {
        await window.api.setWorkspaceStartPage({
          workspaceId: project.id,
          ...(value === undefined ? {} : { startPage: value }),
        });
      } else {
        const selectedTarget =
          sourceTarget ??
          (worktreeId
            ? { mode: 'existing' as const, worktreeId }
            : { mode: 'new' as const });
        const target =
          selectedTarget.mode === 'existing'
            ? selectedTarget
            : {
                mode: 'new' as const,
                existingWorktreeIds: project.worktrees.map(
                  (worktree) => worktree.id,
                ),
              };
        if (project.type === 'multi-repo') {
          await window.api.applyWorkspaceSourceChanges({
            workspaceId: project.id,
            target,
            startPage: value ?? null,
          });
        } else {
          await window.api.applyProjectSourceChanges({
            projectId: project.id,
            target,
            startPage: value ?? null,
          });
        }
      }
      await useProjectsStore.getState().loadProjects();
      await useStartPageStore.getState().refreshProject(project.id);
      useGitHubStore.getState().addToast('Start page saved', 'success');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Failed to save the start page.',
      );
    } finally {
      setSaving(false);
      setAddFeedback({ phase: 'idle' });
    }
  };

  return (
    <div className="space-y-4">
      <SourceLocalToggle mode={mode} onChange={setMode} />
      <StartPageSettingControl
        workspaceId={project.id}
        target={
          mode === 'source' && worktreeId
            ? { kind: 'worktree', worktreeId }
            : { kind: 'baseline' }
        }
        projectType={project.type}
        value={value}
        onChange={setValue}
        onValidityChange={setStartPageValid}
        allowUseTeamSetting={mode === 'local'}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div
        className={`flex items-center ${mode === 'source' ? 'justify-between' : 'justify-end'}`}
      >
        {mode === 'source' && (
          <SourceWorktreePicker
            selectedWorktreeId={worktreeId}
            onChange={setWorktreeId}
            worktrees={project.worktrees}
            open={worktreePickerOpen}
            onOpenChange={setWorktreePickerOpen}
            helpTooltipId="start-page-source-help"
          />
        )}
        {mode === 'source' ? (
          <AddToWorktreeActionControls
            show
            sourceInspectWorktreeId={worktreeId}
            worktrees={project.worktrees}
            feedback={addFeedback}
            buttonLabel="Add to worktree"
            disabled={saving || !startPageValid}
            existingDropdownOpen={existingWorktreePickerOpen}
            onExistingDropdownOpenChange={setExistingWorktreePickerOpen}
            onAddToWorktree={(target) => void save(target)}
          />
        ) : (
          <SaveLocalButton
            disabled={saving || !startPageValid}
            isSaving={saving}
            onClick={() => void save()}
          />
        )}
      </div>
    </div>
  );
}
