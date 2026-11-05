import type { JSX } from 'react';
import {
  Badge,
  Button,
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  Skeleton,
} from '@canopy/ui-shared/components';

/**
 * Loading states for the MCP servers page, built from the same table
 * primitives and cell content as the loaded table, with plain samples inside
 * `Skeleton`, so the bars sit where the rows will. The loaded table reads
 * live statuses and account state, so it cannot render from a sample.
 */

const SAMPLE_SERVERS = [
  {
    name: 'GitHub',
    subtitle: 'https://api.example.com/mcp',
    type: 'http',
    status: 'Connected',
    updated: 'Jan 4, 2026',
  },
  {
    name: 'Linear',
    subtitle: 'https://mcp.example.com/sse',
    type: 'sse',
    status: 'Connected',
    updated: 'Jan 2, 2026',
  },
  {
    name: 'Filesystem',
    subtitle: 'npx server-filesystem',
    type: 'stdio',
    status: 'Not connected',
    updated: 'Dec 30, 2025',
  },
] as const;

/** The servers table: its columns, with three sample rows. */
export function McpServersTableSkeleton(): JSX.Element {
  return (
    <Skeleton loading label="Loading MCP servers" testId="mcp-servers-loading">
      <DataTableFrame caption="MCP servers">
        <DataTableHead>
          <DataTableHeaderCell width="100%" minWidth="10rem">
            Name
          </DataTableHeaderCell>
          <DataTableHeaderCell>Type</DataTableHeaderCell>
          <DataTableHeaderCell>Status</DataTableHeaderCell>
          <DataTableHeaderCell>Last updated</DataTableHeaderCell>
          <DataTableHeaderCell align="right">Actions</DataTableHeaderCell>
        </DataTableHead>
        <DataTableBody>
          {SAMPLE_SERVERS.map((server) => (
            <DataTableRow key={server.name}>
              <DataTableCell tone="primary" overflow="truncate">
                <span className="block truncate fg-primary font-medium">
                  {server.name}
                </span>
                <p className="text-xs fg-secondary line-clamp-1">
                  {server.subtitle}
                </p>
              </DataTableCell>
              <DataTableCell>
                <Badge>{server.type}</Badge>
              </DataTableCell>
              <DataTableCell overflow="wrap">{server.status}</DataTableCell>
              <DataTableCell>{server.updated}</DataTableCell>
              <DataTableCell align="right" overflow="wrap">
                <Button size="sm" variant="ghost">
                  Details
                </Button>
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTableFrame>
    </Skeleton>
  );
}

/** The cloud account connection a catalog server binds to. */
export function McpAccountBindingSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading account connections"
      testId="mcp-account-binding-loading"
    >
      <p className="fg-secondary">Account connection: GitHub</p>
    </Skeleton>
  );
}
