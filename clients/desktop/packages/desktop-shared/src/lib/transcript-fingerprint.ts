/**
 * Transcript block fingerprinting and the layout-block-type set, owned by the
 * browser-safe `@canopy/agent-transcript` package. Kept at this path so
 * desktop-side importers can reach it through their usual
 * `@canopy/desktop-shared/lib/...` import style.
 */
export {
  blockFingerprint,
  normalizeFingerprintText,
  LAYOUT_BLOCK_TYPES,
} from '@canopy/agent-transcript';
