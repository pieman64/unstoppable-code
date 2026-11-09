import type { JSX } from 'react';
import { PluginWorksWith } from '@canopy/ui-shared/components';
import { useClaudeAuthStatus } from '@/hooks/useClaudeAuthStatus';
import { useCodexAuthStatus } from '@/hooks/useCodexAuthStatus';
import { useCursorChatAvailable } from '@/hooks/useCursorChatAvailable';

interface PluginHarnessStatusProps {
  installed: boolean;
}

/** Rows describe availability inside the app; the app itself is not a row. */
export function PluginHarnessStatus({
  installed,
}: PluginHarnessStatusProps): JSX.Element | null {
  const claude = useClaudeAuthStatus();
  const codex = useCodexAuthStatus();
  const cursor = useCursorChatAvailable(true);
  const harnesses = [
    ...(claude?.authenticated ? [{ id: 'claude', name: 'Claude' }] : []),
    ...(codex?.authenticated ? [{ id: 'codex', name: 'Codex' }] : []),
    ...(cursor ? [{ id: 'cursor', name: 'Cursor' }] : []),
  ];
  return (
    <PluginWorksWith
      rows={harnesses.map((harness) => ({
        id: harness.id,
        name: harness.name,
        installation: installed ? 'Installed' : 'Not installed',
      }))}
    />
  );
}
