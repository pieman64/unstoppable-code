import type { JSX } from 'react';
import {
  COMMAND_DEFINITIONS,
  type CommandDefinition,
  type CommandId,
} from '@/lib/keyboardShortcuts';
import { useNavigationStore } from '@/stores/navigationStore';
import { Button, Kbd } from '@canopy/ui-shared/components';
import { GlobalFocusShortcutSection } from './GlobalFocusShortcutSection';
import { ScriptShortcutsSection } from './ScriptShortcutsSection';
import {
  COMPOSER_SHORTCUT_COMMAND_IDS,
  ESSENTIAL_SHORTCUT_COMMAND_IDS,
  LAYOUT_SHORTCUT_COMMAND_IDS,
  NAVIGATION_SHORTCUT_COMMAND_IDS,
  PANEL_SHORTCUT_COMMAND_IDS,
  SURFACE_SHORTCUT_COMMAND_IDS,
} from './keyboardShortcutSections';
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from './SettingsLayout';

interface ShortcutRowProps {
  command: CommandDefinition;
}

function findCommand(commandId: CommandId): CommandDefinition {
  const command = COMMAND_DEFINITIONS.find((entry) => entry.id === commandId);
  if (command) {
    return command;
  }

  return {
    id: commandId,
    title: commandId,
    category: 'settings',
    keywords: [],
  };
}

/** One command: its name on the leading side, its keys on the trailing side. */
function ShortcutRow({ command }: ShortcutRowProps): JSX.Element {
  return (
    <SettingsRow
      label={command.title}
      dataTestId={`shortcut-row-${command.id}`}
      control={
        command.shortcut ? (
          <Kbd data-testid="shortcut-keys" shortcut={command.shortcut} />
        ) : (
          <span className="text-xs fg-secondary">Command palette</span>
        )
      }
    />
  );
}

function ShortcutSection({
  title,
  commandIds,
}: {
  title: string;
  commandIds: CommandId[];
}): JSX.Element {
  return (
    <SettingsSection title={title}>
      <SettingsGroup>
        {commandIds.map((commandId) => (
          <ShortcutRow key={commandId} command={findCommand(commandId)} />
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}

export function KeyboardShortcutsTab(): JSX.Element {
  const openCommandPalette = useNavigationStore(
    (state) => state.openCommandPalette,
  );

  return (
    <SettingsPage
      title="Keyboard shortcuts"
      description="Use the command palette for navigation and common worktree actions."
      dataTestId="settings-tab-shortcuts"
    >
      <GlobalFocusShortcutSection />

      <ShortcutSection
        title="Essentials"
        commandIds={ESSENTIAL_SHORTCUT_COMMAND_IDS}
      />

      <ShortcutSection
        title="Tabs and surfaces"
        commandIds={SURFACE_SHORTCUT_COMMAND_IDS}
      />

      <ShortcutSection
        title="Composer"
        commandIds={COMPOSER_SHORTCUT_COMMAND_IDS}
      />

      <ShortcutSection
        title="Navigation"
        commandIds={NAVIGATION_SHORTCUT_COMMAND_IDS}
      />

      <ShortcutSection
        title="Layout"
        commandIds={LAYOUT_SHORTCUT_COMMAND_IDS}
      />

      <ShortcutSection title="Panels" commandIds={PANEL_SHORTCUT_COMMAND_IDS} />

      <ScriptShortcutsSection />

      <SettingsSection title="Command palette">
        <SettingsGroup>
          <SettingsRow
            label="Search"
            description="Find worktrees, pages, settings, scripts, hooks, and activity actions."
            control={
              <Button
                size="compact"
                variant="secondary"
                onClick={() => openCommandPalette()}
              >
                Open command palette
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
