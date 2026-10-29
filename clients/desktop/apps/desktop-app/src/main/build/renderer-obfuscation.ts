import JavaScriptObfuscator from 'javascript-obfuscator';
import type { ObfuscatorOptions } from 'javascript-obfuscator';
import type { RenderedChunk, SourceMapInput } from 'rollup';
import type { Plugin } from 'vite';

/**
 * Keep release renderer code difficult to read without adding runtime decoding
 * and control-flow machinery to every first-party chunk. The disabled options
 * are the transforms that add startup work, repeated string decodes, or dead
 * branches to hot renderer paths; identifier mangling remains enabled.
 */
export const RENDERER_OBFUSCATION_OPTIONS: ObfuscatorOptions = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  debugProtectionInterval: 0,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: false,
  renameGlobals: false,
  reservedStrings: ['^\\./.*\\.js$'],
  selfDefending: false,
  simplify: true,
  splitStrings: false,
  stringArray: false,
  transformObjectKeys: false,
  target: 'browser',
  unicodeEscapeSequence: false,
};

export type RendererChunkMetadata = Pick<
  RenderedChunk,
  'facadeModuleId' | 'moduleIds' | 'name'
>;

function getRendererChunkModuleIds(chunk: RendererChunkMetadata): string[] {
  const moduleIds = [chunk.facadeModuleId, ...chunk.moduleIds].filter(
    (id): id is string => typeof id === 'string',
  );

  return moduleIds;
}

export function isDatadogRendererModule(id: string): boolean {
  return id.includes('/node_modules/@datadog/');
}

export function isRendererWorkerChunk(chunk: RendererChunkMetadata): boolean {
  const moduleIds = getRendererChunkModuleIds(chunk);

  return moduleIds.some(
    (id) =>
      // Vite's ?worker imports are renderer-side constructor or URL proxies.
      // Their presence must not exempt the importing application chunk. The
      // actual worker entry may instead carry ?worker_file metadata.
      !/[?&]worker(?:&|$)/.test(id) &&
      (id.includes('?worker') ||
        /[/\\][^/\\?]+\.worker(?:\.[^/\\?]+)?(?:\?|$)/.test(id)),
  );
}

export function shouldObfuscateRendererChunk(
  fileName: string,
  chunk: RendererChunkMetadata,
  options: { obfuscateVendor: boolean },
): boolean {
  if (options.obfuscateVendor) {
    return true;
  }

  const baseName = fileName.split('/').pop() ?? fileName;
  const isVendorChunk = chunk.name.startsWith('vendor-');
  const isDatadogChunk =
    chunk.name === 'datadog-sdk' ||
    chunk.name.startsWith('datadog-') ||
    getRendererChunkModuleIds(chunk).some(isDatadogRendererModule);
  return (
    !isVendorChunk &&
    !isRendererWorkerChunk(chunk) &&
    !baseName.includes('.worker-') &&
    !isDatadogChunk
  );
}

export interface RendererObfuscationSettings {
  /** `CANOPY_RENDERER_OBFUSCATION`; release builds keep it on. */
  enabled: boolean;
  /** `CANOPY_RENDERER_OBFUSCATE_VENDOR`; release builds keep it off. */
  obfuscateVendor: boolean;
}

/** Whether release processing obfuscates this chunk's identifiers. */
export function isObfuscatedRendererChunk(
  fileName: string,
  chunk: RendererChunkMetadata,
  settings: RendererObfuscationSettings,
): boolean {
  return (
    settings.enabled &&
    fileName.endsWith('.js') &&
    shouldObfuscateRendererChunk(fileName, chunk, {
      obfuscateVendor: settings.obfuscateVendor,
    })
  );
}

export function parseSourceMapInput(map: string): SourceMapInput {
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

/**
 * Mangles first-party renderer chunks with {@link RENDERER_OBFUSCATION_OPTIONS}.
 * Vendor, worker and Datadog chunks are left alone unless vendor obfuscation
 * is enabled.
 */
export function rendererObfuscationPlugin(
  settings: RendererObfuscationSettings,
): Plugin {
  let sourcemapEnabled = false;

  return {
    name: 'canopy:renderer-obfuscation',
    apply: 'build',
    enforce: 'post',
    configResolved(config): void {
      sourcemapEnabled = Boolean(config.build.sourcemap);
    },
    renderChunk(code, chunk): { code: string; map?: SourceMapInput } | null {
      if (!isObfuscatedRendererChunk(chunk.fileName, chunk, settings)) {
        return null;
      }

      const result = JavaScriptObfuscator.obfuscate(code, {
        ...RENDERER_OBFUSCATION_OPTIONS,
        inputFileName: chunk.fileName,
        sourceMap: sourcemapEnabled,
        sourceMapMode: 'separate',
        sourceMapSourcesMode: 'sources-content',
      });

      const map = sourcemapEnabled ? result.getSourceMap() : '';
      return {
        code: result.getObfuscatedCode(),
        map: map ? parseSourceMapInput(map) : undefined,
      };
    },
  };
}
