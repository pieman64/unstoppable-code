import { useEffect, useState, type JSX } from 'react';
import type {
  DetectedMcpServerInfo,
  McpServerData,
} from '@canopy/desktop-shared/types/mcp-servers';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { DialogModal } from '@/components/shared/DialogModal';
import {
  PluginSection,
  StandaloneConfigsSection,
} from '@canopy/ui-shared/components';
import { mcpAuthStatusBadgeClass } from './mcp-card-helpers';

interface McpServerDetailsModalProps {
  server: DetectedMcpServerInfo;
  refreshKey?: number;
  onClose: () => void;
  onEdit: (serverId: string) => void;
}

interface PluginContext {
  marketplace: MarketplaceInfo | null;
  plugin: PluginInfo | null;
}

interface SourceInfo {
  label: string;
  context: string;
}

function describeSource(server: DetectedMcpServerInfo): SourceInfo {
  switch (server.source) {
    case 'standalone':
      return {
        label: 'Standalone MCP server',
        context: server.configName ?? '',
      };
    case 'collection':
      return {
        label: 'Collection',
        context: server.collectionId ?? server.bundleId ?? '',
      };
    case 'bundle':
      return { label: 'Collection', context: server.bundleId ?? '' };
    case 'plugin':
      return { label: 'Plugin', context: server.pluginName ?? '' };
  }
}

export function McpServerDetailsModal({
  server,
  refreshKey = 0,
  onClose,
  onEdit,
}: McpServerDetailsModalProps): JSX.Element {
  const [serverData, setServerData] = useState<McpServerData | null>(null);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const [pluginContext, setPluginContext] = useState<PluginContext | null>(
    null,
  );
  const [pluginLoading, setPluginLoading] = useState(false);
  const [pluginError, setPluginError] = useState<string | null>(null);

  const standaloneServerId =
    server.source === 'standalone' ? server.serverId : undefined;
  const pluginMarketplaceId =
    server.source === 'plugin' ? server.marketplaceId : undefined;
  const pluginName = server.source === 'plugin' ? server.pluginName : undefined;

  useEffect(() => {
    if (standaloneServerId === undefined) {
      setServerData(null);
      setServerLoading(false);
      setServerError(null);
      return;
    }

    let cancelled = false;
    setServerLoading(true);
    setServerError(null);

    void (async (): Promise<void> => {
      try {
        const result = await window.mcpServers.loadServer(standaloneServerId);
        if (cancelled) return;
        setServerData(result.server);
      } catch (err) {
        if (cancelled) return;
        setServerError(String((err as Error)?.message || err));
      } finally {
        if (!cancelled) setServerLoading(false);
      }
    })();

    return (): void => {
      cancelled = true;
    };
  }, [standaloneServerId, refreshKey]);

  useEffect(() => {
    if (pluginMarketplaceId === undefined || pluginName === undefined) {
      setPluginContext(null);
      setPluginLoading(false);
      setPluginError(null);
      return;
    }

    let cancelled = false;
    setPluginLoading(true);
    setPluginError(null);

    void (async (): Promise<void> => {
      try {
        const result = await window.plugins.loadMarketplaces();
        if (cancelled) return;
        if (!result.success || !result.data) {
          setPluginError(result.error ?? 'Failed to load marketplace details');
          return;
        }
        const marketplace =
          result.data.marketplaces.find((m) => m.id === pluginMarketplaceId) ??
          null;
        const plugin =
          marketplace?.plugins.find((p) => p.name === pluginName) ?? null;
        setPluginContext({ marketplace, plugin });
      } catch (err) {
        if (cancelled) return;
        setPluginError(String((err as Error)?.message || err));
      } finally {
        if (!cancelled) setPluginLoading(false);
      }
    })();

    return (): void => {
      cancelled = true;
    };
  }, [pluginMarketplaceId, pluginName]);

  const sourceInfo = describeSource(server);
  const definition = serverData?.definition;
  const httpUrl = definition?.url ?? server.url;
  const commandLine =
    definition?.type === 'command' && definition.command
      ? `${definition.command}${
          definition.args && definition.args.length > 0
            ? ` ${definition.args.join(' ')}`
            : ''
        }`
      : null;

  const titleNode = (
    <span className="flex items-center gap-2">
      <span className="truncate">{server.displayName}</span>
      <span className="rounded bg-secondary px-1.5 py-0.5 text-3xs font-medium fg-secondary">
        {server.type === 'http' ? 'HTTP' : 'Command'}
      </span>
    </span>
  );

  const headerActions =
    standaloneServerId !== undefined ? (
      <button
        type="button"
        onClick={(): void => onEdit(standaloneServerId)}
        data-testid="mcp-server-details-edit"
        className="focus-ring rounded-md bg-accent px-2.5 py-1 text-xs font-medium fg-emphasis transition hover:bg-accent/90"
      >
        Edit
      </button>
    ) : undefined;

  return (
    <DialogModal
      onClose={onClose}
      title={titleNode}
      titleId="mcp-server-details-modal-title"
      subtitle={
        sourceInfo.context
          ? `${sourceInfo.label} · ${sourceInfo.context}`
          : sourceInfo.label
      }
      maxWidth="2xl"
      headerActions={headerActions}
      dataTestId="mcp-server-details-modal"
      closeOnBackdrop
    >
      <div className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-5">
        {server.description && (
          <p className="text-s fg-secondary">{server.description}</p>
        )}

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="fg-secondary">Auth status:</span>
          <span
            className={`rounded-full px-1.5 py-0.5 text-3xs font-medium ${mcpAuthStatusBadgeClass(server.authStatus, server.canRefresh)}`}
            data-testid="mcp-server-details-auth-badge"
          >
            {server.authStatusLabel}
          </span>
          {server.lastError && server.authStatus === 'error' && (
            <span className="fg-destructive">{server.lastError}</span>
          )}
        </div>

        <div className="rounded-lg border bg-secondary/30 px-4 py-3">
          <dl className="space-y-1.5 text-s">
            <div className="flex gap-2">
              <dt className="whitespace-nowrap font-medium fg-primary">
                Source:
              </dt>
              <dd className="fg-secondary">
                {sourceInfo.context
                  ? `${sourceInfo.label} (${sourceInfo.context})`
                  : sourceInfo.label}
              </dd>
            </div>
            {server.source === 'plugin' && server.pluginServerName && (
              <div className="flex gap-2">
                <dt className="whitespace-nowrap font-medium fg-primary">
                  Plugin server:
                </dt>
                <dd className="fg-secondary">{server.pluginServerName}</dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="whitespace-nowrap font-medium fg-primary">
                Type:
              </dt>
              <dd className="fg-secondary">
                {server.type === 'command' ? 'Command (stdio)' : 'HTTP'}
              </dd>
            </div>
            {server.type === 'http' && httpUrl && (
              <div className="flex gap-2">
                <dt className="whitespace-nowrap font-medium fg-primary">
                  URL:
                </dt>
                <dd className="break-all font-mono text-xs fg-secondary">
                  {httpUrl}
                </dd>
              </div>
            )}
            {commandLine && (
              <div className="flex gap-2">
                <dt className="whitespace-nowrap font-medium fg-primary">
                  Command:
                </dt>
                <dd
                  className={`${POSTHOG_REPLAY_BLOCK_CLASS} break-all font-mono text-xs fg-secondary`}
                >
                  {commandLine}
                </dd>
              </div>
            )}
            {server.type === 'http' && definition && (
              <div className="flex gap-2">
                <dt className="whitespace-nowrap font-medium fg-primary">
                  OAuth:
                </dt>
                <dd className="fg-secondary">
                  {definition.oauth ? 'configured' : 'not configured'}
                </dd>
              </div>
            )}
          </dl>
        </div>

        {server.source === 'plugin' && (
          <PluginSection
            server={server}
            loading={pluginLoading}
            error={pluginError}
            context={pluginContext}
          />
        )}

        {standaloneServerId !== undefined && (
          <StandaloneConfigsSection
            loading={serverLoading}
            error={serverError}
            serverData={serverData}
          />
        )}
      </div>
    </DialogModal>
  );
}
