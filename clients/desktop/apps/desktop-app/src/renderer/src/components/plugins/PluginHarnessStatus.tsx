import type { JSX } from 'react';
import { PluginHarnessConnections } from '@canopy/ui-shared/components';
import { useClaudeAuthStatus } from '@/hooks/useClaudeAuthStatus';
import { useCodexAuthStatus } from '@/hooks/useCodexAuthStatus';
import { useCursorChatAvailable } from '@/hooks/useCursorChatAvailable';

interface PluginHarnessStatusProps {
  installed: boolean;
  providerInstallation?: { claude: boolean; codex: boolean; cursor: boolean };
  support?: { claude: boolean; codex: boolean; cursor: boolean };
}

/** Rows describe availability inside the app; the app itself is not a row. */
export function PluginHarnessStatus({
  installed,
  support,
  providerInstallation,
}: PluginHarnessStatusProps): JSX.Element {
  const claude = useClaudeAuthStatus();
  const codex = useCodexAuthStatus();
  const cursor = useCursorChatAvailable(true);
  const harnesses = [
    ...(claude?.authenticated
      ? [
          {
            id: 'claude',
            name: 'Claude',
            supported: support?.claude ?? true,
            installed: providerInstallation?.claude ?? installed,
          },
        ]
      : []),
    ...(codex?.authenticated
      ? [
          {
            id: 'codex',
            name: 'Codex',
            supported: support?.codex ?? true,
            installed: providerInstallation?.codex ?? installed,
          },
        ]
      : []),
    ...(cursor
      ? [
          {
            id: 'cursor',
            name: 'Cursor',
            supported: support?.cursor ?? true,
            installed: providerInstallation?.cursor ?? installed,
          },
        ]
      : []),
  ];
  return (
    <PluginHarnessConnections
      rows={harnesses.map((harness) => ({
        id: harness.id,
        name: harness.name,
        installation: !harness.supported
          ? 'Not supported'
          : harness.installed
            ? 'Installed'
            : 'Not installed',
      }))}
    />
  );
}
