import { useCallback, useEffect, useMemo, type JSX } from 'react';
import {
  findSidebarItemGroupByName,
  normalizeSidebarItemGroupName,
  sidebarItemGroupNameKey,
  type SidebarItemGroup,
  type SidebarItemGroupScope,
} from '@canopy/protocol/sidebar';
import { sidebarItemGroupColor } from '@canopy/ui-shared/components';
// Imported by path, not from the components barrel, so the web bundle does not
// carry a picker that only the desktop automation editor mounts.
import {
  CreatablePickerSelect,
  type CreatablePickerOption,
} from '@canopy/ui-shared/components/CreatablePickerSelect';
import {
  sidebarItemGroupScopeKey,
  useSidebarItemGroupsStore,
} from '@/stores/sidebarItemGroupsStore';

const EMPTY_GROUPS: ReturnType<
  typeof useSidebarItemGroupsStore.getState
>['byScope'][string] = [];

function findGroupOption(
  groups: readonly SidebarItemGroup[],
  options: readonly CreatablePickerOption[],
  name: string,
): CreatablePickerOption | undefined {
  const group = findSidebarItemGroupByName(groups, name);
  return group
    ? options.find((option) => option.value === group.name)
    : undefined;
}

function groupColorDot(color: SidebarItemGroup['color']): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="h-2 w-2 rounded-full"
      style={{ backgroundColor: sidebarItemGroupColor(color) }}
    />
  );
}

export interface AutomationSidebarGroupPickerProps {
  scope: SidebarItemGroupScope;
  /** Empty string means that the automation will not assign a group. */
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
}

export function AutomationSidebarGroupPicker({
  scope,
  value,
  onChange,
  disabled = false,
}: AutomationSidebarGroupPickerProps): JSX.Element {
  const stableScope = useMemo<SidebarItemGroupScope>(
    () =>
      scope.appAdvisor
        ? { appAdvisor: true }
        : { workspaceLocalId: scope.workspaceLocalId ?? '' },
    [scope.appAdvisor, scope.workspaceLocalId],
  );
  const scopeKey = sidebarItemGroupScopeKey(stableScope);
  const groups = useSidebarItemGroupsStore(
    (state) => state.byScope[scopeKey] ?? EMPTY_GROUPS,
  );

  useEffect(() => {
    const api = window.api?.sidebarItemGroups;
    if (!api) return undefined;

    const refresh = (): void => {
      void useSidebarItemGroupsStore
        .getState()
        .hydrate(stableScope)
        .catch((): undefined => undefined);
    };

    refresh();
    return api.onChanged((changedScope): void => {
      if (sidebarItemGroupScopeKey(changedScope) === scopeKey) refresh();
    });
  }, [scopeKey, stableScope]);

  // Runs match a group by name and take the first in sidebar order, so
  // same-named groups collapse into the one option a run would join.
  const options = useMemo(() => {
    const seen = new Set<string>();
    return groups.flatMap((group) => {
      const key = sidebarItemGroupNameKey(group.name);
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          value: group.name,
          label: group.name,
          leading: groupColorDot(group.color),
        },
      ];
    });
  }, [groups]);
  const findOption = useCallback(
    (
      pickerOptions: readonly CreatablePickerOption[],
      name: string,
    ): CreatablePickerOption | undefined =>
      findGroupOption(groups, pickerOptions, name),
    [groups],
  );

  return (
    <CreatablePickerSelect
      options={options}
      value={value}
      onValueChange={onChange}
      emptyLabel="No group"
      createLabel={(name): string => `Create “${name}”`}
      unmatchedValueHint="New group"
      unmatchedValueLeading={
        <span
          aria-hidden="true"
          className="h-2 w-2 rounded-full border border-dashed"
          // Color is chosen at run time; a hollow neutral dot stands in.
          style={{ borderColor: sidebarItemGroupColor('neutral') }}
        />
      }
      findOption={findOption}
      normalizeText={normalizeSidebarItemGroupName}
      searchPlaceholder="Search or create group"
      emptyListMessage="No groups"
      disabled={disabled}
      aria-label="Sidebar group"
      data-testid="automations-form-sidebar-group"
    />
  );
}
