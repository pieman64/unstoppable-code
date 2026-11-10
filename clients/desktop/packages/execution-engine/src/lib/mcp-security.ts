const BLOCKED_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PYTHONSTARTUP',
  'PYTHONPATH',
]);

export function sanitizeEnvVars(
  envVars: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(envVars).filter(
      ([key]) => !BLOCKED_ENV_KEYS.has(key.toUpperCase()),
    ),
  );
}
