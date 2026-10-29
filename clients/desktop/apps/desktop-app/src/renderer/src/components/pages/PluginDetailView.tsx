import { pluginDisplayName, Notice } from '@canopy/ui-shared';
import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  PluginDetailHost,
  type PluginDetailHostPlugin,
  type PluginDetailInstallRequest,
  type PluginDetailInstallResult,
} from '@canopy/ui-app/capability';
import type {
  PluginDetailComponentContent,
  PluginDetailComponentType,
  PluginDetailFacetSlot,
} from '@canopy/ui-shared/components';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import { cursorPluginFacetSupport } from '@canopy/desktop-shared/lib/cursor-capabilities';
import { brandText } from '@/lib/brand';
import {
  applyCodexCompatDisabledToMarketplaceCaches,
  marketplaceSourceOperations,
} from '@/hooks/useMarketplaceList';
import { useShareAccess } from '@/hooks/useShareAccess';
import { computePluginShareableRef } from '@/hooks/useUnifiedTableData';
import { SharePluginModal } from '@/components/plugins/SharePluginModal';
import { pluginNeedsInstall } from '../../lib/pluginInstallStatus';
import type { MarketplaceShareAction } from '@canopy/ui-shared/lib';
import { formatDate } from '../../lib/format';
import { PluginHarnessStatus } from '../plugins/PluginHarnessStatus';
import { pluginHarnessSupport } from '../../lib/tryItRuntime';

function resultError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

interface InstalledPluginHarnessesProps {
  plugin: PluginInfo;
}

/**
 * Where an installed plugin runs inside the app. Its MCP servers sign in from
 * a chat's MCP Servers panel once a chat uses the plugin, not from here.
 */
function InstalledPluginHarnesses({
  plugin,
}: InstalledPluginHarnessesProps): JSX.Element {
  // The Cursor row follows the resolver's rule, not a local reading of it:
  // the facet a Cursor session reads (Claude first, else native Codex) and
  // whether that facet carries an MCP server, skill, or command it loads.
  const cursor = cursorPluginFacetSupport(plugin.facets);
  return (
    <PluginHarnessStatus
      installed
      providerInstallation={
        plugin.globalInstallStatus
          ? {
              claude: plugin.globalInstallStatus.claude?.installed ?? false,
              codex: plugin.globalInstallStatus.codex?.installed ?? false,
              cursor:
                plugin.globalInstallStatus[cursor.provider]?.installed ?? false,
            }
          : undefined
      }
      support={pluginHarnessSupport(plugin)}
    />
  );
}

/** Desktop IPC adapter for the browser-safe shared full-plugin composition. */
export function PluginDetailView({
  plugin,
  marketplace,
  onBack,
  onPluginUpdated,
  relatedContent,
  headerActions,
  headerIcon,
  autoInstall = false,
  shareAction,
  renderPrimaryAction,
}: {
  plugin: PluginInfo;
  marketplace: MarketplaceInfo;
  /** Omitted on a page, whose breadcrumb is the way back (CAN-4261). */
  onBack?: () => void;
  onPluginUpdated: (updated: PluginInfo) => void;
  relatedContent?: ReactNode;
  headerActions?: ReactNode;
  headerIcon?: ReactNode;
  /** Install right away, for the Marketplace's Add. Nothing signs in here. */
  autoInstall?: boolean;
  /**
   * The Marketplace's resolved Share (CAN-3704), whose flow the page owns.
   * Omitted elsewhere, where the detail shares a plugin with a public source.
   */
  shareAction?: MarketplaceShareAction;
  /** The shared Try it CTA, shown while the detail has no Install action. */
  renderPrimaryAction?: (action: {
    onInstall: () => void;
    busy: boolean;
  }) => ReactNode;
}): JSX.Element {
  const [shareOpen, setShareOpen] = useState(false);
  const [compatibilityError, setCompatibilityError] = useState('');
  const { requestShare, shareGateModal } = useShareAccess();
  const shareableRef = useMemo(
    () => computePluginShareableRef(plugin, marketplace),
    [marketplace, plugin],
  );
  const needsInstall = pluginNeedsInstall(plugin);
  const autoInstallStarted = useRef(false);
  const onPluginUpdatedRef = useRef(onPluginUpdated);
  onPluginUpdatedRef.current = onPluginUpdated;
  const [autoInstalling, setAutoInstalling] = useState(false);
  const [autoInstallError, setAutoInstallError] = useState('');
  const sourceUrl =
    typeof plugin.externalSource === 'string'
      ? plugin.externalSource
      : (plugin.externalSource?.url ?? '');
  useEffect(() => {
    if (!autoInstall || !needsInstall || autoInstallStarted.current) return;
    const release = marketplaceSourceOperations.acquire(
      marketplace.id,
      'install',
    );
    if (!release) return;
    autoInstallStarted.current = true;
    let cancelled = false;
    setAutoInstalling(true);
    void window.plugins
      .installPlugin(marketplace.id, plugin.name, sourceUrl)
      .then((result) => {
        // Leaving details does not cancel installation. Keep the marketplace
        // cache in sync even after this view has unmounted.
        if (result.success && result.data)
          onPluginUpdatedRef.current(result.data);
        else if (!cancelled)
          setAutoInstallError(result.error ?? 'Unable to install. Try again.');
      })
      .catch((cause) => {
        if (!cancelled) setAutoInstallError(resultError(cause).message);
      })
      .finally(() => {
        release();
        if (!cancelled) setAutoInstalling(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [autoInstall, needsInstall, marketplace.id, plugin.name, sourceUrl]);

  useEffect(() => {
    setCompatibilityError('');
    if (
      needsInstall ||
      plugin.providerSupport.codex !== 'compat' ||
      plugin.codexCompatDisabled === true ||
      plugin.facets.codex ||
      plugin.facets.codexCompatibility
    )
      return;
    let cancelled = false;
    void window.plugins
      .prepareCodexCompatibilityPlugin(plugin.marketplaceId, plugin.name)
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.data) {
          onPluginUpdated(result.data);
        } else {
          setCompatibilityError(
            result.error ?? 'Failed to prepare Codex compatibility details.',
          );
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setCompatibilityError(resultError(error).message);
      });
    return (): void => {
      cancelled = true;
    };
  }, [needsInstall, onPluginUpdated, plugin]);

  const readComponent = useCallback(
    async (
      _componentType: PluginDetailComponentType,
      componentFile: string,
      activeFacet: PluginDetailFacetSlot | undefined,
    ): Promise<PluginDetailComponentContent | null> => {
      const facet = activeFacet?.facet;
      const facetInstallRoot = facet?.cachePath ?? facet?.installLocation;
      const effectiveInstallLocation =
        facetInstallRoot ?? plugin.cachePath ?? marketplace.installLocation;
      const effectiveSourcePath = facetInstallRoot
        ? ''
        : (facet?.sourcePath ?? (plugin.cachePath ? '' : plugin.sourcePath));
      const result = await window.plugins.readComponentContent(
        effectiveInstallLocation,
        effectiveSourcePath,
        componentFile,
      );
      if (result.success && result.data) return result.data;
      if (result.error) throw new Error(result.error);
      return null;
    },
    [marketplace.installLocation, plugin.cachePath, plugin.sourcePath],
  );

  const install = async (
    request: PluginDetailInstallRequest,
  ): Promise<PluginDetailInstallResult> => {
    const release = marketplaceSourceOperations.acquire(
      marketplace.id,
      'install',
    );
    if (!release)
      throw new Error(
        'This marketplace is busy. Try again when the current operation finishes.',
      );
    try {
      setAutoInstallError('');
      if (request.kind === 'providers') {
        const result = await window.plugins.installBuiltInPlugin({
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.name,
          providers: request.providers,
        });
        if (!result.success || !result.data)
          throw new Error(result.error ?? 'Unknown error.');
        onPluginUpdated(result.data.plugin);
        return result.data;
      }
      if (!plugin.externalSource)
        throw new Error('Plugin has no external source.');
      const sourceUrl =
        typeof plugin.externalSource === 'string'
          ? plugin.externalSource
          : (plugin.externalSource.url ?? '');
      const result = await window.plugins.installPlugin(
        marketplace.id,
        plugin.name,
        sourceUrl,
      );
      if (!result.success || !result.data)
        throw new Error(result.error ?? 'Failed to install plugin.');
      onPluginUpdated(result.data);
      return { plugin: result.data };
    } finally {
      release();
    }
  };

  const toggleCodexCompat = async (
    disabled: boolean,
  ): Promise<PluginDetailHostPlugin> => {
    try {
      const result = await window.plugins.setCodexCompatDisabled(
        plugin.marketplaceId,
        plugin.name,
        disabled,
      );
      if (!result.success || !result.data)
        throw new Error(
          result.error ?? 'Failed to update Codex compatibility setting.',
        );
      applyCodexCompatDisabledToMarketplaceCaches(
        plugin.marketplaceId,
        plugin.name,
        disabled,
      );
      onPluginUpdated(result.data);
      return result.data;
    } catch (error) {
      throw resultError(error);
    }
  };

  // A Marketplace host resolves Share itself, so the card, detail and click
  // agree. Other hosts keep the local rule: Share only with a public source.
  const resolvedShareAction: MarketplaceShareAction | undefined =
    shareAction ??
    (shareableRef
      ? {
          status: 'shareable',
          onShare: (): void => {
            requestShare(
              {
                title: 'Sign in to share plugins',
                description:
                  'Connect your account to create a public plugin link.',
              },
              () => setShareOpen(true),
            );
          },
        }
      : undefined);

  return (
    <>
      <PluginDetailHost
        plugin={plugin}
        onBack={onBack}
        loadDetail={(): Promise<PluginInfo> => Promise.resolve(plugin)}
        readComponent={readComponent}
        onInstall={install}
        shareAction={resolvedShareAction}
        onToggleCodexCompat={toggleCodexCompat}
        relatedContent={relatedContent}
        headerActions={headerActions}
        renderPrimaryAction={renderPrimaryAction}
        headerIcon={headerIcon}
        connectionContent={
          !needsInstall ? (
            <InstalledPluginHarnesses plugin={plugin} />
          ) : undefined
        }
        needsInstall={needsInstall}
        loading={autoInstalling}
        brandName={brandText.appName}
        compatibilityError={compatibilityError}
        formatDate={formatDate}
      />
      {autoInstallError && (
        <Notice intent="destructive">{autoInstallError}</Notice>
      )}
      {shareOpen && shareableRef && (
        <SharePluginModal
          pluginRef={shareableRef}
          name={pluginDisplayName(plugin)}
          description={plugin.description}
          onClose={() => setShareOpen(false)}
        />
      )}
      {shareGateModal}
    </>
  );
}
