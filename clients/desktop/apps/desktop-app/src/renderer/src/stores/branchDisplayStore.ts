import { create } from 'zustand';
import type { BranchDisplayMapping } from '@canopy/desktop-shared/types';
import {
  applyBranchDisplayMappings,
  mergeMappingsWithBuiltins,
} from '@canopy/desktop-shared/lib/branch-display-mapping';

interface BranchDisplayState {
  mappings: BranchDisplayMapping[];
  mappingsVersion: number;
  loadMappings: () => Promise<void>;
  setMappings: (mappings: BranchDisplayMapping[]) => void;
  invalidateCache: () => void;
  getDisplayName: (branchName: string) => string;
}

let cache = new Map<string, string>();
let cacheVersion = -1;

export const useBranchDisplayStore = create<BranchDisplayState>((set, get) => ({
  mappings: [],
  mappingsVersion: 0,

  loadMappings: async (): Promise<void> => {
    try {
      const prefs = await window.api.loadPreferences();
      const merged = mergeMappingsWithBuiltins(
        prefs.branchDisplayMappings ?? [],
      );
      set((s) => ({
        mappings: merged,
        mappingsVersion: s.mappingsVersion + 1,
      }));
    } catch {
      // Preferences unavailable — keep defaults
    }
  },

  setMappings: (mappings: BranchDisplayMapping[]): void => {
    const merged = mergeMappingsWithBuiltins(mappings);
    set((s) => ({
      mappings: merged,
      mappingsVersion: s.mappingsVersion + 1,
    }));
  },

  invalidateCache: (): void => {
    set((s) => ({ mappingsVersion: s.mappingsVersion + 1 }));
  },

  getDisplayName: (branchName: string): string => {
    const { mappings, mappingsVersion } = get();
    if (cacheVersion !== mappingsVersion) {
      cache = new Map<string, string>();
      cacheVersion = mappingsVersion;
    }
    const cached = cache.get(branchName);
    if (cached !== undefined) return cached;
    const display = applyBranchDisplayMappings(branchName, mappings);
    cache.set(branchName, display);
    return display;
  },
}));
