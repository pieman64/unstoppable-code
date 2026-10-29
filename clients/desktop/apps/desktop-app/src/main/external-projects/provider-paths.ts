import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Locations of the provider stores the bulk project import reads. Every
 * resolver honors the same relocation variables the providers document
 * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and mirrors the fallbacks the rest of
 * the app already uses (`claude-project-paths.ts`, `codex-home.ts`), so a
 * relocated store is discovered from the same place other features read it.
 *
 * Discovery never reads provider auth stores; these helpers only name the
 * directories whose allowlisted project metadata the adapters inspect.
 */

type EnvLike = Readonly<Record<string, string | undefined>>;

export function resolveClaudeConfigDir(env: EnvLike = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured || path.join(homedir(), '.claude');
}

/** `~/.claude.json` (or its relocated twin): only its `projects` keys are read. */
export function resolveClaudeGlobalConfigPath(
  env: EnvLike = process.env,
): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured
    ? path.join(configured, '.claude.json')
    : path.join(homedir(), '.claude.json');
}

export function resolveClaudeProjectsDir(env: EnvLike = process.env): string {
  return path.join(resolveClaudeConfigDir(env), 'projects');
}

/**
 * Claude Desktop keeps its Code/Cowork session records under the platform
 * application-support directory. `null` on platforms without a known root.
 */
export function resolveClaudeDesktopDataDir(
  platform: NodeJS.Platform = process.platform,
  env: EnvLike = process.env,
): string | null {
  const override = env.CANOPY_CLAUDE_DESKTOP_DATA_DIR?.trim();
  if (override) return override;
  if (platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'Claude');
  }
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim();
    return appData ? path.join(appData, 'Claude') : null;
  }
  if (platform === 'linux') {
    const configHome = env.XDG_CONFIG_HOME?.trim();
    return path.join(configHome || path.join(homedir(), '.config'), 'Claude');
  }
  return null;
}

export function resolveCodexHome(env: EnvLike = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  return configured || path.join(env.HOME ?? homedir(), '.codex');
}

export function resolveCodexSessionsDir(env: EnvLike = process.env): string {
  return path.join(resolveCodexHome(env), 'sessions');
}

export function resolveCodexGlobalStatePath(
  env: EnvLike = process.env,
): string {
  return path.join(resolveCodexHome(env), '.codex-global-state.json');
}

/**
 * `~/.codex/session_index.jsonl`: one row per thread with the name Codex
 * shows in its own resume picker. Only `id` and `thread_name` are read.
 */
export function resolveCodexSessionIndexPath(
  env: EnvLike = process.env,
): string {
  return path.join(resolveCodexHome(env), 'session_index.jsonl');
}

/**
 * Claude Desktop runs a Cowork session that has no chosen folder inside a
 * per-session `outputs` directory under this tree. Those folders are session
 * scratch space, not projects the user named, so a candidate rooted there is
 * shown by its session title rather than the repeated folder name.
 */
export function resolveClaudeDesktopCoworkSessionsDir(
  desktopDataDir: string,
): string {
  return path.join(desktopDataDir, 'local-agent-mode-sessions');
}
