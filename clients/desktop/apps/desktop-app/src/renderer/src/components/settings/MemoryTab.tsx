import { type JSX } from 'react';
import { MemoryExplorer } from '@/components/memory/MemoryExplorer';
import { LocalMemorySettings } from './LocalMemorySettings';
import { OrgMemorySettings } from './OrgMemorySettings';
import { SettingsGroup, SettingsPage, SettingsSection } from './SettingsLayout';

export function MemoryTab(): JSX.Element {
  return (
    <SettingsPage
      title="Memory"
      description="Choose what your chats remember and manage knowledge saved about you"
      dataTestId="settings-tab-memory"
    >
      <LocalMemorySettings />
      <OrgMemorySettings />
      <SettingsSection
        title="Your memories"
        description="Saved on this device and shared across your projects. Project memories are in each project's Memory panel."
        dataTestId="user-memory-settings"
      >
        {/* The explorer is the group's one row: search over the list. */}
        <SettingsGroup>
          <div className="flex max-h-144 flex-col">
            <MemoryExplorer scope="user" />
          </div>
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
