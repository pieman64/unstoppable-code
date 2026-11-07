import {
  CANOPY_QUERY_DEFINITIONS,
  CORE_CATALOG_QUERY_DEFINITIONS,
  CORE_CATALOG_SKILL_QUERY_DEFINITIONS,
  CORE_CATALOG_SOURCE_QUERY_DEFINITIONS,
  WORKER_CATALOG_QUERY_DEFINITIONS,
  composeCanopyQueryRegistries,
} from '@canopy/protocol/canopy-core';

/** The desktop dispatcher's queries: the composed registry plus the catalog reads and the in-process worker's materialization read (CAN-4123) the daemon does not serve. */
export const DESKTOP_QUERY_DEFINITIONS = composeCanopyQueryRegistries(
  CANOPY_QUERY_DEFINITIONS,
  CORE_CATALOG_QUERY_DEFINITIONS,
  CORE_CATALOG_SOURCE_QUERY_DEFINITIONS,
  WORKER_CATALOG_QUERY_DEFINITIONS,
  CORE_CATALOG_SKILL_QUERY_DEFINITIONS,
);
export type DesktopQueryDefinitions = typeof DESKTOP_QUERY_DEFINITIONS;
