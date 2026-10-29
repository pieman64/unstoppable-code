// Re-export of the browser-safe model catalog contract (CAN-1218).
//
// The single source of truth lives in `@canopy/protocol/models`. It is
// re-exported here so the web app can import the catalog contract from
// `@canopy/ui-shared` — the pure display layer both the desktop renderer and
// the web portal already depend on — without gaining a `@canopy/desktop-shared`
// dependency. This keeps the model picker's catalog types alongside the shared
// provider logos it renders.
export type {
  ModelCatalog,
  ModelCatalogOption,
  ModelCatalogOptionKind,
  ModelCatalogProvider,
  ModelCatalogSource,
} from '@canopy/protocol/models';
export {
  MODEL_CATALOG_PROVIDERS,
  formatModelContextWindow,
  getModelCatalogProviderLabel,
  getModelVendorLabel,
} from '@canopy/protocol/models';
