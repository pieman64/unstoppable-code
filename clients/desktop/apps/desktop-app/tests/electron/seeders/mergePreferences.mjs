import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function preferencesPath(userDataDir) {
  return path.join(userDataDir, 'preferences.json');
}

/** Persisted preferences for an isolated profile, or `{}` when absent. */
export function readPersistedPreferences(userDataDir) {
  const file = preferencesPath(userDataDir);
  if (!existsSync(file)) return {};
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  return persisted?.preferences && typeof persisted.preferences === 'object'
    ? persisted.preferences
    : {};
}

/**
 * Merge `patch` into the profile's preferences file, preserving every field
 * already on disk (including the launch harness's own seeds).
 */
export function mergeSeedPreferences(userDataDir, patch) {
  const file = preferencesPath(userDataDir);
  mkdirSync(userDataDir, { recursive: true });
  const persisted = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { version: 1, preferences: {} };
  writeFileSync(
    file,
    JSON.stringify(
      {
        ...persisted,
        version: persisted.version ?? 1,
        preferences: { ...(persisted.preferences ?? {}), ...patch },
      },
      null,
      2,
    ),
    'utf8',
  );
}
