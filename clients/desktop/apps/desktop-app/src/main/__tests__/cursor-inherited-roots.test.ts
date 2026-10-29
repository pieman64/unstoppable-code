import { homedir } from 'node:os';
import path from 'node:path';
import { brandEnvName } from '@canopy/desktop-shared/brand/env';
import {
  CURSOR_USER_HOME_ENV_SUFFIX,
  resolveInheritedCursorRoots,
} from '../cursor/inherited-roots';

describe('resolveInheritedCursorRoots', () => {
  it('defaults to the real home and the provider folders under it', () => {
    expect(resolveInheritedCursorRoots({})).toEqual({
      userHome: homedir(),
      claudeConfigDir: path.join(homedir(), '.claude'),
      codexHome: path.join(homedir(), '.codex'),
    });
  });

  it('honors the relocation variables the harness and the providers use', () => {
    expect(
      resolveInheritedCursorRoots({
        [brandEnvName(CURSOR_USER_HOME_ENV_SUFFIX)]: '/isolated/home',
        CLAUDE_CONFIG_DIR: '/isolated/claude',
        CODEX_HOME: '/isolated/codex',
      }),
    ).toEqual({
      userHome: '/isolated/home',
      claudeConfigDir: '/isolated/claude',
      codexHome: '/isolated/codex',
    });
  });

  it('ignores a blank override', () => {
    expect(
      resolveInheritedCursorRoots({
        [brandEnvName(CURSOR_USER_HOME_ENV_SUFFIX)]: '   ',
      }).userHome,
    ).toBe(homedir());
  });
});
