import type { Descendant } from 'slate';
import { TRY_IT_HARNESSES, type TryItHarness } from '@canopy/protocol/try-it';
import type {
  AgentProviderType,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import { mergeTryItCapabilitySelections } from '@canopy/protocol/try-it/staging';
export { tryItStagedMessage } from '@canopy/protocol/try-it/staging';
import { appendDraftText } from '@canopy/ui-rich/editor/append-draft-text';

/**
 * Pure staging policy for Try it (CAN-5218): which chat receives the starter
 * prompt, how it is appended to an existing draft, and how the capability
 * joins the chat's selections. Store, navigation, and composer access stay in
 * `tryItChat.ts`.
 */

/** The tab fields target selection reads. */
export interface TryItStageCandidateTab {
  id: string;
  kind?: string;
  readOnly?: boolean;
  pendingInitialCreation?: boolean;
}

export type TryItStageChoice =
  /** Stage into this existing editable chat. */
  | { kind: 'existing'; tabId: string }
  /** Create an empty chat in the selected worktree. */
  | { kind: 'new-tab' }
  /** No worktree is selected: create an empty standalone chat. */
  | { kind: 'standalone' };

function isEditableCandidate(tab: TryItStageCandidateTab | undefined): boolean {
  return (
    tab !== undefined &&
    tab.kind !== 'file' &&
    tab.readOnly !== true &&
    tab.pendingInitialCreation !== true
  );
}

/**
 * The selected worktree's active editable chat, else its remembered editable
 * chat behind a non-chat tab, else a new chat in that worktree. A candidate
 * whose provider cannot run the capability is never reused; a compatible
 * chat is created beside it instead. Without a selected worktree, a new
 * standalone chat.
 */
export function chooseTryItStageTarget<Tab extends TryItStageCandidateTab>(
  input: {
    worktreeSelected: boolean;
    tabs: readonly Tab[];
    activeTabId: string | undefined;
    lastActiveEditableChatId: string | undefined;
  },
  isCompatible: (tab: Tab) => boolean,
): TryItStageChoice {
  if (!input.worktreeSelected) return { kind: 'standalone' };
  const byId = (id: string | undefined): Tab | undefined =>
    id === undefined ? undefined : input.tabs.find((tab) => tab.id === id);
  const active = byId(input.activeTabId);
  const candidate = isEditableCandidate(active)
    ? active
    : active === undefined || active.kind === 'file'
      ? byId(input.lastActiveEditableChatId)
      : undefined;
  if (candidate && isEditableCandidate(candidate) && isCompatible(candidate))
    return { kind: 'existing', tabId: candidate.id };
  return { kind: 'new-tab' };
}

function harnessForProvider(provider: AgentProviderType): TryItHarness | null {
  // These providers load the same plugin facet as Cursor (pluginHarnessRows).
  if (provider === 'copilot' || provider === 'opencode') return 'cursor';
  return TRY_IT_HARNESSES.find((harness) => harness === provider) ?? null;
}

/**
 * Whether a chat on `provider` can run the capability. Absent support means
 * every harness runs it; restricted support requires a resolved provider
 * so an existing chat cannot later fall back to an unsupported harness.
 */
export function tryItProviderSupported(
  provider: AgentProviderType | undefined,
  support: Record<TryItHarness, boolean> | undefined,
): boolean {
  if (!support) return true;
  if (provider === undefined) return false;
  const harness = harnessForProvider(provider);
  return harness !== null && support[harness];
}

/**
 * Appends the starter after a blank line at the end of `draft`, keeping its
 * nodes (file references included). An empty draft becomes the starter.
 * Never mutates `draft`.
 */
export function appendTryItStarter(
  draft: readonly Descendant[] | undefined,
  prompt: string,
): Descendant[] {
  return appendDraftText(draft, prompt);
}

/**
 * Adds the Try it selections to the chat's own selections, deduplicated by
 * stable identity. Unrelated selections are kept. Local selections are never
 * suppressed by inherited-default tombstones, so an explicit Try it is
 * always selected.
 */
export function mergeTryItSelections(
  existing: ChatTabPluginSelections | undefined,
  incoming: ChatTabPluginSelections,
): ChatTabPluginSelections {
  return mergeTryItCapabilitySelections(
    existing ?? { collectionIds: [], skillRefs: [], pluginRefs: [] },
    incoming,
  );
}
