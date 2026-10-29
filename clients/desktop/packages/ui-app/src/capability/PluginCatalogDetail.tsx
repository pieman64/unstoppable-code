import type { ComponentType, JSX } from 'react';
import type { PluginInfo } from '@canopy/protocol/plugins';
import type { PortalPluginCatalogMemberSummary } from '@canopy/protocol/portal';
import { McpServerLogo, type McpServerLogoProps } from '@canopy/ui-shared';
import { ExecutionActionButton } from '@canopy/ui-shared/components';

export interface PluginCatalogDetailModel {
  name: PluginInfo['name'];
  author?: PluginInfo['author'];
  description?: PluginInfo['description'];
  homepage?: PluginInfo['homepage'];
  logoUrl?: PluginInfo['logoUrl'];
  bundledLogo?: string;
  brandMark?: boolean;
  categories: readonly string[];
  components: Pick<
    PortalPluginCatalogMemberSummary,
    'skills' | 'mcpServers' | 'commands' | 'agents'
  >;
}

export interface PluginCatalogDetailProps {
  entry: PluginCatalogDetailModel;
  McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
}

/**
 * The summary's primary action. Hosts place it last in the page's
 * `DetailActionBar`, after Share, at the top right of the Back row.
 */
export function PluginCatalogAddButton({
  onAdd,
}: {
  onAdd: () => void;
}): JSX.Element {
  return (
    <ExecutionActionButton
      label="Add"
      ariaLabel="Add"
      variant="primary"
      placement="detail"
      onClick={onAdd}
      dataTestId="plugin-catalog-detail-add"
      // The detail closes on a document-level Escape; a focused Add must let
      // that key through.
      stopKeyDownPropagation={false}
    />
  );
}

/** Pure marketplace plugin summary body; its actions are host chrome. */
export function PluginCatalogDetail({
  entry,
  McpServerLogoComponent = McpServerLogo,
}: PluginCatalogDetailProps): JSX.Element {
  const componentCount = Object.values(entry.components).reduce(
    (total, count) => total + count,
    0,
  );

  return (
    // Not a scroller of its own: the page root and the dialog body already
    // scroll, and a nested scroll box here clipped the hairline ring and
    // shadow of the header controls sitting flush against its top edge.
    <div
      className="flex min-h-0 flex-1 flex-col gap-4"
      data-testid="plugin-catalog-detail"
    >
      <div className="flex items-start gap-3">
        <McpServerLogoComponent
          logoUrl={entry.logoUrl}
          bundledLogo={entry.bundledLogo}
          brandMark={entry.brandMark}
          size={40}
          fallback="monogram"
          name={entry.name}
          shape="circle"
          fit="contain"
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold fg-primary">{entry.name}</h3>
          {entry.author && (
            <p className="mt-0.5 text-xs fg-secondary">By {entry.author}</p>
          )}
        </div>
      </div>

      {entry.description && (
        <p className="text-sm fg-secondary">{entry.description}</p>
      )}
      {entry.homepage && (
        <a
          href={entry.homepage}
          target="_blank"
          rel="noreferrer"
          className="focus-ring w-fit rounded text-xs font-medium fg-accent hover:underline"
        >
          Website
        </a>
      )}
      {entry.categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {entry.categories.map((category) => (
            <span
              key={category}
              className="rounded-full bg-secondary px-2 py-0.5 text-3xs font-medium fg-secondary"
            >
              {category}
            </span>
          ))}
        </div>
      )}
      <div className="border-t pt-4">
        <h4 className="text-sm font-medium fg-primary">Included</h4>
        <p className="mt-1 text-xs fg-secondary">
          {componentCount > 0
            ? `${componentCount} plugin component${componentCount === 1 ? '' : 's'} available after adding.`
            : 'Plugin capabilities become available after adding.'}
        </p>
      </div>
    </div>
  );
}
