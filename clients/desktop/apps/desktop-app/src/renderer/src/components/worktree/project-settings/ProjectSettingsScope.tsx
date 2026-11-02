import type { JSX, ReactNode } from 'react';
import {
  SettingsGroup,
  SettingsSegmentedControl,
} from '@/components/settings/SettingsLayout';
import type { SettingsScope } from '../WorktreeSettingsControls';

const SCOPE_OPTIONS = [
  {
    value: 'source',
    label: 'Source controlled',
    dataTestId: 'project-settings-scope-source',
  },
  {
    value: 'local',
    label: 'Local override',
    dataTestId: 'project-settings-scope-local',
  },
] as const;

interface ProjectSettingsScopeGroupProps {
  readonly scope: SettingsScope;
  readonly onScopeChange: (next: SettingsScope) => void;
  /**
   * The rows that save the shown tab: which worktree's canopy.json to read
   * and Add to worktree for Source controlled, Save local for Local
   * override.
   */
  readonly children?: ReactNode;
}

/**
 * The Source controlled / Local override tabs. Each tab is saved by its own
 * action: canopy.json changes go into a worktree, and a local override is
 * written when Save local is pressed. Local overrides take priority.
 */
export function ProjectSettingsScopeGroup({
  scope,
  onScopeChange,
  children,
}: ProjectSettingsScopeGroupProps): JSX.Element {
  return (
    <div className="flex flex-col gap-3" data-testid="project-settings-scope">
      <div>
        <SettingsSegmentedControl
          label="Settings scope"
          value={scope}
          options={SCOPE_OPTIONS}
          onChange={onScopeChange}
        />
      </div>
      <SettingsGroup>{children}</SettingsGroup>
    </div>
  );
}
