/**
 * Renderer-side brand helper.
 *
 * Centralizes access to the desktop brand runtime so visible UI copy never
 * hard-codes "Canopy". Components either import `brand` directly for richer
 * access (e.g. SVG assets, `web.title`, `serverDisplayName`) or use the
 * short-hand `brandText` accessors and `formatBrandText` for token-style
 * substitutions.
 *
 * Rule (per frontend plan): avoid string assembly for full sentences when
 * platform-specific text needs grammar; use full-sentence functions instead
 * of token templating for those cases.
 */
import { BRAND } from '@canopy/brand/current';
import type {
  BrandWebMobileApps,
  DesktopBrandRuntime,
} from '@canopy/protocol/brand';

export const brand: DesktopBrandRuntime = BRAND;

/**
 * The current brand's mobile app store listings, or `null` when there is
 * nothing to promote.
 *
 * Returns `null` for both "not declared" and "declared but both URLs absent".
 * The brand validator rejects the latter, but both fields are optional on the
 * runtime type, so TypeScript cannot narrow it away at the call sites.
 *
 * A function rather than a `brandText` getter: `brandText` is scalar-only by
 * design.
 *
 * **The brand is baked at build time** (`CANOPY_BRAND` → `brand:prepare`), and
 * `brands/canopy/brand.json` declares no `mobileApps` — only `unstoppable-code`
 * does. So under the default brand every mobile-app CTA correctly renders
 * nothing, in local dev and in the default E2E build alike. That is expected,
 * not a bug in the component.
 */
export function getBrandMobileApps(): BrandWebMobileApps | null {
  // Read through the `DesktopBrandRuntime`-annotated alias, not `BRAND`: the
  // generated per-brand module infers a narrow `web` shape that omits
  // `mobileApps` entirely for brands that do not declare it.
  const mobileApps = brand.web.mobileApps;
  if (!mobileApps) {
    return null;
  }
  if (!mobileApps.appStoreUrl && !mobileApps.playStoreUrl) {
    return null;
  }
  return mobileApps;
}

/**
 * Stable short-hand accessors for the most common brand-name slots. These are
 * re-evaluated lazily through getters so test setups that swap the brand
 * runtime module see the new values without import-order surprises.
 */
export const brandText = {
  get appName(): string {
    return BRAND.displayName;
  },
  get shortName(): string {
    return BRAND.shortName;
  },
  get serverName(): string {
    return BRAND.serverDisplayName;
  },
  get cliName(): string {
    return BRAND.cliName;
  },
  get bundleId(): string {
    return BRAND.appId;
  },
  get description(): string {
    return BRAND.description;
  },
} as const;

/**
 * Replace `{app}`, `{server}`, `{cli}`, `{short}` tokens in a template string
 * with the current brand's display names. Used for short labels and reserved
 * messages where word-by-word substitution is grammatically safe.
 *
 * Sentences whose grammar varies by platform MUST be expressed as full
 * sentences in `ui-text.ts` (resolved with `pt()`), not assembled from tokens.
 */
export function formatBrandText(template: string): string {
  return template
    .replace(/\{app\}/g, brandText.appName)
    .replace(/\{server\}/g, brandText.serverName)
    .replace(/\{cli\}/g, brandText.cliName)
    .replace(/\{short\}/g, brandText.shortName);
}
