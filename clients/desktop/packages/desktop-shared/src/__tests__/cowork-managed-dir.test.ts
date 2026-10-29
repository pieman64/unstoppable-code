import path from 'node:path';
import { BRAND } from '@canopy/brand/current';
import {
  getCoworkManagedDir,
  getCoworkManagedDirCandidates,
  getCoworkManagedSubdir,
  getCoworkManagedSubdirCandidates,
  getCoworkArtifactsIndexFilePath,
  getCoworkArtifactsIndexFileCandidates,
} from '../node/lib/cowork-managed-dir';

describe('cowork-managed-dir', () => {
  const folder = '/Users/me/Research';
  const primary = BRAND.storage.projectConfigDirNames[0];

  it('writes under the primary brand dir name', () => {
    expect(getCoworkManagedDir(folder)).toBe(path.join(folder, primary));
    expect(getCoworkManagedSubdir(folder, 'notes')).toBe(
      path.join(folder, primary, 'notes'),
    );
    expect(getCoworkArtifactsIndexFilePath(folder)).toBe(
      path.join(folder, primary, 'artifacts-index.json'),
    );
  });

  it('reads across all brand dir name candidates, primary first', () => {
    const expected = BRAND.storage.projectConfigDirNames.map((name) =>
      path.join(folder, name),
    );
    expect(getCoworkManagedDirCandidates(folder)).toEqual(expected);
    expect(getCoworkManagedSubdirCandidates(folder, 'attachments')).toEqual(
      expected.map((dir) => path.join(dir, 'attachments')),
    );
    expect(getCoworkArtifactsIndexFileCandidates(folder)).toEqual(
      expected.map((dir) => path.join(dir, 'artifacts-index.json')),
    );
  });
});
