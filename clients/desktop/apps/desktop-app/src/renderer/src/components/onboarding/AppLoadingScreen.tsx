import type { JSX } from 'react';
import { BrandLogo } from '@/components/BrandLogo';
import { Surface } from '@canopy/ui-shared/components';

/**
 * Full-viewport branded loading screen shown by App.tsx between the moment the
 * renderer mounts and the moment both preferences and projects hydrate.
 *
 * The brand logo animates with a gentle pulse via .onboarding-logo-pulse
 * (defined in globals.css). The animation is suppressed by
 * prefers-reduced-motion: reduce.
 *
 * Adaptation note: brand.logo does not exist on DesktopBrandRuntime. The logo
 * is brand.assets.logoSvg (inline SVG markup). BrandLogo handles rendering it
 * as an accessible <span role="img" aria-label="${displayName} logo"> wrapper.
 */
export function AppLoadingScreen(): JSX.Element {
  return (
    // The window's whole content in place of the shell, not a layer over it.
    <Surface
      variant="pane"
      extent="viewport"
      className="flex w-full items-center justify-center"
      data-testid="app-loading-screen"
    >
      <BrandLogo
        size={96}
        className="onboarding-logo-pulse select-none fg-accent"
      />
    </Surface>
  );
}
