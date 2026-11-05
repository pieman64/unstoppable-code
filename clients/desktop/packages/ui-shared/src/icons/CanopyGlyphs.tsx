/**
 * @fileoverview
 * Canopy-authored glyphs: artwork Canopy draws itself because no manifest
 * source has an equivalent. Each renders through `AppIconBase` with the same
 * sizing contract as the generated glyphs, so it sits beside them as one set.
 * `icon-manifest.json` lists these with `"source": "canopy"`.
 * `apps/desktop-app`'s `BannerGlyphs.tsx` does the same for its two app-local
 * banner icons.
 */
import React, { type JSX } from 'react';
import { AppIconBase, type AppIconBaseProps } from './AppIconBase';

/**
 * Shimmer: three diagonal waves for automatic model routing. Redrawn from the
 * earlier Central `IconShimmer` on Lucide's grid (2px round stroke), since
 * Lucide has no equivalent.
 */
export const IconShimmer = /* @__PURE__ */ React.memo(function IconShimmer(
  props: AppIconBaseProps,
): JSX.Element {
  return (
    <AppIconBase
      {...props}
      viewBox="0 0 24 24"
      artworkFamily="lucide"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-glyph="IconShimmer"
    >
      <path d="M12 3c0 2.6-1.2 3.9-3.1 4.9l-2.8 1.6C4.2 10.6 4 11.6 4 13" />
      <path d="M16 7c0 2.6-1.2 3.9-3.1 4.9l-2.8 1.6C8.2 14.6 8 15.6 8 17" />
      <path d="M20 11c0 2.6-1.2 3.9-3.1 4.9l-2.8 1.6C12.2 18.6 12 19.6 12 21" />
    </AppIconBase>
  );
});

/**
 * Merge queue: two queued dots waiting above a target ring, with the branch
 * ring beside them. Drawn on Lucide's grid (2px round stroke), since Lucide
 * has no merge-queue glyph; the dots use a 3.5 stroke so they read at 14px.
 */
export const IconMergeQueue = /* @__PURE__ */ React.memo(
  function IconMergeQueue(props: AppIconBaseProps): JSX.Element {
    return (
      <AppIconBase
        {...props}
        viewBox="0 0 24 24"
        artworkFamily="lucide"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        data-glyph="IconMergeQueue"
      >
        <path d="M6 4h.01" strokeWidth={3.5} />
        <path d="M11 8h.01" strokeWidth={3.5} />
        <path d="M6 9v6" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="13" r="3" />
      </AppIconBase>
    );
  },
);
