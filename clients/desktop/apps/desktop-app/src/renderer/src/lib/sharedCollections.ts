/**
 * Re-export of the shared Collection payload builders, which now live in
 * `@canopy/desktop-shared` so the Electron main process can build the same
 * payload when the web portal asks it to share a Collection (CAN-2845).
 * This module stays the renderer's import path.
 */
export * from '@canopy/desktop-shared/collections/shared-collection-payload';
