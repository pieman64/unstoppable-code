import type { JSX } from 'react';
import { CheckIcon } from '../icons/AppIcons';
import { DataTable } from './DataTable';

export interface PluginHarnessConnectionRow {
  id: string;
  name: string;
  installation: 'Installed' | 'Not installed' | 'Not supported';
}

/** Availability is per harness; the shared account connection is shown once. */
interface PluginHarnessConnectionsProps {
  rows: readonly PluginHarnessConnectionRow[];
}

export function PluginHarnessConnections({
  rows,
}: PluginHarnessConnectionsProps): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <DataTable
      testId="plugin-harness-connections"
      caption="Plugin installation by harness"
      layout="fixed"
      rows={rows}
      rowKey={(row) => row.id}
      rowAttributes={(row) => ({ 'data-testid': `plugin-harness-${row.id}` })}
      columns={[
        {
          key: 'harness',
          header: 'Harness',
          width: '50%',
          rowHeader: true,
          overflow: 'wrap',
          render: (row) => row.name,
        },
        {
          key: 'installation',
          header: 'Installation',
          align: 'right',
          tone: (row) =>
            row.installation === 'Installed' ? 'success' : 'secondary',
          render: (row) => (
            <span className="inline-flex items-center gap-1.5">
              {row.installation === 'Installed' && (
                <CheckIcon size={16} className="shrink-0" aria-hidden="true" />
              )}
              {row.installation}
            </span>
          ),
        },
      ]}
    />
  );
}
