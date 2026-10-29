import {
  readPreferencesFile,
  writePreferencesFile,
} from '../lib/preferences-store';
import type { OllamaConnectionMode } from '@canopy/desktop-shared/types';

export async function readOllamaServerPortPreference(): Promise<number> {
  const preferences = await readPreferencesFile();
  return preferences.ollamaServerPort;
}

export async function readOllamaPreferences(): Promise<{
  mode: OllamaConnectionMode;
  port: number;
  executablePath: string;
}> {
  const preferences = await readPreferencesFile();
  return {
    mode: preferences.ollamaConnectionMode,
    port: preferences.ollamaServerPort,
    executablePath: preferences.ollamaExecutablePath,
  };
}

export async function writeOllamaServerPortPreference(
  port: number,
): Promise<void> {
  await writePreferencesFile({ ollamaServerPort: port });
}

export async function writeOllamaConfigurationPreference(update: {
  mode?: OllamaConnectionMode;
  port?: number;
  executablePath?: string;
}): Promise<void> {
  await writePreferencesFile({
    ...(update.mode ? { ollamaConnectionMode: update.mode } : {}),
    ...(update.port !== undefined ? { ollamaServerPort: update.port } : {}),
    ...(update.executablePath !== undefined
      ? { ollamaExecutablePath: update.executablePath }
      : {}),
  });
}
