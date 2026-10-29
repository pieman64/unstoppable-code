import { pluginDisplayName } from '../lib/plugin-display-name';
import { pluginDisplayAuthor } from '../lib/official-marketplace-products';
import { type JSX, type ReactNode, useEffect, useMemo, useState } from 'react';

import { ClickableName } from './ClickableName';
import { ComponentSection } from './ComponentSection';
import { ExternalTextLink } from './ExternalTextLink';
import { Markdown, type MarkdownProps } from './Markdown';
import { MarkdownFrontmatterContent } from './MarkdownFrontmatterContent';
import { PluginDetailSectionHeading } from './PluginDetailSectionHeading';
import { Tooltip } from './Tooltip';
import { McpServerLogo } from './McpServerLogo';
import { ChevronDownIcon, ChevronLeftMediumIcon } from '../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

import type {
  PluginDetails,
  PluginProviderFacet,
  PluginProviderSupport,
} from '@canopy/protocol/plugins';

// ---------------------------------------------------------------------------
// Shared presentational core of the plugin detail surface (PR 5 of
// docs/planning/2026-08-27-portal-plugins-section/design.md).
//
// Extracted from the desktop `PluginDetailView`: header metadata, provider
// facet tabs, README section, and the component tables. Class names, testids,
// and copy match the previous desktop inline implementation exactly so
// desktop tests/selectors and visual diffs are unchanged.
//
// Everything environment-specific is injected:
// - `onReadComponent` performs the actual content read (desktop: IPC against
//   the active facet's install root; web: `portal.plugins.read_component_content`).
// - `metadataFooter` / `installActions` are render slots for host-owned
//   mutation UI (desktop install panels + codex-compat switch); the web
//   detail page leaves them empty in the read-only phase A.
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Provider facet kind vocabulary shared with the desktop cache shapes. */
export type PluginDetailFacetKind = 'claude' | 'codex' | 'codexCompatibility';

/** One renderable facet slot: its kind plus the facet payload. */
export interface PluginDetailFacetSlot {
  kind: PluginDetailFacetKind;
  facet: PluginProviderFacet;
}

/** Which kind of component content a read request targets. */
export type PluginDetailComponentType =
  | 'readme'
  | 'skill'
  | 'agent'
  | 'command'
  | 'app';

/**
 * Content returned by `onReadComponent`. `truncated` is set by transports
 * that cap payload sizes (the portal commands); the desktop IPC never sets it.
 */
export interface PluginDetailComponentContent {
  frontmatter: Record<string, unknown>;
  body: string;
  truncated?: boolean;
}

/**
 * Injected content reader. `activeFacet` is the facet the user is currently
 * viewing (undefined when the plugin has none), so hosts that resolve reads
 * against per-facet roots (desktop) can derive the exact paths per call.
 *
 * Contract: resolve with the content, resolve `null` for a generic failure
 * (the section shows its stock error copy), or throw an `Error` whose message
 * is shown verbatim.
 */
export type PluginDetailReadComponent = (
  componentType: PluginDetailComponentType,
  componentFile: string,
  activeFacet: PluginDetailFacetSlot | undefined,
) => Promise<PluginDetailComponentContent | null>;

/**
 * Structural plugin shape the detail content renders. `PluginInfo` (desktop
 * cache row) is assignable as-is; the web detail page assembles one from the
 * portal `get_plugin_detail` result (no facets, merged top-level fields).
 */
export interface PluginDetailContentPlugin {
  name: string;
  /** Human-readable label; `name` remains the stable provider/install key. */
  displayName?: string;
  description?: string;
  version?: string;
  author?: string;
  category?: string;
  homepage?: string;
  marketplaceId: string;
  details?: PluginDetails | null;
  providerSupport: PluginProviderSupport;
  facets?: {
    claude?: PluginProviderFacet;
    codex?: PluginProviderFacet;
    codexCompatibility?: PluginProviderFacet;
  };
  codexCompatDisabled?: boolean;
  /** Local cache directory, when installed (desktop rows only). */
  cachePath?: string;
  /** Marketplace-relative source path (desktop rows only). */
  sourcePath?: string;
}

export interface PluginDetailContentProps {
  plugin: PluginDetailContentPlugin;
  /**
   * Back to where the host opened the detail. Omit where that would only
   * repeat the breadcrumb's parent; Back then shows only to close an open
   * component view.
   */
  onBack?: () => void;
  onReadComponent: PluginDetailReadComponent;
  /**
   * Preloaded README body (web: `get_plugin_detail` ships it). When absent
   * the README section lazy-loads on expand via `onReadComponent`.
   */
  readme?: { body: string; truncated?: boolean };
  markdownOptions?: MarkdownProps['options'];
  /**
   * Host-owned block rendered inside the metadata section, after the
   * homepage link (desktop: compat error + codex-compat mode switch).
   */
  metadataFooter?: ReactNode;
  /**
   * Host-owned block rendered between the metadata section and the README
   * (desktop: built-in install panel, external source box, install prompt,
   * installing spinner). Empty on the read-only web page.
   */
  installActions?: ReactNode;
  /** Hide the component tables (desktop: while uninstalled/installing). */
  hideComponents?: boolean;
  /** Optional related-item sections appended after the components tables. */
  relatedContent?: ReactNode;
  /** Optional host-owned actions placed in the detail header. */
  headerActions?: ReactNode;
  /** Host-resolved marketplace identity mark; falls back to the shared avatar. */
  headerIcon?: ReactNode;
  titleAs?: 'h1' | 'h2';
  /** Authoritative listing author; null explicitly omits unavailable metadata. */
  authorDisplay?: string | null;
}

// ---------------------------------------------------------------------------
// Component content view (lazy per-component read)
// ---------------------------------------------------------------------------

function TruncatedNotice(): JSX.Element {
  return (
    <p
      className="mt-3 text-xs fg-secondary"
      data-testid="plugin-detail-truncated-notice"
      role="note"
    >
      Content was truncated.
    </p>
  );
}

function ComponentContentView({
  markdownOptions,
  titleAs = 'h2',
  name,
  componentType,
  componentFile,
  activeFacet,
  readKey,
  onReadComponent,
}: {
  markdownOptions?: MarkdownProps['options'];
  titleAs?: 'h1' | 'h2';
  name: string;
  componentType: PluginDetailComponentType;
  componentFile: string;
  activeFacet: PluginDetailFacetSlot | undefined;
  /**
   * Stable token for the resolved content roots (facet kind + paths). The
   * fetch keys on this VALUE rather than on `activeFacet`'s object identity
   * so a parent re-render with an equivalent facet does not refetch —
   * matching the previous desktop path-based effect dependencies.
   */
  readKey: string;
  onReadComponent: PluginDetailReadComponent;
}): JSX.Element {
  const Title = titleAs;
  const [content, setContent] = useState<PluginDetailComponentContent | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setContent(null);

    void (async (): Promise<void> => {
      try {
        const result = await onReadComponent(
          componentType,
          componentFile,
          activeFacet,
        );
        if (cancelled) return;
        if (result) {
          setContent(result);
        } else {
          setError('Failed to load component content.');
        }
      } catch (err) {
        if (cancelled) return;
        setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return (): void => {
      cancelled = true;
    };
    // `activeFacet` is deliberately keyed by value via `readKey` (see prop
    // doc); the latest facet object is still read at call time.
  }, [componentType, componentFile, readKey, onReadComponent]);

  // The component file is file content, so session replay keeps a
  // placeholder for it. MarkdownFrontmatterContent renders a fragment, so an
  // unstyled block-level wrapper carries the block; the name heading and the
  // Back chrome stay recorded.
  return (
    <div className="min-w-0">
      <Title
        id="plugin-detail-title"
        className="text-lg font-semibold fg-primary mb-4"
      >
        {name}
      </Title>

      <div className={REPLAY_BLOCK_CLASS}>
        <MarkdownFrontmatterContent
          markdownOptions={markdownOptions}
          loading={loading}
          error={error}
          content={content}
          emptyText="This component has no content."
        />
        {content?.truncated === true && <TruncatedNotice />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// README section
// ---------------------------------------------------------------------------

function ReadmeSection({
  markdownOptions,
  activeFacet,
  onReadComponent,
  preloaded,
  defaultExpanded = false,
}: {
  markdownOptions?: MarkdownProps['options'];
  activeFacet: PluginDetailFacetSlot | undefined;
  onReadComponent: PluginDetailReadComponent;
  /** Already-fetched README body; skips the lazy read entirely. */
  preloaded?: { body: string; truncated?: boolean };
  defaultExpanded?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [content, setContent] = useState<string | null>(
    preloaded ? preloaded.body : null,
  );
  const [truncated, setTruncated] = useState(preloaded?.truncated === true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadContent = async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await onReadComponent('readme', 'README.md', activeFacet);
      if (result) {
        setContent(result.body);
        setTruncated(result.truncated === true);
      } else {
        setError('Failed to load README.');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (defaultExpanded && !preloaded) {
      void loadContent();
    }
    // The section is remounted (keyed) when the facet or plugin roots change,
    // so this runs once per content identity.
  }, []);

  const handleToggle = async (): Promise<void> => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (content !== null) return;
    await loadContent();
  };

  return (
    <section className="min-w-0 rounded-lg ring-[length:var(--border-hairline)] ring-line-base bg-secondary/30">
      <button
        type="button"
        onClick={() => void handleToggle()}
        aria-expanded={expanded}
        className="focus-ring flex w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left"
      >
        <PluginDetailSectionHeading as="span">
          README
        </PluginDetailSectionHeading>
        <ChevronDownIcon
          size={14}
          className={`shrink-0 fg-secondary ${expanded ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div className="border-t px-4 py-3">
          {loading && (
            <p className="text-s fg-secondary">Loading README&hellip;</p>
          )}
          {error && <p className="text-s fg-destructive">{error}</p>}
          {content !== null && !loading && (
            <div
              className={`${REPLAY_BLOCK_CLASS} prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none text-s fg-primary prose-code:before:content-none prose-code:after:content-none [&_a]:fg-accent [&_a:hover]:underline [&_code]:bg-secondary [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-secondary [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:overflow-x-auto [&_h1]:text-m [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-s [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h3]:text-s [&_h3]:font-medium [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:fg-secondary [&_img]:max-w-full [&_img]:rounded [&_table]:w-full [&_th]:text-left [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1`}
            >
              <Markdown options={markdownOptions}>{content}</Markdown>
            </div>
          )}
          {content !== null && !loading && truncated && <TruncatedNotice />}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Facet toggle helpers
// ---------------------------------------------------------------------------

type FacetTab = 'claude' | 'codex';

const CODEX_COMPATIBILITY_TOOLTIP =
  "Show the Codex details generated from this plugin's Claude version";
const CODEX_COMPATIBILITY_DISABLED_TOOLTIP =
  'Codex compatibility is turned off for this plugin';
// Informational copy for the non-interactive metadata badge; the actionable
// Codex tab uses the imperative CODEX_COMPATIBILITY_TOOLTIP instead.
const CODEX_COMPATIBILITY_BADGE_TOOLTIP =
  "Generated from this plugin's Claude version for Codex compatibility";

function collectFacets(
  plugin: PluginDetailContentPlugin,
): PluginDetailFacetSlot[] {
  const slots: PluginDetailFacetSlot[] = [];
  if (plugin.facets?.claude) {
    slots.push({ kind: 'claude', facet: plugin.facets.claude });
  }
  if (plugin.facets?.codex) {
    slots.push({ kind: 'codex', facet: plugin.facets.codex });
  } else if (plugin.facets?.codexCompatibility) {
    slots.push({
      kind: 'codexCompatibility',
      facet: plugin.facets.codexCompatibility,
    });
  }
  return slots;
}

function slotForTab(
  slots: PluginDetailFacetSlot[],
  tab: FacetTab,
): PluginDetailFacetSlot | undefined {
  if (tab === 'claude') return slots.find((s) => s.kind === 'claude');
  return slots.find(
    (s) => s.kind === 'codex' || s.kind === 'codexCompatibility',
  );
}

/** Keep publisher instructions available without letting them overwhelm the list. */
function ComponentDescription({
  name,
  description,
}: {
  name: string;
  description?: string;
}): JSX.Element {
  if (!description) return <span>—</span>;
  return (
    <details className="group/description min-w-0">
      <summary
        aria-label={`Description for ${name}`}
        className="focus-ring flex min-w-0 cursor-pointer list-none items-center gap-2 rounded [&::-webkit-details-marker]:hidden"
      >
        <span className="min-w-0 flex-1 truncate group-open/description:hidden">
          {description}
        </span>
        <span className="hidden flex-1 group-open/description:inline">
          Description
        </span>
        <ChevronDownIcon
          size={14}
          className="shrink-0 group-open/description:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <p className="mt-2 whitespace-pre-wrap break-words">{description}</p>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

interface ComponentRef {
  name: string;
  componentType: PluginDetailComponentType;
  file: string;
}

export function PluginDetailContent({
  markdownOptions,
  plugin,
  onBack,
  onReadComponent,
  readme,
  metadataFooter,
  installActions,
  hideComponents = false,
  relatedContent,
  headerActions,
  headerIcon,
  titleAs = 'h2',
  authorDisplay,
}: PluginDetailContentProps): JSX.Element {
  const Title = titleAs;
  const [viewingComponent, setViewingComponent] = useState<ComponentRef | null>(
    null,
  );

  const slots = useMemo(() => collectFacets(plugin), [plugin]);

  // Choose the initial tab. Prefer the facet that matches the plugin's
  // top-level merged view (Claude when both are available).
  const defaultTab: FacetTab = slots[0]?.kind === 'claude' ? 'claude' : 'codex';
  const [activeTab, setActiveTab] = useState<FacetTab>(defaultTab);

  // Reset the active tab whenever the plugin identity changes (e.g. the user
  // re-opens a different plugin) so we don't keep a tab the new plugin lacks.
  useEffect(() => {
    setActiveTab(defaultTab);
    setViewingComponent(null);
  }, [plugin.marketplaceId, plugin.name]);

  const activeSlot =
    slotForTab(slots, activeTab) ?? slotForTab(slots, defaultTab) ?? slots[0];
  const isCompat = activeSlot?.kind === 'codexCompatibility';

  // The compat-disable control applies only to plugins that would otherwise
  // run under Codex via compatibility mode (Claude facet, no native Codex
  // facet).
  const compatCapable = plugin.providerSupport.codex === 'compat';
  const codexCompatDisabled = plugin.codexCompatDisabled === true;

  // Keep the provider toggle visible — with the Codex side greyed — even when
  // the compat facet was not generated because compat is disabled.
  const showToggle = slots.length > 1 || (compatCapable && codexCompatDisabled);

  // ---------------------------------------------------------------------
  // Pick fields from the active facet, falling back to the top-level plugin
  // ---------------------------------------------------------------------
  const facetForDisplay = activeSlot?.facet;
  // Prefer the first non-empty display name: top-level, then active facet.
  // The top-level label stays constant across providers. Only when both labels
  // are blank or absent do we humanize the facet name, then the plugin name.
  // Other metadata below remains facet-first.
  const displayName = pluginDisplayName({
    name: facetForDisplay?.name ?? plugin.name,
    displayName: plugin.displayName?.trim() || facetForDisplay?.displayName,
  });
  const displayVersion = facetForDisplay?.version ?? plugin.version;
  const displayCategory = facetForDisplay?.category ?? plugin.category;
  // Product over publisher: an official listing OpenAI maintains for another
  // vendor is credited to that vendor, matching the mark beside it. Normalize
  // whichever author is shown, not just the top-level fallback: the feed puts
  // `author: 'OpenAI'` on the Codex facet too, and the facet is read first.
  const displayAuthor =
    authorDisplay !== undefined
      ? authorDisplay
      : pluginDisplayAuthor(plugin.marketplaceId, {
          name: plugin.name,
          author: facetForDisplay?.author ?? plugin.author,
        });
  const displayDescription = facetForDisplay?.description ?? plugin.description;
  const displayHomepage = facetForDisplay?.homepage ?? plugin.homepage;
  const displayDetails: PluginDetails | undefined =
    facetForDisplay?.details ?? plugin.details ?? undefined;

  const hasComponents =
    !!displayDetails &&
    (displayDetails.skills.length > 0 ||
      displayDetails.agents.length > 0 ||
      displayDetails.commands.length > 0 ||
      (displayDetails.apps?.length ?? 0) > 0 ||
      displayDetails.hooks.length > 0 ||
      displayDetails.mcpServers.length > 0 ||
      displayDetails.lspServers.length > 0);
  const showComponentsSection =
    !hideComponents &&
    !!displayDetails &&
    (hasComponents || !displayDetails.hasReadme);

  // Stable token for the roots content reads resolve against (facet kind +
  // facet/plugin paths). Keys the README section remount and the component
  // view's refetch, mirroring the previous desktop path-based dependencies.
  const contentRootsKey = [
    activeSlot?.kind ?? 'top',
    facetForDisplay?.cachePath ?? '',
    facetForDisplay?.installLocation ?? '',
    facetForDisplay?.sourcePath ?? '',
    plugin.cachePath ?? '',
    plugin.sourcePath ?? '',
  ].join('|');

  const hasClaudeSlot = slots.some((s) => s.kind === 'claude');
  const hasCodexSlot = slots.some(
    (s) => s.kind === 'codex' || s.kind === 'codexCompatibility',
  );
  const codexSlotIsCompat =
    !slots.some((s) => s.kind === 'codex') &&
    slots.some((s) => s.kind === 'codexCompatibility');
  const handleChromeBack = (): void => {
    if (viewingComponent) {
      setViewingComponent(null);
    } else {
      onBack?.();
    }
  };
  const showBack = viewingComponent !== null || onBack !== undefined;

  const chrome = (
    <div
      className="flex min-w-0 items-center justify-between gap-4"
      data-testid="plugin-detail-chrome"
    >
      {showBack ? (
        <button
          type="button"
          onClick={handleChromeBack}
          className="inline-flex shrink-0 items-center gap-1 text-s fg-secondary hover:fg-primary transition-colors"
          data-testid="plugin-detail-back"
        >
          <ChevronLeftMediumIcon size={14} aria-hidden="true" />
          Back
        </button>
      ) : (
        <span />
      )}

      {(headerActions || (!viewingComponent && showToggle)) && (
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {headerActions}

          {!viewingComponent && showToggle && (
            <div className="inline-flex shrink-0 items-center gap-1.5">
              <span
                className="text-xs fg-secondary"
                aria-hidden="true"
                data-testid="plugin-detail-provider-toggle-label"
              >
                Show:
              </span>
              <div
                className="inline-flex shrink-0 items-center rounded-md border bg-secondary p-0.5 text-xs"
                role="tablist"
                aria-label="Show plugin details for Claude or Codex"
                data-testid="plugin-detail-provider-toggle"
              >
                <Tooltip label="Show this plugin's Claude details">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'claude'}
                    onClick={() => setActiveTab('claude')}
                    disabled={!hasClaudeSlot}
                    className={`px-3 py-1.5 rounded transition-colors ${
                      activeTab === 'claude'
                        ? 'bg-base fg-primary'
                        : 'fg-secondary hover:fg-primary'
                    } disabled:opacity-50`}
                    data-testid="plugin-detail-toggle-claude"
                  >
                    Claude
                  </button>
                </Tooltip>
                <CodexToggleButton
                  active={activeTab === 'codex'}
                  isCompat={codexSlotIsCompat}
                  disabled={
                    !hasCodexSlot || (compatCapable && codexCompatDisabled)
                  }
                  disabledReason={
                    compatCapable && codexCompatDisabled
                      ? 'compat-off'
                      : undefined
                  }
                  onClick={() => setActiveTab('codex')}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  if (viewingComponent) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        {chrome}
        <ComponentContentView
          markdownOptions={markdownOptions}
          titleAs={titleAs}
          name={viewingComponent.name}
          componentType={viewingComponent.componentType}
          componentFile={viewingComponent.file}
          activeFacet={activeSlot}
          readKey={contentRootsKey}
          onReadComponent={onReadComponent}
        />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {chrome}

      {/* Plugin metadata */}
      <section className="min-w-0">
        <div className="flex items-center gap-3">
          {headerIcon ?? (
            <McpServerLogo
              name={displayName}
              size={40}
              fallback="monogram"
              fit="contain"
            />
          )}
          <div className="min-w-0 flex-1">
            <Title
              id="plugin-detail-title"
              className="break-words text-lg font-semibold fg-primary"
            >
              {displayName}
            </Title>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {displayVersion && (
                <span className="text-xs fg-secondary">v{displayVersion}</span>
              )}
              {displayCategory && (
                <span className="text-xs fg-secondary">{displayCategory}</span>
              )}
              {displayAuthor && (
                <span
                  data-testid="plugin-detail-author"
                  className="text-xs fg-secondary"
                >
                  by {displayAuthor}
                </span>
              )}
              {isCompat && (
                <Tooltip label={CODEX_COMPATIBILITY_BADGE_TOOLTIP}>
                  <span
                    className="rounded bg-warning-subtle px-1.5 py-0.5 text-3xs font-medium fg-warning"
                    data-testid="plugin-detail-codex-compat-badge"
                  >
                    Codex compatibility
                  </span>
                </Tooltip>
              )}
              {compatCapable && codexCompatDisabled && (
                <Tooltip label={CODEX_COMPATIBILITY_DISABLED_TOOLTIP}>
                  <span
                    className="rounded bg-muted px-1.5 py-0.5 text-3xs font-medium fg-secondary"
                    data-testid="plugin-detail-codex-compat-disabled-badge"
                  >
                    Codex disabled
                  </span>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
        {displayDescription && (
          <p className="max-w-2xl text-s fg-secondary mt-3">
            {displayDescription}
          </p>
        )}
        {/* Links sit apart from the metadata line, where "Website" read as
            part of the author ("by Microsoft Website"). */}
        {displayHomepage && (
          <div
            data-testid="plugin-detail-links"
            className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1"
          >
            <ExternalTextLink href={displayHomepage} label="Website" />
          </div>
        )}
        {metadataFooter}
      </section>

      {/* Host-owned install/action area (desktop install panels; empty on web) */}
      {installActions && (
        <div className="flex flex-col gap-6">{installActions}</div>
      )}

      {/* README */}
      {displayDetails?.hasReadme && (
        <ReadmeSection
          markdownOptions={markdownOptions}
          key={contentRootsKey}
          activeFacet={activeSlot}
          onReadComponent={onReadComponent}
          preloaded={readme}
          defaultExpanded={!hasComponents}
        />
      )}

      {/* Components */}
      {showComponentsSection && displayDetails && (
        <div className="flex flex-col gap-6">
          {hasComponents ? (
            <>
              {displayDetails.skills.length > 0 && (
                <ComponentSection title="Skills">
                  <table className="w-full table-fixed text-s">
                    <thead>
                      <tr className="bg-secondary/50 border-b">
                        <th className="w-1/3 text-left px-4 py-2 font-medium fg-secondary">
                          Name
                        </th>
                        <th className="text-left px-4 py-2 font-medium fg-secondary">
                          Description
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayDetails.skills
                        .slice()
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((s) => (
                          <tr key={s.path} className="border-b last:border-b-0">
                            <td className="px-4 py-2 break-words align-top">
                              <ClickableName
                                name={s.name}
                                onClick={() =>
                                  setViewingComponent({
                                    name: s.name,
                                    componentType: 'skill',
                                    file: `${s.path}/SKILL.md`,
                                  })
                                }
                              />
                            </td>
                            <td className="px-4 py-2 align-top fg-secondary">
                              <ComponentDescription
                                name={s.name}
                                description={s.description}
                              />
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </ComponentSection>
              )}

              {displayDetails.agents.length > 0 && (
                <ComponentSection title="Agents">
                  <table className="w-full table-fixed text-s">
                    <thead>
                      <tr className="bg-secondary/50 border-b">
                        <th className="w-1/3 text-left px-4 py-2 font-medium fg-secondary">
                          Name
                        </th>
                        <th className="text-left px-4 py-2 font-medium fg-secondary">
                          Description
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayDetails.agents
                        .slice()
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((a, i) => (
                          <tr
                            key={a.filePath || i}
                            className="border-b last:border-b-0"
                          >
                            <td className="px-4 py-2 break-words align-top">
                              {a.filePath ? (
                                <ClickableName
                                  name={a.name}
                                  onClick={() =>
                                    setViewingComponent({
                                      name: a.name,
                                      componentType: 'agent',
                                      file: a.filePath,
                                    })
                                  }
                                />
                              ) : (
                                <span className="fg-primary font-medium">
                                  {a.name}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2 align-top fg-secondary">
                              <ComponentDescription
                                name={a.name}
                                description={a.description}
                              />
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </ComponentSection>
              )}

              {displayDetails.commands.length > 0 && (
                <ComponentSection title="Commands">
                  <table className="w-full table-fixed text-s">
                    <thead>
                      <tr className="bg-secondary/50 border-b">
                        <th className="w-1/3 text-left px-4 py-2 font-medium fg-secondary">
                          Name
                        </th>
                        <th className="text-left px-4 py-2 font-medium fg-secondary">
                          Description
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayDetails.commands
                        .slice()
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((c, i) => (
                          <tr
                            key={c.filePath || i}
                            className="border-b last:border-b-0"
                          >
                            <td className="px-4 py-2 break-words align-top">
                              {c.filePath ? (
                                <ClickableName
                                  name={c.name}
                                  onClick={() =>
                                    setViewingComponent({
                                      name: c.name,
                                      componentType: 'command',
                                      file: c.filePath,
                                    })
                                  }
                                />
                              ) : (
                                <span className="fg-primary font-medium">
                                  {c.name}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2 align-top fg-secondary">
                              <ComponentDescription
                                name={c.name}
                                description={c.description}
                              />
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </ComponentSection>
              )}

              {(displayDetails.apps?.length ?? 0) > 0 && (
                <ComponentSection title="Apps">
                  <table className="w-full table-fixed text-s">
                    <thead>
                      <tr className="bg-secondary/50 border-b">
                        <th className="w-1/3 text-left px-4 py-2 font-medium fg-secondary">
                          Name
                        </th>
                        <th className="text-left px-4 py-2 font-medium fg-secondary">
                          Description
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(displayDetails.apps ?? [])
                        .slice()
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((a, i) => (
                          <tr
                            key={a.filePath || i}
                            className="border-b last:border-b-0"
                          >
                            <td className="px-4 py-2 break-words align-top">
                              {a.filePath ? (
                                <ClickableName
                                  name={a.name}
                                  onClick={() =>
                                    setViewingComponent({
                                      name: a.name,
                                      componentType: 'app',
                                      file: a.filePath,
                                    })
                                  }
                                />
                              ) : (
                                <span className="fg-primary font-medium">
                                  {a.name}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2 align-top fg-secondary">
                              <ComponentDescription
                                name={a.name}
                                description={a.description}
                              />
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </ComponentSection>
              )}

              {displayDetails.hooks.length > 0 && (
                <ComponentSection title="Hooks">
                  <table className="w-full text-s">
                    <thead>
                      <tr className="bg-secondary/50 border-b">
                        <th className="text-left px-4 py-2 font-medium fg-secondary">
                          Event
                        </th>
                        <th className="text-left px-4 py-2 font-medium fg-secondary">
                          Matcher
                        </th>
                        <th className="text-left px-4 py-2 font-medium fg-secondary">
                          Type
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayDetails.hooks
                        .slice()
                        .sort((a, b) => a.event.localeCompare(b.event))
                        .map((h, i) => (
                          <tr
                            key={`${h.event}-${i}`}
                            className="border-b last:border-b-0"
                          >
                            <td className="px-4 py-2 fg-primary font-medium whitespace-nowrap">
                              {h.event}
                            </td>
                            <td className="px-4 py-2 fg-secondary font-mono text-xs">
                              {h.matcher || '—'}
                            </td>
                            <td className="px-4 py-2 fg-secondary whitespace-nowrap">
                              {h.hookType}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </ComponentSection>
              )}

              {displayDetails.mcpServers.length > 0 && (
                <ComponentSection title="MCP servers" collapsible>
                  <table className="w-full text-s">
                    <thead>
                      <tr className="bg-secondary/50 border-b">
                        <th className="text-left px-4 py-2 font-medium fg-secondary">
                          Name
                        </th>
                        <th className="text-left px-4 py-2 font-medium fg-secondary">
                          Type
                        </th>
                        <th className="text-left px-4 py-2 font-medium fg-secondary">
                          Endpoint
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayDetails.mcpServers
                        .slice()
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((s) => (
                          <tr key={s.name} className="border-b last:border-b-0">
                            <td className="px-4 py-2 fg-primary font-medium whitespace-nowrap">
                              {s.name}
                            </td>
                            <td className="px-4 py-2 fg-secondary whitespace-nowrap">
                              <span className="text-3xs bg-secondary px-1.5 py-0.5 rounded font-medium">
                                {s.type}
                              </span>
                            </td>
                            <td
                              className={`${s.type === 'http' ? '' : REPLAY_BLOCK_CLASS} px-4 py-2 fg-secondary font-mono text-xs`}
                            >
                              {s.type === 'http'
                                ? s.url
                                : `${s.command ?? ''}${s.args?.length ? ` ${s.args.join(' ')}` : ''}`}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </ComponentSection>
              )}

              {displayDetails.lspServers.length > 0 && (
                <ComponentSection title="LSP servers" collapsible>
                  <table className="w-full text-s">
                    <thead>
                      <tr className="bg-secondary/50 border-b">
                        <th className="text-left px-4 py-2 font-medium fg-secondary">
                          Name
                        </th>
                        <th className="text-left px-4 py-2 font-medium fg-secondary">
                          Command
                        </th>
                        <th className="text-left px-4 py-2 font-medium fg-secondary">
                          Languages
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayDetails.lspServers
                        .slice()
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((s) => (
                          <tr key={s.name} className="border-b last:border-b-0">
                            <td className="px-4 py-2 fg-primary font-medium whitespace-nowrap">
                              {s.name}
                            </td>
                            <td
                              className={`${REPLAY_BLOCK_CLASS} px-4 py-2 fg-secondary font-mono text-xs`}
                            >
                              {s.command}
                              {s.args?.length ? ` ${s.args.join(' ')}` : ''}
                            </td>
                            <td className="px-4 py-2 fg-secondary">
                              {s.languages?.join(', ') || '—'}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </ComponentSection>
              )}
            </>
          ) : !displayDetails.hasReadme ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-s fg-secondary">
                No components found for this provider.
              </p>
            </div>
          ) : null}
        </div>
      )}

      {relatedContent}
    </div>
  );
}

function CodexToggleButton({
  active,
  isCompat,
  disabled,
  disabledReason,
  onClick,
}: {
  active: boolean;
  isCompat: boolean;
  disabled: boolean;
  disabledReason?: 'compat-off';
  onClick: () => void;
}): JSX.Element {
  const baseClass = `px-3 py-1.5 rounded transition-colors disabled:opacity-50 ${
    active
      ? isCompat
        ? 'bg-warning-subtle fg-warning'
        : 'bg-base fg-primary'
      : isCompat
        ? 'fg-warning'
        : 'fg-secondary hover:fg-primary'
  }`;

  const button = (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      className={baseClass}
      data-testid="plugin-detail-toggle-codex"
      data-codex-compat={isCompat ? 'true' : 'false'}
    >
      Codex
    </button>
  );

  const tooltipLabel =
    disabledReason === 'compat-off'
      ? CODEX_COMPATIBILITY_DISABLED_TOOLTIP
      : isCompat
        ? CODEX_COMPATIBILITY_TOOLTIP
        : "Show this plugin's Codex details";

  return <Tooltip label={tooltipLabel}>{button}</Tooltip>;
}
