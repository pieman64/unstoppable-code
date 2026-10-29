/**
 * Whether a Cowork workspace name is one the app assigned rather than one the
 * user chose. The rule itself lives in `@canopy/protocol/ui-labels` so the
 * shared sidebar (`@canopy/ui-app`) hoists the same catch-all workspace above
 * Projects that this renderer's Chats header names; this module stays as the
 * renderer's import path for it.
 */
export { isDefaultCoworkWorkspaceName } from '@canopy/protocol';
