import { transform, type TransformOptions } from 'esbuild';
import type { SourceMapInput } from 'rollup';
import type { Plugin } from 'vite';

/**
 * Release minification for renderer chunks.
 *
 * Vite's own `vite:esbuild-transpile` `renderChunk` runs after every user
 * plugin, `enforce: 'post'` included. With a Chrome `build.target` and
 * `build.minify: false` (electron-vite's renderer default), it re-prints every
 * chunk in esbuild's readable, indented form. This pass runs last
 * (`order: 'post'`) and gives every chunk the full esbuild minification Vite
 * applies with `build.minify: 'esbuild'`.
 */
const RENDERER_CHUNK_MINIFY_OPTIONS: TransformOptions = {
  minify: true,
  treeShaking: true,
};

type EsbuildTarget = TransformOptions['target'];

function esbuildTarget(target: unknown): EsbuildTarget {
  if (typeof target === 'string') return target;
  if (
    Array.isArray(target) &&
    target.every((entry): entry is string => typeof entry === 'string')
  ) {
    return target;
  }
  return undefined;
}

function parseSourceMapInput(map: string): SourceMapInput {
  const parsedMap: unknown = JSON.parse(map);
  if (!isSourceMapInput(parsedMap)) {
    throw new Error('Expected a source map in Rollup format.');
  }
  return parsedMap;
}

function isSourceMapInput(value: unknown): value is SourceMapInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return (
    typeof Reflect.get(value, 'mappings') === 'string' &&
    typeof Reflect.get(value, 'version') === 'number' &&
    isStringArray(Reflect.get(value, 'names')) &&
    isStringArray(Reflect.get(value, 'sources')) &&
    isOptionalString(Reflect.get(value, 'file')) &&
    isOptionalString(Reflect.get(value, 'sourceRoot')) &&
    isOptionalStringArray(Reflect.get(value, 'sourcesContent')) &&
    isOptionalNumberArray(Reflect.get(value, 'x_google_ignoreList'))
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isOptionalNumberArray(value: unknown): value is number[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === 'number'))
  );
}

export interface MinifiedRendererChunk {
  code: string;
  map: SourceMapInput | null;
}

/** Minifies one rendered chunk with esbuild. */
export async function minifyRendererChunk(
  code: string,
  options: {
    fileName: string;
    format: 'es' | 'other';
    target: EsbuildTarget;
    sourcemap: boolean;
  },
): Promise<MinifiedRendererChunk> {
  const result = await transform(code, {
    ...RENDERER_CHUNK_MINIFY_OPTIONS,
    loader: 'js',
    charset: 'utf8',
    format: options.format === 'es' ? 'esm' : undefined,
    target: options.target,
    sourcefile: options.fileName,
    sourcemap: options.sourcemap ? 'external' : false,
  });
  return {
    code: result.code,
    map: result.map ? parseSourceMapInput(result.map) : null,
  };
}

function rendererMinifyPlugin(): Plugin {
  let sourcemapEnabled = false;
  let target: EsbuildTarget;
  let buildEvidence: string | undefined;

  return {
    name: 'canopy:renderer-minify',
    apply: 'build',
    configResolved(config): void {
      sourcemapEnabled = Boolean(config.build.sourcemap);
      target = esbuildTarget(config.build.target);
      const resolvedDefines = config.define ?? {};
      buildEvidence = undefined;
      const defines = [
        '__CANOPY_DESKTOP_SHARED_SIDEBAR__',
        '__CANOPY_DESKTOP_SIDEBAR_SHADOW__',
        '__CANOPY_E2E__',
      ];
      // Standalone minifier users need no product defines. Desktop builds
      // supply all three; never publish guessed defaults in release evidence.
      if (defines.some((key) => resolvedDefines[key] !== undefined)) {
        const values = defines.map((key) => {
          const value: unknown = resolvedDefines[key];
          if (value !== 'true' && value !== 'false') {
            throw new Error(`Expected a literal boolean build define: ${key}`);
          }
          return value === 'true';
        });
        buildEvidence = JSON.stringify({
          schemaVersion: 1,
          desktopSharedSidebar: values[0],
          desktopSidebarShadow: values[1],
          e2eCrossCheck: values[2],
        });
      }
    },
    renderChunk: {
      order: 'post',
      async handler(
        code,
        chunk,
        outputOptions,
      ): Promise<MinifiedRendererChunk | null> {
        if (!/\.m?js$/.test(chunk.fileName)) return null;
        const result = await minifyRendererChunk(code, {
          fileName: chunk.fileName,
          format: outputOptions.format === 'es' ? 'es' : 'other',
          target,
          sourcemap: sourcemapEnabled,
        });
        // Append after the final minifier, so identifier mangling and constant
        // folding cannot erase the evidence. Appending preserves map offsets.
        if (chunk.isEntry && buildEvidence) {
          result.code += `/* canopy-renderer-build-config:${buildEvidence} */\n`;
        }
        return result;
      },
    },
  };
}

/**
 * The renderer output plugins: a final per-chunk minification pass. Worker
 * bundles are separate Rollup builds and take their own instance.
 */
export function rendererOutputPlugins(): Plugin[] {
  return [rendererMinifyPlugin()];
}
