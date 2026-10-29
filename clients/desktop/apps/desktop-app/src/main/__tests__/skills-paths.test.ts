import { join } from 'path';

jest.mock('../lib/paths', () => ({
  getDataDir: (): string => '/mock/userData',
}));

import {
  getSkillsRootDir,
  deriveSourceId,
  getSourceDirectoryName,
  getSourceDir,
  getSourceMetadataPath,
  getSkillDir,
  getSkillsLockFilePath,
  isBuiltinSourceId,
} from '../skills/paths';

const SKILLS_ROOT = join('/mock/userData', 'skills');

describe('skills/paths', () => {
  describe('getSkillsRootDir', () => {
    it('returns the skills directory under userData', () => {
      expect(getSkillsRootDir()).toBe(SKILLS_ROOT);
    });
  });

  describe('getSourceDirectoryName', () => {
    it('preserves logical source ids on non-Windows platforms', () => {
      expect(getSourceDirectoryName('custom:app', 'darwin')).toBe('custom:app');
    });

    it('escapes characters that are invalid in Windows directory names', () => {
      expect(getSourceDirectoryName('custom:app', 'win32')).toBe(
        'custom%3Aapp',
      );
      expect(getSourceDirectoryName('github:owner:repo', 'win32')).toBe(
        'github%3Aowner%3Arepo',
      );
      expect(getSourceDirectoryName('local:name%?. ', 'win32')).toBe(
        'local%3Aname%25%3F%2E%20',
      );
    });
  });

  describe('isBuiltinSourceId', () => {
    it('accepts canonical and legacy built-in skill source ids', () => {
      expect(isBuiltinSourceId('builtin:app')).toBe(true);
      expect(isBuiltinSourceId('builtin')).toBe(true);
      expect(isBuiltinSourceId('builtin/app')).toBe(true);
      expect(isBuiltinSourceId('builtin:canopy')).toBe(true);
      expect(isBuiltinSourceId('builtin/canopy')).toBe(true);
      expect(isBuiltinSourceId('github:owner:repo')).toBe(false);
    });
  });

  describe('deriveSourceId', () => {
    it('replaces slashes with colons for github source type', () => {
      expect(deriveSourceId('github', 'owner/repo')).toBe('github:owner:repo');
    });

    it('handles github sources with nested paths', () => {
      expect(deriveSourceId('github', 'org/repo/sub')).toBe(
        'github:org:repo:sub',
      );
    });

    it('replaces forward slashes with underscores for non-github types', () => {
      expect(deriveSourceId('local', '/home/user/skills')).toBe(
        'local:_home_user_skills',
      );
    });

    it('replaces backslashes with underscores for non-github types', () => {
      expect(deriveSourceId('local', 'C:\\Users\\skills')).toBe(
        'local:C:_Users_skills',
      );
    });

    it('replaces mixed slashes with underscores for non-github types', () => {
      expect(deriveSourceId('url', 'a/b\\c/d')).toBe('url:a_b_c_d');
    });

    it('does not truncate when escaped source is exactly 100 chars', () => {
      const source = 'a'.repeat(100);
      expect(deriveSourceId('local', source)).toBe(`local:${source}`);
    });

    it('does not truncate when escaped source is shorter than 100 chars', () => {
      const source = 'short';
      expect(deriveSourceId('local', source)).toBe('local:short');
    });

    it('truncates to last 100 characters when escaped source exceeds 100 chars', () => {
      const source = 'x'.repeat(150);
      const expected = 'x'.repeat(100);
      expect(deriveSourceId('local', source)).toBe(`local:${expected}`);
    });

    it('truncates after escaping slashes', () => {
      const source = '/' + 'a'.repeat(150);
      const escaped = '_' + 'a'.repeat(150);
      const truncated = escaped.slice(escaped.length - 100);
      expect(deriveSourceId('local', source)).toBe(`local:${truncated}`);
    });
  });

  describe('getSourceDir', () => {
    it('returns the source directory under skills root', () => {
      expect(getSourceDir('github:owner:repo')).toBe(
        join(SKILLS_ROOT, 'github:owner:repo'),
      );
    });

    it('uses a Windows-safe directory segment on Windows', () => {
      expect(getSourceDir('github:owner:repo', 'win32')).toBe(
        join(SKILLS_ROOT, 'github%3Aowner%3Arepo'),
      );
    });
  });

  describe('getSourceMetadataPath', () => {
    it('returns source.json inside the source directory', () => {
      expect(getSourceMetadataPath('github:owner:repo')).toBe(
        join(SKILLS_ROOT, 'github:owner:repo', 'source.json'),
      );
    });
  });

  describe('getSkillDir', () => {
    it('returns the skill directory inside the source directory', () => {
      expect(getSkillDir('github:owner:repo', 'my-skill')).toBe(
        join(SKILLS_ROOT, 'github:owner:repo', 'my-skill'),
      );
    });
  });

  describe('getSkillsLockFilePath', () => {
    it('returns skills-lock.json inside the skills root', () => {
      expect(getSkillsLockFilePath()).toBe(
        join(SKILLS_ROOT, 'skills-lock.json'),
      );
    });
  });
});
