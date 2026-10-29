import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { builtinModules } from 'node:module';
import { z } from 'zod';
import * as path from 'node:path';
import type { CompilerOptions } from 'typescript';
import type * as TsModule from 'typescript';
import { loadRequiredNodeModule } from '../../lib/packaged-module-loader';
import { canonicalRelativePath } from '../ids';
import {
  canonicalResolutionDependencyJson,
  resolutionDependencyKey,
} from './resolution-dependency-capture';
import type {
  ResolutionDependencyCapture,
  ResolutionDependencyJson,
  ResolutionDependencyObservation,
} from './resolution-dependency-capture';

// `typescript` MUST stay an esbuild `external` in the SEA CLI build (see
// scripts/build-cli.mjs), for the same reason as `web-tree-sitter`
// (packages/desktop-shared/src/node/code-graph/parser/runtime.ts): a Node
// single-executable application's main-script `require()` only resolves
// Node built-ins, so a plain `import * as ts from 'typescript'` (which
// compiles to a bare `require('typescript')` call) throws
// `ERR_UNKNOWN_BUILTIN_MODULE` — confirmed empirically against a built SEA
// binary. `loadRequiredNodeModule` uses `createRequire(__filename)`, which
// Node resolves relative to `process.execPath` inside a SEA main script,
// walking real node_modules resolution from the binary's own directory —
// exactly where `scripts/build-cli.mjs` stages a real
// `node_modules/typescript` alongside every built CLI binary. `CompilerOptions`
// is a type-only export (an interface, not a runtime value) so it stays a
// normal `import type` — that never emits a runtime require call.
function isTsModule(value: unknown): value is typeof TsModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'resolveModuleName' in value &&
    'sys' in value &&
    'ModuleResolutionKind' in value
  );
}

// Loaded lazily on first resolver use (not at module evaluation) so importing
// this module — and, transitively, the code-graph engine/service from Electron
// main's boot path — never pulls the TypeScript compiler into memory until a
// build actually resolves imports. The compiler is ~18MB of heap and ~90ms of
// CPU to evaluate; deferring it keeps main-process startup cheap. The result
// is memoized, so repeated calls after the first are free.
let cachedTs: typeof TsModule | null = null;

function getTs(): typeof TsModule {
  if (cachedTs === null) {
    cachedTs = loadRequiredNodeModule<typeof TsModule>({
      moduleId: 'typescript',
      requireFrom: __filename,
      validate: isTsModule,
    });
  }
  return cachedTs;
}

// Also lazy: it references `ts.ModuleResolutionKind`, so building it at module
// load would defeat the deferral above. Memoized after the first construction.
let cachedDefaultOptions: CompilerOptions | null = null;

function getDefaultOptions(): CompilerOptions {
  if (cachedDefaultOptions === null) {
    const ts = getTs();
    cachedDefaultOptions = {
      allowJs: true,
      checkJs: false,
      resolveJsonModule: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
  }
  return cachedDefaultOptions;
}

export function resolutionInputHash(source: string | undefined): string | null {
  return source === undefined
    ? null
    : createHash('sha256').update(source).digest('hex');
}

export type TsModuleResolution =
  | { kind: 'local'; absolutePath: string }
  | { kind: 'external' }
  | { kind: 'unresolved' };

const NODE_BUILTINS = new Set(
  builtinModules.flatMap((moduleId) => [
    moduleId,
    moduleId.startsWith('node:') ? moduleId.slice(5) : `node:${moduleId}`,
  ]),
);

const FILE_EXISTS_PREFIX = 'file-exists:';
const DIRECTORY_EXISTS_PREFIX = 'directory-exists:';
const EXISTS_FINGERPRINT = 'exists';
const DEFAULT_COMPILER_OPTIONS_KEY = '<default>';
export const CAPTURED_HOST_OPERATION_PREFIX = 'captured-host-operation-v1:';
const CAPTURED_HOST_OPERATION_FAMILY_PREFIX = 'captured-host-operation-';

export type ResolutionInputHostOperation =
  | {
      operation: 'readDirectory';
      root: string;
      extensions: readonly string[] | null;
      excludes: readonly string[] | null;
      includes: readonly string[] | null;
      depth: number | null;
    }
  | { operation: 'getDirectories'; path: string }
  | { operation: 'realpath'; path: string }
  | { operation: 'currentDirectory' }
  | { operation: 'executingFilePath' }
  | { operation: 'compilerHost' };

function normalizeHostOperation(
  operation: ResolutionInputHostOperation,
): ResolutionInputHostOperation {
  switch (operation.operation) {
    case 'readDirectory':
      return {
        operation: operation.operation,
        root: canonicalRelativePath(operation.root),
        extensions:
          operation.extensions === null ? null : [...operation.extensions],
        excludes: operation.excludes === null ? null : [...operation.excludes],
        includes: operation.includes === null ? null : [...operation.includes],
        depth: operation.depth,
      };
    case 'getDirectories':
    case 'realpath':
      return {
        operation: operation.operation,
        path: canonicalRelativePath(operation.path),
      };
    case 'currentDirectory':
    case 'executingFilePath':
    case 'compilerHost':
      return { operation: operation.operation };
  }
}

/** Stable key for the extra host-operation fingerprints in resolution_inputs. */
export function resolutionInputHostOperationKey(
  operation: ResolutionInputHostOperation,
): string {
  const normalized = normalizeHostOperation(operation);
  return `${CAPTURED_HOST_OPERATION_PREFIX}${encodeURIComponent(
    JSON.stringify(normalized),
  )}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOptionalStringArray(
  value: unknown,
): readonly string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    strings.push(item);
  }
  return strings;
}

function canonicalParsedHostOperation(
  operation: ResolutionInputHostOperation,
  originalKey: string,
): ResolutionInputHostOperation | null {
  const normalized = normalizeHostOperation(operation);
  return resolutionInputHostOperationKey(normalized) === originalKey
    ? normalized
    : null;
}

function parseHostOperation(key: string): ResolutionInputHostOperation | null {
  if (!key.startsWith(CAPTURED_HOST_OPERATION_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      decodeURIComponent(key.slice(CAPTURED_HOST_OPERATION_PREFIX.length)),
    );
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.operation !== 'string') return null;
  if (parsed.operation === 'readDirectory') {
    const root = parsed.root;
    const extensions = parseOptionalStringArray(parsed.extensions);
    const excludes = parseOptionalStringArray(parsed.excludes);
    const includes = parseOptionalStringArray(parsed.includes);
    const depth = parsed.depth;
    if (
      typeof root !== 'string' ||
      extensions === undefined ||
      excludes === undefined ||
      includes === undefined ||
      (typeof depth !== 'number' && depth !== null)
    ) {
      return null;
    }
    return canonicalParsedHostOperation(
      {
        operation: 'readDirectory',
        root,
        extensions,
        excludes,
        includes,
        depth,
      },
      key,
    );
  }
  if (
    parsed.operation === 'getDirectories' ||
    parsed.operation === 'realpath'
  ) {
    if (typeof parsed.path !== 'string') return null;
    return canonicalParsedHostOperation(
      { operation: parsed.operation, path: parsed.path },
      key,
    );
  }
  if (
    parsed.operation === 'currentDirectory' ||
    parsed.operation === 'executingFilePath' ||
    parsed.operation === 'compilerHost'
  ) {
    return canonicalParsedHostOperation({ operation: parsed.operation }, key);
  }
  return null;
}

function hashHostOperationValue(value: ResolutionDependencyJson): string {
  return createHash('sha256')
    .update(canonicalResolutionDependencyJson(value))
    .digest('hex');
}

function hostOperationValue(
  rootPath: string,
  operation: ResolutionInputHostOperation,
): ResolutionDependencyJson | null {
  const ts = getTs();
  switch (operation.operation) {
    case 'readDirectory': {
      const readDirectory = ts.sys.readDirectory?.bind(ts.sys);
      if (readDirectory === undefined) return null;
      return readDirectory(
        path.resolve(rootPath, operation.root),
        operation.extensions === null ? undefined : [...operation.extensions],
        operation.excludes === null ? undefined : [...operation.excludes],
        operation.includes === null ? undefined : [...operation.includes],
        operation.depth ?? undefined,
      ).map((candidate) =>
        canonicalRelativePath(path.relative(rootPath, candidate)),
      );
    }
    case 'getDirectories': {
      const getDirectories = ts.sys.getDirectories?.bind(ts.sys);
      if (getDirectories === undefined) return null;
      return getDirectories(path.resolve(rootPath, operation.path)).map(
        (candidate) =>
          canonicalRelativePath(path.relative(rootPath, candidate)),
      );
    }
    case 'realpath': {
      const realpath = ts.sys.realpath?.bind(ts.sys);
      if (realpath === undefined) return null;
      return canonicalRelativePath(
        path.relative(
          rootPath,
          realpath(path.resolve(rootPath, operation.path)),
        ),
      );
    }
    case 'currentDirectory': {
      const getCurrentDirectory = ts.sys.getCurrentDirectory?.bind(ts.sys);
      if (getCurrentDirectory === undefined) return null;
      return canonicalRelativePath(
        path.relative(rootPath, getCurrentDirectory()),
      );
    }
    case 'executingFilePath': {
      const getExecutingFilePath = ts.sys.getExecutingFilePath?.bind(ts.sys);
      if (getExecutingFilePath === undefined) return null;
      return canonicalRelativePath(
        path.relative(rootPath, getExecutingFilePath()),
      );
    }
    case 'compilerHost':
      if (
        typeof ts.version !== 'string' ||
        typeof ts.sys.useCaseSensitiveFileNames !== 'boolean' ||
        typeof ts.sys.newLine !== 'string'
      ) {
        return null;
      }
      return {
        typescriptVersion: ts.version,
        useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
        newLine: ts.sys.newLine,
      };
  }
}

async function currentResolutionInputFingerprint(
  rootPath: string,
  key: string,
): Promise<string | null> {
  if (key.startsWith(CAPTURED_HOST_OPERATION_FAMILY_PREFIX)) {
    const operation = parseHostOperation(key);
    if (operation === null) return null;
    try {
      const value = hostOperationValue(rootPath, operation);
      return value === null ? null : hashHostOperationValue(value);
    } catch {
      return null;
    }
  }
  if (
    key.startsWith(FILE_EXISTS_PREFIX) ||
    key.startsWith(DIRECTORY_EXISTS_PREFIX)
  ) {
    const directory = key.startsWith(DIRECTORY_EXISTS_PREFIX);
    const prefix = directory ? DIRECTORY_EXISTS_PREFIX : FILE_EXISTS_PREFIX;
    try {
      const stats = await fs.stat(
        path.resolve(rootPath, key.slice(prefix.length)),
      );
      return (directory ? stats.isDirectory() : stats.isFile())
        ? EXISTS_FINGERPRINT
        : null;
    } catch {
      return null;
    }
  }
  let source: string | undefined;
  try {
    source = await fs.readFile(path.resolve(rootPath, key), 'utf8');
  } catch {
    source = undefined;
  }
  return resolutionInputHash(source);
}

/** Config inheritance and package maps can live outside the indexed corpus. */
export async function resolutionInputsChanged(
  rootPath: string,
  saved: string | null,
): Promise<boolean> {
  if (saved === null) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(saved);
  } catch {
    return true;
  }
  const inputs = z.record(z.string(), z.string().nullable()).safeParse(parsed);
  if (!inputs.success) return true;
  for (const [key, expected] of Object.entries(inputs.data)) {
    const current = await currentResolutionInputFingerprint(rootPath, key);
    if (
      (key.startsWith(CAPTURED_HOST_OPERATION_FAMILY_PREFIX) &&
        (typeof expected !== 'string' || current === null)) ||
      current !== expected
    )
      return true;
  }
  return false;
}

/** How many `..` steps lead from `rootPath` up to its filesystem root. */
export function resolutionRootDepth(
  rootPath: string,
  pathModule: Pick<typeof path, 'resolve' | 'parse'> = path,
): number {
  const resolved = pathModule.resolve(rootPath);
  // The root itself (`/`, `C:\`, `\\server\share\`) is not a step.
  return resolved
    .slice(pathModule.parse(resolved).root.length)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0).length;
}

function relativeProbePath(key: string): string {
  return key.startsWith(FILE_EXISTS_PREFIX)
    ? key.slice(FILE_EXISTS_PREFIX.length)
    : key.startsWith(DIRECTORY_EXISTS_PREFIX)
      ? key.slice(DIRECTORY_EXISTS_PREFIX.length)
      : key;
}

/** Leading `..` segments of a recorded probe, and what follows them. */
function splitProbe(key: string): { ups: number; suffix: string[] } {
  const segments = relativeProbePath(key)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
  let ups = 0;
  while (segments[ups] === '..') ups += 1;
  return { ups, suffix: segments.slice(ups) };
}

/**
 * Whether resolution inputs recorded for a repository at `recordedRootPath`
 * can be validated by {@link resolutionInputsChanged} at `rootPath`, a copy
 * of that repository elsewhere (seeding a worktree from a published base).
 *
 * Keys are recorded relative to the root. Probes inside the root map to the
 * same files at any location. Probes that escape it (`../tsconfig.json`,
 * `../node_modules`) walk ancestors, at most up to the filesystem root.
 *
 * - At the same or a shallower depth, every ancestor the resolver could
 *   probe is reached by a recorded key (keys past the filesystem root clamp
 *   to it), so validating the keys there is enough.
 * - A deeper root has ancestors above the recorded walk's end. A walk that
 *   stopped below the old filesystem root (it found its target) stops at the
 *   same validated key at the new root. A walk that reached the old
 *   filesystem root would continue into the extra ancestors, so it is
 *   transferable only if none of its probes exists there: the resolver then
 *   finds nothing more, as it found nothing more before. Anything present
 *   there could change resolution, so the inputs are not transferred.
 *
 * Unreadable fingerprints are never transferable.
 */
export function resolutionInputsTransferable(
  saved: string,
  recordedRootPath: string,
  rootPath: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(saved);
  } catch {
    return false;
  }
  const inputs = z.record(z.string(), z.string().nullable()).safeParse(parsed);
  if (!inputs.success) return false;
  const capturedHostOperationKeys = Object.keys(inputs.data).filter((key) =>
    key.startsWith(CAPTURED_HOST_OPERATION_FAMILY_PREFIX),
  );
  if (
    capturedHostOperationKeys.some(
      (key) =>
        parseHostOperation(key) === null || recordedRootPath !== rootPath,
    )
  ) {
    return false;
  }
  const recordedDepth = resolutionRootDepth(recordedRootPath);
  const depth = resolutionRootDepth(rootPath);
  if (depth <= recordedDepth) return true;
  for (const key of Object.keys(inputs.data)) {
    const { ups, suffix } = splitProbe(key);
    if (ups === 0 || ups < recordedDepth) continue;
    for (let level = recordedDepth + 1; level <= depth; level += 1) {
      const probe = path.resolve(
        rootPath,
        ...Array.from({ length: level }, () => '..'),
        ...suffix,
      );
      if (existsSync(probe)) return false;
    }
  }
  return true;
}

export class TsModuleResolver {
  private readonly optionsByConfigPath = new Map<string, CompilerOptions>();
  private readonly configPathByDir = new Map<string, string | null>();
  private readonly configSearchObservationsByDir = new Map<
    string,
    readonly ResolutionDependencyObservation[]
  >();
  private readonly optionsObservationsByConfigPath = new Map<
    string,
    readonly ResolutionDependencyObservation[]
  >();

  private readonly inputFingerprints = new Map<string, string | null>();
  public constructor(
    private readonly rootPath: string,
    private readonly capture?: ResolutionDependencyCapture,
  ) {}

  private relativePath(absolutePath: string): string {
    return canonicalRelativePath(path.relative(this.rootPath, absolutePath));
  }

  public getInputFingerprints(): Record<string, string | null> {
    return Object.fromEntries(
      Array.from(this.inputFingerprints).sort(([a], [b]) => a.localeCompare(b)),
    );
  }

  private readInput = (absolutePath: string): string | undefined => {
    const source = getTs().sys.readFile(absolutePath);
    const legacyRelativePath = path.relative(this.rootPath, absolutePath);
    const relativePath = this.relativePath(absolutePath);
    this.inputFingerprints.set(legacyRelativePath, resolutionInputHash(source));
    this.capture?.observeIfScoped(
      resolutionDependencyKey.tsReadInput(relativePath),
      resolutionInputHash(source),
    );
    return source;
  };

  private fileExists = (absolutePath: string): boolean => {
    const exists = getTs().sys.fileExists(absolutePath);
    const legacyRelativePath = path.relative(this.rootPath, absolutePath);
    const relativePath = this.relativePath(absolutePath);
    this.inputFingerprints.set(
      `${FILE_EXISTS_PREFIX}${legacyRelativePath}`,
      exists ? EXISTS_FINGERPRINT : null,
    );
    this.capture?.observeIfScoped(
      resolutionDependencyKey.tsFileExists(relativePath),
      exists,
    );
    return exists;
  };

  private directoryExists = (absolutePath: string): boolean => {
    const sys = getTs().sys;
    const directoryExists = sys.directoryExists?.bind(sys);
    if (directoryExists === undefined) {
      this.capture?.markIncompleteForCurrent(
        'typescript-directoryExists-unavailable',
      );
    }
    const exists = directoryExists?.(absolutePath) ?? false;
    const legacyRelativePath = path.relative(this.rootPath, absolutePath);
    const relativePath = this.relativePath(absolutePath);
    this.inputFingerprints.set(
      `${DIRECTORY_EXISTS_PREFIX}${legacyRelativePath}`,
      exists ? EXISTS_FINGERPRINT : null,
    );
    this.capture?.observeIfScoped(
      resolutionDependencyKey.tsDirectoryExists(relativePath),
      exists,
    );
    return exists;
  };

  private recordHostOperation(
    operation: ResolutionInputHostOperation,
    value: ResolutionDependencyJson,
  ): void {
    if (this.capture === undefined) return;
    this.inputFingerprints.set(
      resolutionInputHostOperationKey(operation),
      hashHostOperationValue(value),
    );
  }

  private systemHost(): typeof TsModule.sys {
    const ts = getTs();
    if (this.capture === undefined) {
      // Preserve the legacy host object and resolution_inputs behavior exactly
      // when dependency capture is disabled.
      return {
        ...ts.sys,
        readFile: this.readInput,
        fileExists: this.fileExists,
        directoryExists: this.directoryExists,
      };
    }
    const readDirectory = ts.sys.readDirectory?.bind(ts.sys);
    const readDirectoryOverride: Partial<typeof TsModule.sys> =
      readDirectory === undefined
        ? {}
        : {
            readDirectory: (
              root,
              extensions,
              excludes,
              includes,
              depth,
            ): string[] => {
              const result = readDirectory(
                root,
                extensions,
                excludes,
                includes,
                depth,
              );
              const relativeResult = result.map((candidate) =>
                this.relativePath(candidate),
              );
              const operation: ResolutionInputHostOperation = {
                operation: 'readDirectory',
                root: this.relativePath(root),
                extensions: extensions ?? null,
                excludes: excludes ?? null,
                includes: includes ?? null,
                depth: depth ?? null,
              };
              this.recordHostOperation(operation, relativeResult);
              this.capture?.observeIfScoped(
                resolutionDependencyKey.tsReadDirectory(operation),
                relativeResult,
              );
              return result;
            },
          };
    const getDirectories = ts.sys.getDirectories?.bind(ts.sys);
    const getDirectoriesOverride: Partial<typeof TsModule.sys> =
      getDirectories === undefined
        ? {}
        : {
            getDirectories: (absolutePath): string[] => {
              const result = getDirectories(absolutePath);
              const relativeResult = result.map((candidate) =>
                this.relativePath(candidate),
              );
              const operation: ResolutionInputHostOperation = {
                operation: 'getDirectories',
                path: this.relativePath(absolutePath),
              };
              this.recordHostOperation(operation, relativeResult);
              this.capture?.observeIfScoped(
                resolutionDependencyKey.tsGetDirectories(operation.path),
                relativeResult,
              );
              return result;
            },
          };
    const realpath = ts.sys.realpath?.bind(ts.sys);
    const realpathOverride: Partial<typeof TsModule.sys> =
      realpath === undefined
        ? {}
        : {
            realpath: (absolutePath): string => {
              const result = realpath(absolutePath);
              const relativeResult = this.relativePath(result);
              const operation: ResolutionInputHostOperation = {
                operation: 'realpath',
                path: this.relativePath(absolutePath),
              };
              this.recordHostOperation(operation, relativeResult);
              this.capture?.observeIfScoped(
                resolutionDependencyKey.tsRealpath(operation.path),
                relativeResult,
              );
              return result;
            },
          };
    const getCurrentDirectory = ts.sys.getCurrentDirectory?.bind(ts.sys);
    const currentDirectoryOverride: Partial<typeof TsModule.sys> =
      getCurrentDirectory === undefined
        ? {}
        : {
            getCurrentDirectory: (): string => {
              const result = getCurrentDirectory();
              const relativeResult = this.relativePath(result);
              this.recordHostOperation(
                { operation: 'currentDirectory' },
                relativeResult,
              );
              this.capture?.observeIfScoped(
                resolutionDependencyKey.tsCurrentDirectory(),
                relativeResult,
              );
              return result;
            },
          };
    const getExecutingFilePath = ts.sys.getExecutingFilePath?.bind(ts.sys);
    const executingFileOverride: Partial<typeof TsModule.sys> =
      getExecutingFilePath === undefined
        ? {}
        : {
            getExecutingFilePath: (): string => {
              const result = getExecutingFilePath();
              const relativeResult = this.relativePath(result);
              this.recordHostOperation(
                { operation: 'executingFilePath' },
                relativeResult,
              );
              this.capture?.observeIfScoped(
                resolutionDependencyKey.tsExecutingFile(),
                relativeResult,
              );
              return result;
            },
          };
    if (readDirectory === undefined) {
      this.capture?.markIncompleteForCurrent(
        'typescript-readDirectory-unavailable',
      );
    }
    if (getDirectories === undefined) {
      this.capture?.markIncompleteForCurrent(
        'typescript-getDirectories-unavailable',
      );
    }
    if (realpath === undefined) {
      this.capture?.markIncompleteForCurrent('typescript-realpath-unavailable');
    }
    if (getCurrentDirectory === undefined) {
      this.capture?.markIncompleteForCurrent(
        'typescript-current-directory-unavailable',
      );
    }
    if (getExecutingFilePath === undefined) {
      this.capture?.markIncompleteForCurrent(
        'typescript-executing-file-unavailable',
      );
    }
    if (
      typeof ts.version === 'string' &&
      typeof ts.sys.useCaseSensitiveFileNames === 'boolean' &&
      typeof ts.sys.newLine === 'string'
    ) {
      const compilerHost = {
        typescriptVersion: ts.version,
        useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
        newLine: ts.sys.newLine,
      };
      this.recordHostOperation({ operation: 'compilerHost' }, compilerHost);
      this.capture.observeIfScoped(
        resolutionDependencyKey.compilerOptions('<typescript-host>'),
        compilerHost,
      );
    } else {
      this.capture.markIncompleteForCurrent(
        'typescript-host-identity-unavailable',
      );
    }
    const host: typeof TsModule.sys = {
      ...ts.sys,
      ...readDirectoryOverride,
      ...getDirectoriesOverride,
      ...realpathOverride,
      ...currentDirectoryOverride,
      ...executingFileOverride,
      readFile: (absolutePath) => this.readInput(absolutePath),
      fileExists: (absolutePath) => this.fileExists(absolutePath),
      directoryExists: (absolutePath) => this.directoryExists(absolutePath),
    };
    const observedCallbacks = new Set([
      'readFile',
      'fileExists',
      'directoryExists',
      'readDirectory',
      'getDirectories',
      'realpath',
      'getCurrentDirectory',
      'getExecutingFilePath',
    ]);
    return new Proxy(host, {
      get: (target, property, receiver): unknown => {
        const value: unknown = Reflect.get(target, property, receiver);
        if (
          typeof property === 'string' &&
          typeof value === 'function' &&
          !observedCallbacks.has(property)
        ) {
          this.capture?.markIncompleteForCurrent(
            `typescript-unobserved-host-callback:${property}`,
          );
        }
        return value;
      },
    });
  }

  public resolveSpecifier(
    specifier: string,
    containingAbsolutePath: string,
    sourceFileId?: string,
  ): string | null {
    const resolution = this.resolveSpecifierWithKind(
      specifier,
      containingAbsolutePath,
      sourceFileId,
    );
    return resolution.kind === 'local' ? resolution.absolutePath : null;
  }

  public resolveSpecifierWithKind(
    specifier: string,
    containingAbsolutePath: string,
    sourceFileId?: string,
  ): TsModuleResolution {
    if (NODE_BUILTINS.has(specifier)) {
      const external: TsModuleResolution = { kind: 'external' };
      this.observeSpecifierResult(specifier, sourceFileId, external);
      return external;
    }
    const ts = getTs();
    const options = this.optionsFor(containingAbsolutePath);
    const result = ts.resolveModuleName(
      specifier,
      containingAbsolutePath,
      options,
      this.systemHost(),
    );
    const resolved = result.resolvedModule;
    if (resolved === undefined) {
      const unresolved: TsModuleResolution = { kind: 'unresolved' };
      this.observeSpecifierResult(specifier, sourceFileId, unresolved);
      return unresolved;
    }
    if (
      resolved.isExternalLibraryImport === true ||
      resolved.resolvedFileName.includes('node_modules')
    ) {
      const external: TsModuleResolution = { kind: 'external' };
      this.observeSpecifierResult(specifier, sourceFileId, external);
      return external;
    }
    const local: TsModuleResolution = {
      kind: 'local',
      absolutePath: path.resolve(resolved.resolvedFileName),
    };
    this.observeSpecifierResult(specifier, sourceFileId, local);
    return local;
  }

  private observeSpecifierResult(
    specifier: string,
    sourceFileId: string | undefined,
    result: TsModuleResolution,
  ): void {
    const capture = this.capture;
    if (capture === undefined) return;
    if (sourceFileId === undefined) {
      capture.markIncompleteForCurrent('typescript-missing-source-file-id');
      return;
    }
    if (result.kind === 'local') {
      const relativePath = this.relativePath(result.absolutePath);
      capture.observe(
        resolutionDependencyKey.moduleSpecifier(sourceFileId, specifier),
        { kind: result.kind, relativePath },
      );
      // The import pass records the graph candidate under moduleCandidate.
      // Physical resolution is already captured by moduleSpecifier and the
      // host probes; mixing a physical boolean with that graph lookup would
      // create conflicting values for the same source dependency key.
      return;
    }
    capture.observe(
      resolutionDependencyKey.moduleSpecifier(sourceFileId, specifier),
      { kind: result.kind },
    );
  }

  private replayCachedObservations(
    cache: ReadonlyMap<string, readonly ResolutionDependencyObservation[]>,
    cacheKey: string,
    reason: string,
  ): void {
    const capture = this.capture;
    if (capture === undefined) return;
    const observations = cache.get(cacheKey);
    if (observations === undefined) {
      capture.markIncompleteForCurrent(reason);
      return;
    }
    capture.replay(observations);
  }

  private optionsFor(containingAbsolutePath: string): CompilerOptions {
    const ts = getTs();
    const dir = path.dirname(containingAbsolutePath);
    let configPath: string | null;
    if (!this.configPathByDir.has(dir)) {
      const checkpoint = this.capture?.checkpoint();
      configPath =
        ts.findConfigFile(dir, this.fileExists, 'tsconfig.json') ?? null;
      this.configPathByDir.set(dir, configPath);
      if (this.capture !== undefined && checkpoint !== undefined) {
        this.configSearchObservationsByDir.set(
          dir,
          this.capture.observationsSince(checkpoint),
        );
      }
    } else {
      configPath = this.configPathByDir.get(dir) ?? null;
      this.replayCachedObservations(
        this.configSearchObservationsByDir,
        dir,
        'typescript-config-search-cache-without-observations',
      );
    }
    if (
      configPath === null ||
      !path.resolve(configPath).startsWith(path.resolve(this.rootPath))
    ) {
      const fallback = getDefaultOptions();
      this.capture?.observeUnknown(
        resolutionDependencyKey.compilerOptions(DEFAULT_COMPILER_OPTIONS_KEY),
        fallback,
      );
      return fallback;
    }
    const cached = this.optionsByConfigPath.get(configPath);
    if (cached !== undefined) {
      this.replayCachedObservations(
        this.optionsObservationsByConfigPath,
        configPath,
        'typescript-options-cache-without-observations',
      );
      return cached;
    }
    const checkpoint = this.capture?.checkpoint();
    const readResult = ts.readConfigFile(configPath, (candidate) =>
      this.readInput(candidate),
    );
    if (readResult.error !== undefined || readResult.config === undefined) {
      const fallback = getDefaultOptions();
      this.optionsByConfigPath.set(configPath, fallback);
      this.capture?.observeUnknown(
        resolutionDependencyKey.compilerOptions(this.relativePath(configPath)),
        fallback,
      );
      if (this.capture !== undefined && checkpoint !== undefined) {
        this.optionsObservationsByConfigPath.set(
          configPath,
          this.capture.observationsSince(checkpoint),
        );
      }
      return fallback;
    }
    const parsed = ts.parseJsonConfigFileContent(
      readResult.config,
      this.systemHost(),
      path.dirname(configPath),
    );
    const options: CompilerOptions = {
      ...getDefaultOptions(),
      ...parsed.options,
    };
    this.optionsByConfigPath.set(configPath, options);
    this.capture?.observeUnknown(
      resolutionDependencyKey.compilerOptions(this.relativePath(configPath)),
      options,
    );
    if (this.capture !== undefined && checkpoint !== undefined) {
      this.optionsObservationsByConfigPath.set(
        configPath,
        this.capture.observationsSince(checkpoint),
      );
    }
    return options;
  }
}
