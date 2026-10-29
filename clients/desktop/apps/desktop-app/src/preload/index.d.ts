import type { SkillShareNudgeAPI } from '@canopy/desktop-shared/lib/skill-share-nudge';
import type { SkillSuggestionsAPI } from '@canopy/desktop-shared/lib/skill-suggestions';
import { type ElectronAPI } from '@electron-toolkit/preload';
import { type CanopyApi } from '@canopy/desktop-shared/types';
import type { BundlesAPI } from './api/bundles-api';
import type { CollectionsAPI } from './api/collections-api';
import type { PipelinesAPI } from './api/pipelines-api';
import type { PluginsAPI } from './api/plugins-api';
import type { McpServersAPI } from './api/mcp-servers-api';
import type { SkillsAPI } from './api/skills-api';
import type { AgentModelsAPI } from './api/agents-api';
import type { InvocableInventoryAPI } from './api/invocable-inventory-api';
import type { InstalledItemsAPI } from '@canopy/desktop-shared/types/installed-items';
import type { CanopyCoreRelayApi } from '../shared/canopy-core-relay';

/**
 * In-app browser preload bridge surface, declared on `window.api.browser`.
 *
 * The interface is defined once in `@canopy/desktop-shared` (alongside the rest
 * of the browser transport types) and attached to `Window['api']` via the
 * `browser` member of {@link CanopyApi}. It is re-surfaced here so the preload
 * package — which implements the bridge in `index.ts` — declares the matching
 * `BrowserApi` shape. See the browser transport types for the per-method
 * channel mapping and the `onEvent` subscription contract.
 */
export type { BrowserApi } from '@canopy/desktop-shared/types';

declare global {
  interface Window {
    electron: ElectronAPI;
    platform: NodeJS.Platform;
    /**
     * This computer's platform; differs from `platform` in a window that
     * shows another computer. Absent outside the app's preload.
     */
    localPlatform?: NodeJS.Platform;
    api: CanopyApi;
    canopyCore: CanopyCoreRelayApi;
    /**
     * @deprecated Use `window.collections` for new code. `window.bundles` is
     * preserved as a deprecated alias during the staged Bundles → Collections
     * migration so unmigrated renderer paths still resolve at runtime.
     */
    bundles: BundlesAPI;
    collections: CollectionsAPI;
    pipelines: PipelinesAPI;
    plugins: PluginsAPI;
    skills: SkillsAPI;
    agents: AgentModelsAPI;
    installedItems: InstalledItemsAPI;
    invocableInventory: InvocableInventoryAPI;
    skillShareNudge: SkillShareNudgeAPI;
    skillSuggestions: SkillSuggestionsAPI;
    mcpServers: McpServersAPI;
    devInfo: {
      isDev: boolean;
      branch: string | null;
      /** E2E-only hold-back for the onboarding suggestions module. */
      hideOnboardingSuggestions?: boolean;
    };
  }
}
