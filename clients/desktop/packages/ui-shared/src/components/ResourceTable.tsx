import type { JSX, ReactNode } from 'react';

export interface ResourceTableHeader {
  label: string;
  align: 'left' | 'right';
}

/**
 * Bordered table shell used by the plugins-surface resource lists
 * (skills/agents/MCP servers/plugins). Ported from the desktop
 * `components/pages` original — class names match it exactly so
 * tests/selectors and visual diffs are unchanged.
 */
export function ResourceTable({
  headers,
  children,
}: {
  headers: ResourceTableHeader[];
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="border rounded-lg overflow-hidden">
      <table className="w-full text-s">
        <thead>
          <tr className="bg-secondary/50 border-b">
            {headers.map((header) => (
              <th
                key={header.label}
                className={`${header.align === 'right' ? 'text-right' : 'text-left'} px-4 py-3 font-medium fg-secondary`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
