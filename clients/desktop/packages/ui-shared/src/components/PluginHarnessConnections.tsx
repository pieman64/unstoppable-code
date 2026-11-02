import type { JSX } from 'react';
import { CheckIcon } from '../icons/AppIcons';

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
    <section
      data-testid="plugin-harness-connections"
      className="min-w-0 overflow-hidden rounded-lg ring-[length:var(--border-hairline)] ring-line-base bg-secondary/30"
    >
      <table className="w-full table-fixed text-s">
        <caption className="sr-only">Plugin installation by harness</caption>
        <thead className="border-b text-xs fg-secondary">
          <tr>
            <th scope="col" className="w-1/2 px-4 py-2 text-left font-normal">
              Harness
            </th>
            <th scope="col" className="px-4 py-2 text-right font-normal">
              Installation
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.id} data-testid={`plugin-harness-${row.id}`}>
              <th
                scope="row"
                className="break-words px-4 py-2 text-left font-normal fg-primary"
              >
                {row.name}
              </th>
              <td
                className={`px-4 py-2 text-right ${row.installation === 'Installed' ? 'fg-success' : 'fg-secondary'}`}
              >
                <span className="inline-flex items-center gap-1.5">
                  {row.installation === 'Installed' && (
                    <CheckIcon
                      size={16}
                      className="shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  {row.installation}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
