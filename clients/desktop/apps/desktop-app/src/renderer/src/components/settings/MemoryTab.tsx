import { type JSX } from 'react';
import { MemoryPanel } from '@canopy/ui-app/local-memory';
import {
  USER_MEMORY_SCOPE,
  notifyLocalMemory,
} from '@/client/ipc-local-memory-client';
import { useDesktopLocalMemoryClient } from '@/hooks/useDesktopLocalMemoryClient';
import { LocalMemorySettings } from './LocalMemorySettings';
import { OrgMemorySettings } from './OrgMemorySettings';
import { SettingsGroup, SettingsPage, SettingsSection } from './SettingsLayout';

const USER_SCOPES = [USER_MEMORY_SCOPE];

export function MemoryTab(): JSX.Element {
  const client = useDesktopLocalMemoryClient();
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
        {/* The Memory panel is the group's one row: search over the list.
            It grows with its memories and scrolls past 576px. */}
        <SettingsGroup>
          <div className="flex max-h-144 flex-col p-2">
            <MemoryPanel
              client={client}
              notify={notifyLocalMemory}
              scopes={USER_SCOPES}
            />
          </div>
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
