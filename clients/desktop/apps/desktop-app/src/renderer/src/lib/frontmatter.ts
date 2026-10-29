// The sanitizing frontmatter parser moved to the shared UI package so the
// file-viewer markdown preview (desktop + portal) and desktop skill surfaces
// share one implementation (CAN-745).
export { parseFrontmatterAndBody } from '@canopy/ui-app';
