import { create } from 'zustand';
import { setReferenceEnrichmentModes } from '@canopy/app-state';
import {
  DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
  DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
} from '@canopy/desktop-shared/constants/preferences';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import type { ReferenceEnrichmentMode } from '@canopy/protocol/reference-previews';
import { subscribePreferencesUpdated } from './preferences-events';

interface ChatEnrichmentModes {
  readonly linear: ReferenceEnrichmentMode;
  readonly github: ReferenceEnrichmentMode;
}

const OFF: ChatEnrichmentModes = { linear: 'off', github: 'off' };
export const useChatEnrichmentModes = create<ChatEnrichmentModes>(() => OFF);
let initialization: Promise<void> | null = null;
let revision = 0;
let unsubscribeSynced: (() => void) | null = null;
let unsubscribeLocal: (() => void) | null = null;

function normalizeMode(
  value: unknown,
  fallback: ReferenceEnrichmentMode,
): ReferenceEnrichmentMode {
  return value === 'replace' || value === 'hover' || value === 'off'
    ? value
    : fallback;
}

function applyPreferences(preferences: PreferencesData): void {
  revision += 1;
  const modes: ChatEnrichmentModes = {
    linear: normalizeMode(
      preferences.linearChatEnrichmentMode,
      DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
    ),
    github: normalizeMode(
      preferences.githubChatEnrichmentMode,
      DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
    ),
  };
  setReferenceEnrichmentModes(modes);
  const current = useChatEnrichmentModes.getState();
  if (current.linear !== modes.linear || current.github !== modes.github) {
    useChatEnrichmentModes.setState(modes);
  }
}

/** Gate hydration before React mounts; a newer broadcast wins over the load. */
export function initializeChatEnrichmentModes(): Promise<void> {
  if (initialization !== null) return initialization;
  setReferenceEnrichmentModes(OFF);
  const before = revision;
  unsubscribeSynced = window.api.onPreferencesSynced(applyPreferences);
  unsubscribeLocal = subscribePreferencesUpdated(applyPreferences);
  initialization = (async (): Promise<void> => {
    try {
      const preferences = await window.api.loadPreferences();
      if (revision === before) applyPreferences(preferences);
    } catch {
      // A failed read must not flash Replace over a saved Hover/Off choice.
      // A later canonical preference broadcast can restore enrichment.
    }
  })();
  return initialization;
}

export function disposeChatEnrichmentModes(): void {
  revision += 1;
  unsubscribeSynced?.();
  unsubscribeLocal?.();
  unsubscribeSynced = null;
  unsubscribeLocal = null;
  initialization = null;
  setReferenceEnrichmentModes(OFF);
  useChatEnrichmentModes.setState(OFF);
}
