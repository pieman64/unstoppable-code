import type { JSX, ReactNode } from 'react';
import type {
  PortalMcpConnectionMetadata,
  PortalPluginCatalogMemberInventory,
} from '@canopy/protocol/portal';
import { Heading } from './Heading';

export interface PluginMemberDetailsProps {
  inventory: PortalPluginCatalogMemberInventory;
  hooksStripped?: boolean;
  mcpUnavailable?: boolean;
  connectionState?: PortalMcpConnectionMetadata['connectionState'];
  toolsEditor?: ReactNode;
}

interface MemberRow {
  key: string;
  name: string;
  description?: string;
}

function MemberSection({
  title,
  rows,
  status,
}: {
  title: string;
  rows: MemberRow[];
  status?: ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <div className="flex flex-wrap items-center gap-2">
        <Heading level={3} variant="label">
          {title}
        </Heading>
        <span className="rounded bg-fg-primary/10 px-1.5 py-0.5 text-3xs fg-secondary">
          {rows.length}
        </span>
        {status}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border px-3 py-2 text-xs fg-secondary">
          No members
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {rows.map((row) => (
            <li key={row.key} className="px-3 py-2">
              <p className="text-s font-medium fg-primary">{row.name}</p>
              {row.description && (
                <p className="text-xs fg-secondary">{row.description}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InertStatus({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="rounded bg-warning-subtle px-1.5 py-0.5 text-3xs fg-warning">
      {children}
    </span>
  );
}

/** Pure member-inventory display shared by cloud now and desktop later. */
export function PluginMemberDetails({
  inventory,
  hooksStripped = true,
  mcpUnavailable = true,
  connectionState,
  toolsEditor,
}: PluginMemberDetailsProps): JSX.Element {
  return (
    <div className="flex flex-col gap-5" data-testid="plugin-member-details">
      <MemberSection
        title="Skills"
        rows={inventory.skills.map((member) => ({
          key: member.path,
          name: member.name,
          description: member.description,
        }))}
      />
      <MemberSection
        title="Agents"
        rows={inventory.agents.map((member) => ({
          key: member.filePath,
          name: member.name,
          description: member.description,
        }))}
      />
      <MemberSection
        title="Commands"
        rows={inventory.commands.map((member) => ({
          key: member.filePath,
          name: member.name,
          description: member.description,
        }))}
      />
      <MemberSection
        title="Apps"
        rows={(inventory.apps ?? []).map((member) => ({
          key: member.filePath,
          name: member.name,
          description: member.description,
        }))}
      />
      <MemberSection
        title="Hooks"
        rows={inventory.hooks.map((member, index) => ({
          key: `${member.event}-${String(index)}`,
          name: member.event,
          description: member.matcher ?? member.command,
        }))}
        status={
          hooksStripped ? (
            <InertStatus>Stripped in cloud sessions</InertStatus>
          ) : undefined
        }
      />
      <MemberSection
        title="MCP servers"
        rows={inventory.mcpServers.map((member) => ({
          key: member.name,
          name: member.name,
          description: member.type === 'http' ? 'HTTP' : 'Command',
        }))}
        status={
          connectionState ? (
            <span className="text-xs fg-secondary">
              {
                {
                  connected: 'Connected',
                  reauth_required: 'Reconnect required',
                  not_connected: 'Not connected',
                  desktop_only: 'Available on desktop only',
                }[connectionState]
              }
            </span>
          ) : mcpUnavailable ? (
            <InertStatus>Not yet available in cloud sessions</InertStatus>
          ) : undefined
        }
      />
      {connectionState === 'connected' && toolsEditor}
      <MemberSection
        title="LSP servers"
        rows={inventory.lspServers.map((member) => ({
          key: member.name,
          name: member.name,
          description:
            member.languages && member.languages.length > 0
              ? member.languages.join(', ')
              : member.command,
        }))}
      />
    </div>
  );
}
