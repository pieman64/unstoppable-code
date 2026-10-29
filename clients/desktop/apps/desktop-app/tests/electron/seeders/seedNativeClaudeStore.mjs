import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJson, writeJsonl } from './fsHelpers.mjs';

/**
 * Minimum Claude Code store that makes `hasAnyProviderStore()` report true, so
 * the `import-projects` Getting started entry (CAN-2439) is offered.
 *
 * The probe deliberately ignores Canopy's own footprint: every Canopy chat
 * writes a transcript under the Claude projects dir, so mere existence proves
 * nothing. Evidence counts only when a project directory points OUTSIDE the
 * brand data dirs AND holds a transcript a person started themselves.
 *
 * What actually marks it as theirs is `entrypoint` alone: `claude-discovery.ts`
 * flags a record as non-native when `entrypoint` starts with `sdk` or
 * `promptSource === 'sdk'`. `userType: 'external'` below is carried for parity
 * with the sibling fixtures (`import-projects.spec.mjs`) and is NOT read by
 * detection. `provider-presence.ts` owns the contract — check there before
 * copying this fixture into another spec.
 *
 * Writes into the harness's isolated `CLAUDE_CONFIG_DIR`
 * (`<userDataDir>/provider-state/claude`), so nothing touches the real
 * `~/.claude`.
 *
 * @param {string} userDataDir the launch's isolated user data dir
 * @param {{ prefix?: string }} [options] temp-dir prefix, for readable paths
 * @returns {string} the external project root; delete it when the spec ends,
 *   since `closeCanopy` only cleans `userDataDir`
 */
export function seedNativeClaudeStore(
  userDataDir,
  { prefix = 'canopy-native-claude-' } = {},
) {
  // realpath first: on macOS `os.tmpdir()` is a symlink into /private, and the
  // probe compares realpaths, so an unresolved path would not match the slug.
  const externalRoot = mkdtempSync(
    path.join(realpathSync(os.tmpdir()), prefix),
  );
  const claudeDir = path.join(userDataDir, 'provider-state', 'claude');
  const sessionId = '9a9a9a9a-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  writeJson(path.join(claudeDir, '.claude.json'), {
    projects: { [externalRoot]: { allowedTools: [] } },
  });

  const projectDir = path.join(
    claudeDir,
    'projects',
    externalRoot.replace(/[^A-Za-z0-9-]/g, '-'),
  );
  writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), [
    {
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      uuid: `${sessionId}-u1`,
      timestamp: '2026-09-01T10:00:00.000Z',
      cwd: externalRoot,
      sessionId,
      version: '2.1.235',
      entrypoint: 'cli',
      userType: 'external',
    },
  ]);

  return externalRoot;
}
