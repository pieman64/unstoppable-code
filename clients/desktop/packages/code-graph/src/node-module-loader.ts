import { createRequire } from 'node:module';

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
