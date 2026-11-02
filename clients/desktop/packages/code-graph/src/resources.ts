// The engine never resolves host paths itself: each host installs the
// resolver for its bundled `code-graph/` resources (grammars, queries and the
// web-tree-sitter runtime) before using an engine API without an explicit
// `resourcesDir`. The resolver lives on `globalThis` so it is one per process
// even when a bundler or test runner instantiates this module more than once.
const RESOLVER_KEY = Symbol.for('canopy.codeGraph.defaultResourcesDirResolver');

type ResourcesDirResolver = () => string;

function isResourcesDirResolver(value: unknown): value is ResourcesDirResolver {
  return typeof value === 'function';
}

export function installCodeGraphResourcesDirResolver(
  resolver: ResourcesDirResolver,
): void {
  Reflect.set(globalThis, RESOLVER_KEY, resolver);
}

export function getDefaultCodeGraphResourcesDir(): string {
  const resolver: unknown = Reflect.get(globalThis, RESOLVER_KEY);
  if (!isResourcesDirResolver(resolver)) {
    throw new Error(
      'No code-graph resources directory resolver is installed; the host must call installCodeGraphResourcesDirResolver first.',
    );
  }
  return resolver();
}
