// Jest-only host data for shared settings tests in the desktop source export.
import { BRAND } from '@canopy/brand/current';
import type { WebBrandRuntime } from '@canopy/protocol/brand';

export const WEB_BRANDS = [
  {
    ...BRAND,
    assets: {
      logoSvgUrl: `/brand/${BRAND.id}/logo.svg`,
      logoSvgContent: BRAND.assets.logoSvg,
      appIconPngUrl: `/brand/${BRAND.id}/icon.png`,
      webIconPngUrl: `/brand/${BRAND.id}/web-icon.png`,
    },
  },
] satisfies readonly WebBrandRuntime[];
