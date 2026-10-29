import type { ReactNode } from 'react';
import type { UnifiedPluginEntry } from './unified-plugin-entry';

/**
 * Section contract for the Plugins discovery grid (API-2153), kept out of
 * `PluginsDiscoveryList.tsx` so the collapsing helpers can be shared without
 * turning that file into a mixed component/utility module.
 *
 * Section ids are part of the page's stable `data-testid` contract
 * (`plugins-section-<id>`, `plugins-section-body-<id>`,
 * `plugins-section-heading-<id>`). Browse groups marketplace content under
 * clickable category headings, so the id set is open-ended on the
 * `category-<slug>` shape.
 */
export type PluginsDiscoverySectionId =
  | 'featured'
  | 'suggested'
  | 'recommended'
  | 'curated'
  | 'apps'
  | 'installed'
  | 'marketplace'
  | 'shared-plugins'
  | 'skills'
  | 'pipelines'
  | 'automations'
  | 'collections'
  | 'agents'
  | 'project-templates'
  | 'search-results'
  | 'workflows'
  | 'plugins-and-mcp'
  | 'category-page'
  | `category-${string}`;

export interface PluginsDiscoverySection {
  id: PluginsDiscoverySectionId;
  /**
   * Section heading. Pass `''` when the host already titles the surface (the
   * management view's Installed section does), so the list does not stack a
   * second heading on top of it.
   */
  title: string;
  entries: UnifiedPluginEntry[];
  /**
   * Trailing entries of `entries` held behind the section's category-page
   * navigation. `0`/omitted renders the whole preview.
   */
  collapsedCount?: number;
  /**
   * Invoked when the section heading is activated. Browse sections use this to
   * open their dedicated page; a section without this callback renders a
   * static heading and never hides entries.
   */
  onExpand?: () => void;
  /**
   * Controls that act on this section's list (the Pipelines tab's filters),
   * set at the trailing end of its heading row. A section with header
   * actions stays on screen when it has no entries, so a filter that empties
   * it can still be changed back.
   */
  headerActions?: ReactNode;
  /** Shown in place of the rows when a section with header actions is empty. */
  emptyMessage?: string;
  /**
   * The section mixes kinds (search results), so each card names its type in
   * plain text after its name. A section of one kind is already titled by its
   * heading or tab and leaves this unset.
   */
  showEntryTypes?: boolean;
}

/**
 * Entries a section is holding behind its category page, clamped to what it
 * actually has. A `collapsedCount` without an `onExpand` collapses nothing:
 * hiding entries behind an affordance the host never wired up would strand
 * them with no way to reach them.
 */
export function collapsedSectionCount(
  section: PluginsDiscoverySection,
): number {
  if (section.onExpand === undefined) return 0;
  return Math.max(
    0,
    Math.min(section.collapsedCount ?? 0, section.entries.length),
  );
}

/**
 * Entries a section currently puts on screen. Shared with the page, which
 * reports "how many results are showing" to App Advisor and must agree with
 * what the grid actually rendered.
 */
export function visibleSectionEntries(
  section: PluginsDiscoverySection,
): UnifiedPluginEntry[] {
  const collapsed = collapsedSectionCount(section);
  return collapsed === 0
    ? section.entries
    : section.entries.slice(0, section.entries.length - collapsed);
}
