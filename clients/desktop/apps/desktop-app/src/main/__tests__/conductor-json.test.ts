jest.mock('node:fs/promises');

import { readFile } from 'node:fs/promises';
import { getConductorJsonPath, readConductorJson } from '../lib/conductor-json';

const mockedReadFile = jest.mocked(readFile);

function createMissingFileError(pathStr: string): Error & { code: string } {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, open '${pathStr}'`),
    { code: 'ENOENT' },
  );
}

describe('readConductorJson', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps setup, run, and archive to canopy lifecycle names', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        scripts: {
          setup: ' npm install ',
          run: ' npm run dev ',
          archive: ' npm run clean ',
        },
      }),
    );

    await expect(readConductorJson('/repo')).resolves.toEqual({
      setup: 'npm install',
      launch: 'npm run dev',
      teardown: 'npm run clean',
    });
  });

  it('returns null when the file is missing', async () => {
    const filePath = getConductorJsonPath('/repo');
    mockedReadFile.mockRejectedValue(createMissingFileError(filePath));

    await expect(readConductorJson('/repo')).resolves.toBeNull();
  });

  it('returns null when the file contains invalid json', async () => {
    mockedReadFile.mockResolvedValue('{');

    await expect(readConductorJson('/repo')).resolves.toBeNull();
  });

  it('returns null when the top-level shape is malformed', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify(['not-an-object']));

    await expect(readConductorJson('/repo')).resolves.toBeNull();
  });

  it('returns null when scripts is not an object', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ scripts: [] }));

    await expect(readConductorJson('/repo')).resolves.toBeNull();
  });

  it('ignores malformed individual fields', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        scripts: {
          setup: 42,
          run: '   ',
          archive: 'npm run clean',
        },
      }),
    );

    await expect(readConductorJson('/repo')).resolves.toEqual({
      teardown: 'npm run clean',
    });
  });
});
