'use client';

import type { JSX } from 'react';
import type { AccountMcpConnection } from '@canopy/protocol/mcp-servers';
import {
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsSelect,
} from '@canopy/ui-shared/components';
import { accountMcpConfigName } from './accountMcpRows';

/** Selects which existing connection the surrounding MCP detail manages. */
export function McpAccountConnectionPicker({
  connections,
  value,
  onChange,
  deviceAvailable = false,
  disabled = false,
}: {
  connections: readonly AccountMcpConnection[];
  value: string | null;
  onChange: (connectionId: string | null) => void;
  deviceAvailable?: boolean;
  disabled?: boolean;
}): JSX.Element | null {
  if (connections.length + Number(deviceAvailable) < 2) return null;
  return (
    <SettingsRowsGroup>
      <SettingsRowsRow
        label="Account connection"
        control={
          <SettingsSelect
            aria-label="Account connection"
            data-testid="mcp-account-connection-picker"
            width="fit"
            disabled={disabled}
            value={
              value ??
              (deviceAvailable ? 'device' : (connections[0]?.id ?? null))
            }
            onValueChange={(id): void => onChange(id === 'device' ? null : id)}
            options={[
              ...(deviceAvailable
                ? [{ value: 'device', label: 'This device' }]
                : []),
              ...connections.map((connection) => ({
                value: connection.id,
                label: `${connection.displayName} (${accountMcpConfigName(connection.configId)})`,
              })),
            ]}
          />
        }
      />
    </SettingsRowsGroup>
  );
}
