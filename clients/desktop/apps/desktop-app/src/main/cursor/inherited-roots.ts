import { homedir } from 'node:os';
import { getBrandEnv } from '@canopy/desktop-shared/brand/env';
import type { InheritedCursorRoots } from '@canopy/desktop-shared/node/cursor/inherited-capabilities';
import {
  resolveClaudeConfigDir,
  resolveCodexHome,
} from '../external-projects/provider-paths';

/**
 * `<BRAND>_CURSOR_USER_HOME` relocates the `.cursor`, `.agents`, and `.grok`
 * roots a Cursor chat inherits skills from; they have no vendor relocation
 * variable of their own. The Electron test harness sets it so a suite never
 * reads the developer's real skills. A packaged build never sets it.
 */
export const CURSOR_USER_HOME_ENV_SUFFIX = 'CURSOR_USER_HOME';

/**
 * Where a Cursor chat looks for the user's own skills and commands. Claude
 * and Codex roots follow the same relocation variables the rest of the app
 * honors, so a relocated store is read from one place everywhere.
 */
export function resolveInheritedCursorRoots(
  env: Readonly<Record<string, string | undefined>> = process.env,
): InheritedCursorRoots {
  return {
    userHome: getBrandEnv(env, CURSOR_USER_HOME_ENV_SUFFIX) ?? homedir(),
    claudeConfigDir: resolveClaudeConfigDir(env),
    codexHome: resolveCodexHome(env),
  };
}
