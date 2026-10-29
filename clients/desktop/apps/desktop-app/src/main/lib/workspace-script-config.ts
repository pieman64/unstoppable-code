import type { WorkspaceRepoData } from '@canopy/desktop-shared/types';
import {
  isScriptDefinition,
  normalizeScriptInputMap,
} from '@canopy/desktop-shared/scripts';
import { readWorkspaceConfig } from './workspace-persistence';

export async function readWorkspaceRepoOrThrow(args: {
  workspaceId: string;
  repoId: string;
  notFoundMessage: string;
}): Promise<WorkspaceRepoData> {
  const config = await readWorkspaceConfig(args.workspaceId);
  const repo = config.repos.find((candidate) => candidate.id === args.repoId);
  if (!repo) {
    throw new Error(args.notFoundMessage);
  }
  return repo;
}

/**
 * Read a workspace's persisted script overrides as a flat name→command-string
 * map (each entry's command, whether it was stored as a bare string or a
 * `ScriptDefinition`). For the browser settings Scripts section. Empty when none.
 */
export async function readWorkspaceScriptCommands(
  workspaceId: string,
): Promise<Record<string, string>> {
  const config = await readWorkspaceConfig(workspaceId);
  const scripts = normalizeScriptInputMap(config.scripts) ?? {};
  const commands: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value === 'string') {
      commands[name] = value;
    } else if (isScriptDefinition(value)) {
      commands[name] = value.command;
    }
  }
  return commands;
}
