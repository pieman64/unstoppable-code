/*
 * The data root canopy-paths registers as it loads, for admitted-storage-paths
 * where `import()` cannot load canopy-paths: tsx/cjs processes (test workers
 * and child fixtures) cannot import TypeScript sources. A leaf module, so
 * canopy-paths and admitted-storage-paths do not import each other.
 */
let registered: (() => string) | undefined;

export function registerCanopyDataRootResolver(resolver: () => string): void {
  registered = resolver;
}

export function registeredCanopyDataRootResolver(): (() => string) | undefined {
  return registered;
}
