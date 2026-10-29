import { useEffect, useRef, type JSX } from 'react';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import { buildProviderConnectorRows } from '@canopy/ui-app/capability';
import { DialogModal } from '@/components/shared';
import { McpServerDialog } from '@/components/pages/McpServersTab';
import { ProviderConnectorDetail } from '@/components/plugins/ProviderConnectorDetail';
import { useProviderConnectors } from '@/hooks/useProviderConnectors';

/** The same account/configuration surfaces as the marketplace, without a detail-page detour. */
export function OnboardingToolSetup({
  entry,
  onClose,
  onConfigured,
}: {
  entry: CuratedMcpServerEntry;
  onClose: () => void;
  onConfigured: () => Promise<void>;
}): JSX.Element {
  const { results, loading, refresh } = useProviderConnectors({
    enabled: Boolean(entry.providerConnector),
  });
  const completed = useRef(false);
  useEffect(() => {
    if (!entry.providerConnector || !results || completed.current) return;
    const row = buildProviderConnectorRows(results, [entry]).find(
      (candidate) => candidate.curatedKey === entry.key,
    );
    if (
      !row?.providers.some(
        (provider) => provider.connected || provider.alternateRoute,
      )
    )
      return;
    completed.current = true;
    void onConfigured();
  }, [entry, results, onConfigured]);
  if (entry.providerConnector) {
    return (
      <DialogModal title={`Connect ${entry.name}`} onClose={onClose}>
        <ProviderConnectorDetail
          displayName={entry.name}
          results={results ?? []}
          curatedMcpServers={[entry]}
          loading={loading}
          onConnected={refresh}
        />
      </DialogModal>
    );
  }
  return (
    <McpServerDialog
      serverId={null}
      initialCurated={entry}
      curatedEntries={[entry]}
      onClose={onClose}
      onSaved={onConfigured}
    />
  );
}
