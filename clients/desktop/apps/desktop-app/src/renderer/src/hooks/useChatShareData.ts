import {
  artifactInventoryScope,
  observeArtifactSkills,
} from '@/stores/agentArtifactInventoryStore';
import { useEffect, useSyncExternalStore } from 'react';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
  CANOPY_CLOUD_SERVER_ID,
} from '@canopy/desktop-shared/constants/canopy-cloud';
import type { InvocableInventoryEntry } from '@canopy/desktop-shared/types';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { MarketplaceInfo } from '@canopy/desktop-shared/types/plugins';
import type { SharedPluginSummary } from '@canopy/protocol/plugins';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import {
  buildInvocableMentionIndex,
  type InvocableMentionIndex,
} from '@/lib/invocableMentionIndex';
import { SHARED_PLUGINS_CHANGED_EVENT } from './useSharedMarketplaceShares';

/**
 * One cache of what the chat-side Share entry points need (CAN-3611), shared
 * by every mention, artifact card, rail row and nudge in a renderer.
 *
 * Nothing loads until a surface asks (`useChatShareData(true)`); after that
 * the cache stays subscribed to the events that can change an answer. Local
 * inventory and the account-specific audience are tracked separately so a
 * failed audience request never blocks resolving what can be shared.
 */

/** Dispatched on `window` when installed skills change. */
const SKILLS_CHANGED_EVENT = 'canopy:skills-changed';

export interface ChatShareData {
  /** `null` until loaded, and again after a failed load. */
  installedSkills: readonly InstalledSkillInfo[] | null;
  /** Cache-only marketplaces; `null` until loaded or after a failed load. */
  marketplaces: readonly MarketplaceInfo[] | null;
  /** True once a local load has settled, even if it failed. */
  localSettled: boolean;
  skillsSettled: boolean;
  marketplacesSettled: boolean;
  skillAudienceReady: boolean;
  /** This account's visible plugin shares; `null` while unknown. */
  sharedPlugins: readonly SharedPluginSummary[] | null;
  /** Connected cloud account, or `null` when signed out or unresolved. */
  accountId: string | null;
  /** All provider rows of the invocable inventory, for the activity rail. */
  inventoryEntries: readonly InvocableInventoryEntry[] | null;
  mentionIndex: InvocableMentionIndex | null;
}

const EMPTY: ChatShareData = {
  installedSkills: null,
  marketplaces: null,
  localSettled: false,
  skillsSettled: false,
  marketplacesSettled: false,
  skillAudienceReady: false,
  sharedPlugins: null,
  accountId: null,
  inventoryEntries: null,
  mentionIndex: null,
};

let state: ChatShareData = EMPTY;
const listeners = new Set<() => void>();
let shareStarted = false;
let inventoryStarted = false;
let unsubscribeEvents: (() => void) | null = null;
let localLoad: Promise<void> | null = null;
let localGeneration = 0;
let inventoryLoad: Promise<void> | null = null;
let inventoryGeneration = 0;
let inventorySignature = '';
let audienceLoad: Promise<void> | null = null;
let audienceFailed = false;
/** Bumped on every identity change so a late response is discarded. */
let audienceGeneration = 0;

function setState(patch: Partial<ChatShareData>): void {
  state = { ...state, ...patch };
  for (const listener of Array.from(listeners)) listener();
}

function loadLocal(): Promise<void> {
  if (localLoad) return localLoad;
  const generation = ++localGeneration;
  const artifactScope = artifactInventoryScope();
  observeArtifactSkills(null);
  const run = (async (): Promise<void> => {
    await Promise.all([
      window.skills
        .loadSkills()
        .catch(() => null)
        .then((skills) => {
          if (generation !== localGeneration) return;
          const loaded = skills?.success && skills.data ? skills.data : null;
          observeArtifactSkills(loaded, artifactScope);
          setState({
            installedSkills: loaded,
            skillsSettled: true,
            skillAudienceReady: loaded !== null,
          });
        }),
      window.plugins
        .loadMarketplacesCacheOnly()
        .catch(() => null)
        .then((marketplaces) => {
          if (generation !== localGeneration) return;
          setState({
            marketplaces:
              marketplaces?.success && marketplaces.data
                ? marketplaces.data.marketplaces
                : null,
            marketplacesSettled: true,
          });
        }),
    ]);
    if (generation !== localGeneration) return;
    setState({ localSettled: true });
  })();
  const tracked: Promise<void> = run.finally(() => {
    if (localLoad === tracked) localLoad = null;
  });
  localLoad = tracked;
  return tracked;
}

function loadInventory(): Promise<void> {
  if (inventoryLoad) return inventoryLoad;
  const generation = ++inventoryGeneration;
  const run = (async (): Promise<void> => {
    if (!window.invocableInventory) return;
    const result = await window.invocableInventory
      .list({ providerType: null })
      .catch(() => null);
    if (generation !== inventoryGeneration) return;
    if (!result?.success || !result.data) return;
    // Keep the shown rows while the backend serves an empty placeholder
    // during a rebuild, as `useInvocableInventory` does.
    if (result.data.rebuilding && result.data.entries.length === 0) return;
    const signature = JSON.stringify(result.data.entries);
    if (signature === inventorySignature && state.inventoryEntries) return;
    inventorySignature = signature;
    setState({
      inventoryEntries: result.data.entries,
      mentionIndex: buildInvocableMentionIndex(result.data.entries),
    });
  })();
  const tracked: Promise<void> = run.finally(() => {
    if (inventoryLoad === tracked) inventoryLoad = null;
  });
  inventoryLoad = tracked;
  return tracked;
}

function loadAudience(): Promise<void> {
  if (audienceLoad) return audienceLoad;
  audienceFailed = false;
  const generation = audienceGeneration;
  const run = (async (): Promise<void> => {
    let accountResolved = false;
    try {
      const account = await window.api.loadCanopyCloudAccount();
      if (generation !== audienceGeneration) return;
      accountResolved = true;
      const accountId =
        isCanopyCloudConnected(account) && !isGuestAccount(account)
          ? (account.account?.id ?? null)
          : null;
      if (accountId === null) {
        audienceFailed =
          (account.hasApiKey && !isGuestAccount(account)) ||
          (account.read !== undefined && account.read !== 'ok');
        setState({ accountId: null, sharedPlugins: null });
        return;
      }
      setState({ accountId });
      const result = await window.plugins.listShared({
        serverId: CANOPY_CLOUD_SERVER_ID,
      });
      if (generation !== audienceGeneration) return;
      audienceFailed = !result.success || !result.data;
      setState({
        accountId,
        sharedPlugins: result.success && result.data ? result.data.data : null,
      });
    } catch {
      if (generation !== audienceGeneration) return;
      audienceFailed = true;
      setState({
        sharedPlugins: null,
        ...(!accountResolved ? { accountId: null } : {}),
      });
    }
  })();
  const tracked: Promise<void> = run.finally(() => {
    if (audienceLoad === tracked) audienceLoad = null;
  });
  audienceLoad = tracked;
  return tracked;
}

/** Re-reads installed skills and marketplaces, superseding any load in flight. */
function refreshLocal(): void {
  if (!shareStarted) return;
  localLoad = null;
  setState({
    localSettled: false,
    skillsSettled: false,
    marketplacesSettled: false,
    skillAudienceReady: false,
  });
  void loadLocal();
}

function refreshInventory(): void {
  if (!inventoryStarted) return;
  inventoryLoad = null;
  void loadInventory();
}

/** Re-reads who the account's plugins are shared with. */
export function refreshChatShareAudience(): void {
  if (!shareStarted) return;
  audienceGeneration += 1;
  audienceLoad = null;
  setState({ sharedPlugins: null });
  void loadAudience();
}

/** Re-reads everything a completed share or a closed dialog can change. */
export function refreshChatShareData(): void {
  refreshLocal();
  refreshChatShareAudience();
}

function handleIdentityChanged(): void {
  if (!shareStarted) return;
  // Drop the previous account's audience before the new one loads.
  audienceGeneration += 1;
  audienceLoad = null;
  setState({
    accountId: null,
    sharedPlugins: null,
    skillAudienceReady: false,
    installedSkills:
      state.installedSkills?.map((skill) => {
        const local = { ...skill };
        delete local.remote;
        return local;
      }) ?? null,
  });
  void loadAudience();
  // A skill's author-side link is stored per account.
  refreshLocal();
}

function handleInventoryChanged(): void {
  refreshInventory();
  refreshLocal();
}

/** One set of subscriptions for the renderer, whichever part starts first. */
function subscribeEvents(): void {
  if (unsubscribeEvents) return;
  const unsubscribeInventory = window.invocableInventory?.onChanged(
    handleInventoryChanged,
  );
  window.addEventListener(
    SHARED_PLUGINS_CHANGED_EVENT,
    refreshChatShareAudience,
  );
  window.addEventListener(
    CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
    handleIdentityChanged,
  );
  window.addEventListener(SKILLS_CHANGED_EVENT, refreshLocal);
  unsubscribeEvents = (): void => {
    unsubscribeInventory?.();
    window.removeEventListener(
      SHARED_PLUGINS_CHANGED_EVENT,
      refreshChatShareAudience,
    );
    window.removeEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      handleIdentityChanged,
    );
    window.removeEventListener(SKILLS_CHANGED_EVENT, refreshLocal);
  };
}

/** Installed skills, marketplaces and the account's audience. */
function startShareData(): void {
  if (shareStarted) {
    // Retry only failures when a surface returns or a new pending use arrives.
    // In-flight loads are shared; successful caches and signed-out state stay cached.
    if (
      !localLoad &&
      state.localSettled &&
      (state.installedSkills === null || state.marketplaces === null)
    )
      refreshLocal();
    if (audienceFailed && !audienceLoad) void loadAudience();
    return;
  }
  shareStarted = true;
  subscribeEvents();
  void loadLocal();
  void loadAudience();
}

/** The invocable inventory only: local, and needed to list a chat's usage. */
function startInventory(): void {
  if (inventoryStarted) return;
  inventoryStarted = true;
  subscribeEvents();
  void loadInventory();
}

/** Starts the cache and resolves once the local inventory load has settled. */
export async function loadChatShareLocalData(
  kind?: 'skill' | 'plugin',
): Promise<ChatShareData> {
  startShareData();
  const ready = (): boolean =>
    kind === 'skill'
      ? state.skillsSettled
      : kind === 'plugin'
        ? state.marketplacesSettled
        : state.localSettled;
  if (!ready())
    await new Promise<void>((resolve) => {
      const unsubscribe = subscribe(() => {
        if (!ready()) return;
        unsubscribe();
        resolve();
      });
      if (ready()) {
        unsubscribe();
        resolve();
      }
    });
  return state;
}

export function getChatShareData(): ChatShareData {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ChatShareData {
  return state;
}

/**
 * The shared cache. Pass `false` while the surface has nothing to resolve so
 * a transcript full of mentions costs nothing until one is opened.
 */
export function useChatShareData(
  active: boolean,
  retryKey?: string,
): ChatShareData {
  useEffect(() => {
    if (active) startShareData();
  }, [active, retryKey]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function getMentionIndexSnapshot(): InvocableMentionIndex | null {
  return state.mentionIndex;
}

/**
 * The mention index over every provider's inventory rows. Reads the local
 * inventory cache only; it never loads skills, marketplaces or the account.
 */
export function useChatMentionIndex(): InvocableMentionIndex | null {
  useEffect(() => {
    startInventory();
  }, []);
  return useSyncExternalStore(
    subscribe,
    getMentionIndexSnapshot,
    getMentionIndexSnapshot,
  );
}
