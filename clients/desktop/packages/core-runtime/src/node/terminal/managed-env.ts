export function isBlockedManagedEnvName(
  name: string,
  options: { allowPath?: boolean } = {},
): boolean {
  const normalized = name.toUpperCase();
  return (
    name.length === 0 ||
    name.includes('=') ||
    (!options.allowPath && normalized === 'PATH') ||
    normalized === 'NODE_OPTIONS' ||
    normalized === 'ELECTRON_RUN_AS_NODE' ||
    normalized === 'SHELL' ||
    normalized.startsWith('LD_') ||
    normalized.startsWith('DYLD_')
  );
}

export function sanitizeManagedBaseEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (isBlockedManagedEnvName(key, { allowPath: true })) {
      delete result[key];
    }
  }
  return result;
}
