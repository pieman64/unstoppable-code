import type { Plugin } from 'vite';

function isDatadogRendererModule(id: string): boolean {
  return id.includes('/node_modules/@datadog/');
}

/**
 * Vite's dynamic-import preload helper. Every chunk that lazy-loads another
 * chunk imports it, so it must not be absorbed into a manual chunk: Rollup
 * pulls a manual chunk's unassigned dependencies into that chunk, and the
 * startup entry would then statically load the whole host chunk (it once
 * loaded all of `datadog-sdk` for this one helper, even with RUM disabled).
 */
const VITE_PRELOAD_HELPER_ID = '\0vite/preload-helper.js';

/**
 * Renderer `manualChunks`. Names starting with `vendor-` (and the Datadog
 * chunk) hold third-party code.
 */
export function rendererManualChunk(id: string): string | undefined {
  if (id === VITE_PRELOAD_HELPER_ID) {
    return 'vendor-vite-preload-helper';
  }
  if (
    id.includes('/node_modules/posthog-js/') ||
    id.includes('/node_modules/@posthog/')
  )
    return 'posthog-sdk';
  if (id.includes('/node_modules/pdfjs-dist/')) return 'vendor-pdfjs';
  if (isDatadogRendererModule(id)) {
    return 'datadog-sdk';
  }
  // ~27KB of base64 store-badge data URIs (CAN-1939). Isolated so
  // the always-mounted shell's lazy CTA banner does not drag them
  // onto the startup path.
  if (id.includes('/ui-shared/src/assets/store-badges')) {
    return 'store-badges';
  }
  // Same reasoning as the badges: the QR encoder is reachable only
  // through that lazy banner, so keep it off the startup chunk.
  if (id.includes('/node_modules/qrcode/')) {
    return 'vendor-qrcode';
  }
  if (
    id.includes('/node_modules/react/') ||
    id.includes('/node_modules/react-dom/') ||
    id.includes('/node_modules/scheduler/') ||
    // React's store shim. Both the app's zustand and xyflow's nested
    // zustand import it; left unassigned, it would be absorbed into the
    // lazily loaded `vendor-xyflow`, and startup would load that chunk.
    id.includes('/node_modules/use-sync-external-store/')
  ) {
    return 'vendor-react';
  }
  if (
    id.includes('/node_modules/slate/') ||
    id.includes('/node_modules/slate-react/') ||
    id.includes('/node_modules/slate-dom/') ||
    id.includes('/node_modules/slate-history/')
  ) {
    return 'vendor-slate';
  }
  if (id.includes('/node_modules/markdown-to-jsx/')) {
    return 'vendor-markdown';
  }
  if (id.includes('/node_modules/react-diff-viewer-continued/')) {
    return 'vendor-diff';
  }
  // A dependency of the diff viewer that startup code also imports. Left
  // unassigned, it would be absorbed into the lazily loaded `vendor-diff`.
  if (id.includes('/node_modules/js-yaml/')) {
    return 'vendor-js-yaml';
  }
  if (id.includes('/node_modules/@xyflow/react/')) {
    // The stylesheet stays with the startup styles (`main.tsx` imports it
    // first, so its cascade position is unchanged); only the library itself
    // loads with the diagrams.
    return /\.css(?:$|\?)/.test(id) ? undefined : 'vendor-xyflow';
  }
  if (
    id.includes('/node_modules/@monaco-editor/react/') ||
    id.includes('/node_modules/@monaco-editor/loader/') ||
    id.includes('/node_modules/monaco-editor/')
  ) {
    return 'vendor-monaco';
  }
  return undefined;
}

/** Manual chunks that must load on demand, never with a window's startup. */
export const RENDERER_ON_DEMAND_CHUNKS: readonly string[] = [
  'datadog-sdk',
  'posthog-sdk',
  'store-badges',
  'vendor-diff',
  'vendor-monaco',
  'vendor-pdfjs',
  'vendor-qrcode',
  'vendor-xyflow',
];

interface RendererOutputChunk {
  type: 'chunk';
  name: string;
  fileName: string;
  isEntry: boolean;
  facadeModuleId: string | null;
  imports: string[];
  moduleIds: string[];
}

type RendererOutput = RendererOutputChunk | { type: 'asset' };

export interface RendererStartupBoundary {
  /**
   * Path suffix of the module a page's script loads, e.g.
   * `/src/app-advisor-entry.tsx`. Matched against the entry chunk's modules:
   * for an HTML input, Vite names the page itself as the chunk's facade.
   */
  entryModule: string;
  /** Module path suffixes that entry's startup must not load. */
  forbiddenModules: readonly string[];
}

/** The chunks an entry loads at startup: itself and its static imports. */
function startupClosure(
  bundle: Readonly<Record<string, RendererOutput>>,
  entry: RendererOutputChunk,
): RendererOutputChunk[] {
  const visited = new Set<string>();
  const loaded: RendererOutputChunk[] = [];
  const queue = [entry.fileName];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const chunk = bundle[next];
    if (visited.has(next) || chunk?.type !== 'chunk') continue;
    visited.add(next);
    loaded.push(chunk);
    queue.push(...chunk.imports);
  }
  return loaded;
}

/** Whether `boundary` belongs to `entry`: the page's entry module is in it. */
function boundaryAppliesTo(
  boundary: RendererStartupBoundary,
  entry: RendererOutputChunk,
): boolean {
  return [entry.facadeModuleId ?? entry.fileName, ...entry.moduleIds].some(
    (id) => id.endsWith(boundary.entryModule),
  );
}

/** Forbidden modules of `boundary` found in `loaded`, as violation messages. */
function forbiddenModuleViolations(
  entryId: string,
  boundary: RendererStartupBoundary,
  loaded: readonly RendererOutputChunk[],
): string[] {
  return boundary.forbiddenModules.flatMap((forbidden) =>
    loaded
      .filter((chunk) => chunk.moduleIds.some((id) => id.endsWith(forbidden)))
      .map((chunk) => `${entryId} loads ${forbidden} (${chunk.fileName})`),
  );
}

/**
 * Startup-boundary violations in a renderer bundle: on-demand chunks, or
 * another window's modules, reachable from an entry through static imports.
 * A boundary whose entry module no entry chunk contains is a violation too,
 * so a renamed entry cannot silently disable its check.
 */
export function findRendererStartupViolations(
  bundle: Readonly<Record<string, RendererOutput>>,
  boundaries: readonly RendererStartupBoundary[],
): string[] {
  const violations: string[] = [];
  const matchedBoundaries = new Set<RendererStartupBoundary>();
  for (const output of Object.values(bundle)) {
    if (output.type !== 'chunk' || !output.isEntry) continue;
    const loaded = startupClosure(bundle, output);
    const entryId = output.facadeModuleId ?? output.fileName;
    for (const chunk of loaded) {
      if (RENDERER_ON_DEMAND_CHUNKS.includes(chunk.name)) {
        violations.push(`${entryId} loads on-demand chunk ${chunk.name}`);
      }
    }
    for (const boundary of boundaries) {
      if (!boundaryAppliesTo(boundary, output)) continue;
      matchedBoundaries.add(boundary);
      violations.push(...forbiddenModuleViolations(entryId, boundary, loaded));
    }
  }
  for (const boundary of boundaries) {
    if (!matchedBoundaries.has(boundary)) {
      violations.push(`no renderer entry loads ${boundary.entryModule}`);
    }
  }
  return violations;
}

/** Fails the build when a window's startup would load what it must not. */
export function rendererStartupBoundaryPlugin(
  boundaries: readonly RendererStartupBoundary[],
): Plugin {
  return {
    name: 'canopy:renderer-startup-boundary',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_outputOptions, bundle): void {
        const violations = findRendererStartupViolations(bundle, boundaries);
        if (violations.length > 0) {
          this.error(
            `Renderer startup loads code it must load on demand: ${violations.join('; ')}`,
          );
        }
      },
    },
  };
}
