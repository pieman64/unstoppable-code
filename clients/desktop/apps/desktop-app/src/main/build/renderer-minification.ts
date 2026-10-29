import { transform, type TransformOptions } from 'esbuild';
import type { SourceMapInput } from 'rollup';
import type { Plugin } from 'vite';
import {
  isObfuscatedRendererChunk,
  parseSourceMapInput,
  rendererObfuscationPlugin,
  type RendererObfuscationSettings,
} from './renderer-obfuscation';

/**
 * Release minification for renderer chunks.
 *
 * The obfuscator emits compact output, but Vite's own `vite:esbuild-transpile`
 * `renderChunk` runs after every user plugin, `enforce: 'post'` included.
 * With a Chrome `build.target` and `build.minify: false` (electron-vite's
 * renderer default), it re-printed every chunk in esbuild's readable,
 * indented form, so the compact output never reached disk.
 *
 * This pass runs last (`order: 'post'`):
 * - obfuscated chunks get whitespace removal only, so their identifiers and
 *   syntax stay exactly what the obfuscator produced;
 * - every other chunk (vendor, Datadog, workers, or everything when
 *   obfuscation is off) gets the full esbuild minification Vite applies with
 *   `build.minify: 'esbuild'`.
 */
export function rendererChunkMinifyOptions(
  obfuscated: boolean,
): TransformOptions {
  return obfuscated
    ? { minifyWhitespace: true, treeShaking: false }
    : { minify: true, treeShaking: true };
}

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

export interface MinifiedRendererChunk {
  code: string;
  map: SourceMapInput | null;
}

/** Minifies one rendered chunk with {@link rendererChunkMinifyOptions}. */
export async function minifyRendererChunk(
  code: string,
  options: {
    fileName: string;
    obfuscated: boolean;
    format: 'es' | 'other';
    target: EsbuildTarget;
    sourcemap: boolean;
  },
): Promise<MinifiedRendererChunk> {
  const result = await transform(code, {
    ...rendererChunkMinifyOptions(options.obfuscated),
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

export function rendererMinifyPlugin(
  settings: RendererObfuscationSettings,
): Plugin {
  let sourcemapEnabled = false;
  let target: EsbuildTarget;

  return {
    name: 'canopy:renderer-minify',
    apply: 'build',
    configResolved(config): void {
      sourcemapEnabled = Boolean(config.build.sourcemap);
      target = esbuildTarget(config.build.target);
    },
    renderChunk: {
      order: 'post',
      async handler(
        code,
        chunk,
        outputOptions,
      ): Promise<MinifiedRendererChunk | null> {
        if (!/\.m?js$/.test(chunk.fileName)) return null;
        return minifyRendererChunk(code, {
          fileName: chunk.fileName,
          obfuscated: isObfuscatedRendererChunk(
            chunk.fileName,
            chunk,
            settings,
          ),
          format: outputOptions.format === 'es' ? 'es' : 'other',
          target,
          sourcemap: sourcemapEnabled,
        });
      },
    },
  };
}

/** The renderer output plugins, in order: obfuscation, then minification. */
export function rendererOutputPlugins(
  settings: RendererObfuscationSettings,
): Plugin[] {
  return [rendererObfuscationPlugin(settings), rendererMinifyPlugin(settings)];
}

/**
 * Worker bundles are separate Rollup builds that never obfuscate, so they
 * only need the minification pass.
 */
export function rendererWorkerOutputPlugins(): Plugin[] {
  return [rendererMinifyPlugin({ enabled: false, obfuscateVendor: false })];
}
