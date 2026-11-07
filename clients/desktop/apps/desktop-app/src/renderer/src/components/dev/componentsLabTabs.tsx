import { useState, type JSX } from 'react';
import {
  SegmentedControl,
  type SegmentedControlShape,
  Surface,
  TabBar,
  type TabBarItem,
} from '@canopy/ui-shared/components';
import {
  ChatIcon,
  FolderIcon,
  SettingsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

type PageTab = 'overview' | 'runs' | 'settings' | 'danger';

const PAGE_TABS: readonly TabBarItem<PageTab>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'runs', label: 'Runs', count: 12 },
  { id: 'settings', label: 'Settings' },
  { id: 'danger', label: 'Delete', tone: 'destructive' },
];

const ICON_TABS: readonly TabBarItem<PageTab>[] = [
  { id: 'overview', label: 'Chats', icon: <ChatIcon /> },
  { id: 'runs', label: 'Files', icon: <FolderIcon />, count: 3 },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon /> },
];

function LiveTabBar({
  items,
  density,
  orientation,
  inset,
}: {
  readonly items: readonly TabBarItem<PageTab>[];
  readonly density?: 'default' | 'compact';
  readonly orientation?: 'horizontal' | 'vertical';
  readonly inset?: 'none' | 'dialog';
}): JSX.Element {
  const [value, setValue] = useState<PageTab>('overview');
  return (
    <TabBar
      label="Specimen tabs"
      items={items}
      value={value}
      onChange={setValue}
      density={density}
      orientation={orientation}
      inset={inset}
    />
  );
}

export function TabBarSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Page header (default density)">
        <LiveTabBar items={PAGE_TABS} />
      </SpecimenPanel>
      <SpecimenPanel title="Dialog header (compact, 24px dialog inset)">
        <Surface variant="group">
          <LiveTabBar items={PAGE_TABS} density="compact" inset="dialog" />
        </Surface>
      </SpecimenPanel>
      <SpecimenGrid min={240}>
        <SpecimenCell label="With icons and a count">
          <LiveTabBar items={ICON_TABS} />
        </SpecimenCell>
        <SpecimenCell label="Vertical, for a panel rail">
          <LiveTabBar items={ICON_TABS} orientation="vertical" />
        </SpecimenCell>
      </SpecimenGrid>
    </div>
  );
}

type Mode = 'light' | 'dark' | 'system';

const MODE_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] as const;

function LiveSegmented({
  shape,
  width,
  disabled,
  unavailable,
  loading,
}: {
  readonly shape?: SegmentedControlShape;
  readonly width?: 'control' | 'fill' | 'content';
  readonly disabled?: boolean;
  readonly unavailable?: boolean;
  readonly loading?: boolean;
}): JSX.Element {
  const [value, setValue] = useState<Mode>('dark');
  return (
    <SegmentedControl
      label="Appearance"
      value={loading ? null : value}
      onChange={setValue}
      shape={shape}
      width={width}
      disabled={disabled}
      options={MODE_OPTIONS.map((option) =>
        unavailable && option.value === 'system'
          ? {
              ...option,
              unavailable: true,
              tooltip: 'Your organization sets this',
            }
          : option,
      )}
    />
  );
}

export function SegmentedControlSpecimen(): JSX.Element {
  return (
    <SpecimenPanel>
      <SpecimenGrid min={240}>
        <SpecimenCell label="rounded, control width (default)">
          <LiveSegmented />
        </SpecimenCell>
        <SpecimenCell label="capsule">
          <LiveSegmented shape="capsule" />
        </SpecimenCell>
        <SpecimenCell label="content width">
          <LiveSegmented width="content" />
        </SpecimenCell>
        <SpecimenCell label="fill width" wide>
          <LiveSegmented width="fill" />
        </SpecimenCell>
        <SpecimenCell label="One option unavailable">
          <LiveSegmented unavailable />
        </SpecimenCell>
        <SpecimenCell label="Disabled">
          <LiveSegmented disabled />
        </SpecimenCell>
        <SpecimenCell label="Loading (value null)">
          <LiveSegmented loading />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}
