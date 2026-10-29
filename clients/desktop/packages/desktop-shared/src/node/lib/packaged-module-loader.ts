import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

type ModuleExportName = string | number | symbol;

interface NodeModuleFileCandidatesOptions {
  packageName: string;
  packageRelativePath?: string | string[];
  fromDir?: string;
  ancestorDepths?: number[];
  cwd?: string;
  resourcesPath?: string;
}

interface LoadRequiredNodeModuleExportOptionsBase {
  moduleId: string;
  exportName: ModuleExportName;
  requireFrom: string;
}

interface LoadValidatedNodeModuleExportOptions<
  T,
> extends LoadRequiredNodeModuleExportOptionsBase {
  validate: (value: unknown) => value is T;
}

interface LoadUnvalidatedNodeModuleExportOptions extends LoadRequiredNodeModuleExportOptionsBase {
  validate?: undefined;
}

interface LoadRequiredNodeModuleOptionsBase {
  moduleId: string;
  requireFrom: string;
}

interface LoadValidatedNodeModuleOptions<
  T,
> extends LoadRequiredNodeModuleOptionsBase {
  validate: (value: unknown) => value is T;
}

interface LoadUnvalidatedNodeModuleOptions extends LoadRequiredNodeModuleOptionsBase {
  validate?: undefined;
}

export function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

function toPathParts(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : value.split(/[\\/]/).filter(Boolean);
}

function getPackagePathParts(
  packageName: string,
  packageRelativePath: string | string[] | undefined,
): string[] {
  return [
    'node_modules',
    ...packageName.split('/').filter(Boolean),
    ...toPathParts(packageRelativePath),
  ];
}

export function getNodeModuleFileCandidates({
  packageName,
  packageRelativePath,
  fromDir,
  ancestorDepths = [],
  cwd = process.cwd(),
  resourcesPath = process.resourcesPath,
}: NodeModuleFileCandidatesOptions): string[] {
  const packagePathParts = getPackagePathParts(
    packageName,
    packageRelativePath,
  );
  const ancestorCandidates =
    fromDir != null
      ? ancestorDepths.map((depth) =>
          path.resolve(
            fromDir,
            ...Array.from({ length: depth }, () => '..'),
            ...packagePathParts,
          ),
        )
      : [];
  const packagedResourceCandidates =
    typeof resourcesPath === 'string'
      ? [
          path.join(resourcesPath, 'app.asar', ...packagePathParts),
          path.join(resourcesPath, 'app', ...packagePathParts),
        ]
      : [];

  return uniquePaths([
    path.join(cwd, ...packagePathParts),
    ...ancestorCandidates,
    ...packagedResourceCandidates,
  ]);
}

export function findFirstExistingPath(candidates: string[]): string | null {
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function formatMissingNodeModuleFileError(
  packageName: string,
  packageRelativePath: string | string[],
  candidates: string[],
): string {
  const relativePath = toPathParts(packageRelativePath).join('/');
  const modulePath = relativePath
    ? `${packageName}/${relativePath}`
    : packageName;
  return `Unable to locate ${modulePath}. Checked: ${candidates.join(', ')}`;
}

function hasModuleExport(
  value: unknown,
  exportName: ModuleExportName,
): value is Record<ModuleExportName, unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, exportName)
  );
}

export function loadRequiredNodeModuleExport<T>(
  options: LoadValidatedNodeModuleExportOptions<T>,
): T;
export function loadRequiredNodeModuleExport(
  options: LoadUnvalidatedNodeModuleExportOptions,
): unknown;
export function loadRequiredNodeModuleExport<T>({
  moduleId,
  exportName,
  requireFrom,
  validate,
}:
  | LoadValidatedNodeModuleExportOptions<T>
  | LoadUnvalidatedNodeModuleExportOptions): unknown {
  const moduleExports = loadRequiredNodeModule({
    moduleId,
    requireFrom,
  });
  if (!hasModuleExport(moduleExports, exportName)) {
    throw new Error(`${moduleId} did not export ${String(exportName)}`);
  }

  const value = moduleExports[exportName];

  if (validate && !validate(value)) {
    throw new Error(`${moduleId} did not export ${String(exportName)}`);
  }

  return value;
}

export function loadRequiredNodeModule<T>(
  options: LoadValidatedNodeModuleOptions<T>,
): T;
export function loadRequiredNodeModule(
  options: LoadUnvalidatedNodeModuleOptions,
): unknown;
export function loadRequiredNodeModule<T>({
  moduleId,
  requireFrom,
  validate,
}:
  | LoadValidatedNodeModuleOptions<T>
  | LoadUnvalidatedNodeModuleOptions): unknown {
  const nodeRequire = createRequire(requireFrom);
  const moduleExports: unknown = nodeRequire(moduleId);

  if (validate && !validate(moduleExports)) {
    throw new Error(`${moduleId} did not load with the expected shape`);
  }

  return moduleExports;
}
