import * as path from 'node:path';
import {
  getInstalledSkillDirectory,
  getSkillSourceDirectoryName,
} from '../paths';

describe('skill filesystem paths', () => {
  it('preserves source ids outside Windows', () => {
    expect(getSkillSourceDirectoryName('custom:app', 'darwin')).toBe(
      'custom:app',
    );
  });

  it('encodes Windows-reserved source-id characters without collisions', () => {
    expect(getSkillSourceDirectoryName('custom:app', 'win32')).toBe(
      'custom%3Aapp',
    );
    expect(getSkillSourceDirectoryName('github:owner:repo', 'win32')).toBe(
      'github%3Aowner%3Arepo',
    );
    expect(getSkillSourceDirectoryName('local:name%?. ', 'win32')).toBe(
      'local%3Aname%25%3F%2E%20',
    );
  });

  it('builds an installed skill path with the platform-safe source directory', () => {
    expect(
      getInstalledSkillDirectory(
        path.join('C:', 'app-data', 'skills'),
        'custom:app',
        'helper',
        'win32',
      ),
    ).toBe(path.join('C:', 'app-data', 'skills', 'custom%3Aapp', 'helper'));
  });

  it.each([
    ['darwin' as const, 'custom:app'],
    ['win32' as const, 'custom%3Aapp'],
  ])(
    'preserves a hyphenated custom skill name on %s',
    (platform, sourceDirectory) => {
      expect(
        getInstalledSkillDirectory(
          path.join('app-data', 'skills'),
          'custom:app',
          'my-skill',
          platform,
        ),
      ).toBe(path.join('app-data', 'skills', sourceDirectory, 'my-skill'));
    },
  );
});
