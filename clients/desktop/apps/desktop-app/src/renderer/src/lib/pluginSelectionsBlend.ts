// Pure set-algebra helpers for blending a Home draft's `pluginSelections`
// with a workspace's `defaultPluginSelections` (Task F1). The implementation
// moved to the shared package so the Electron main process and renderer use
// one code path for selection set algebra and the global default-plugin
// overlay (CAN-1428); this module remains the renderer-local import site.
export {
  unionPluginSelections,
  subtractPluginSelections,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
