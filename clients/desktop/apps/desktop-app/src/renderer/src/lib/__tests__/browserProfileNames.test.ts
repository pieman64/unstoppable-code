import type { BrowserProfileRecord } from '@canopy/protocol/browser-profiles';
import {
  collidingProfileNames,
  profileNameQualifier,
} from '../browserProfileNames';

const profile = (
  profileId: string,
  displayName: string,
  kind: BrowserProfileRecord['kind'] = 'named',
): BrowserProfileRecord => ({
  schemaVersion: 1,
  profileId,
  displayName,
  kind,
  owner: { kind: 'user', localPrincipalId: 'local-user' },
  metadataRevision: 1,
  agentPermissions: { allowEnable: false, allowClear: false },
  lifecycle: 'active',
  storageGeneration: 1,
  createdAt: 1,
  updatedAt: 1,
});

describe('collidingProfileNames', () => {
  it('reports only the names more than one profile is using', () => {
    const colliding = collidingProfileNames([
      profile('a', 'Work'),
      profile('b', 'Work'),
      profile('c', 'Personal'),
    ]);
    expect(colliding.has('work')).toBe(true);
    expect(colliding.has('personal')).toBe(false);
  });

  it('reads case and surrounding space as the same name', () => {
    const colliding = collidingProfileNames([
      profile('a', 'Work'),
      profile('b', '  wOrK '),
    ]);
    expect(colliding.has('work')).toBe(true);
  });

  it('ignores Task profiles, which all share one stored name by design', () => {
    const colliding = collidingProfileNames([
      profile('a', 'Task', 'task'),
      profile('b', 'Task', 'task'),
    ]);
    expect(colliding.size).toBe(0);
  });
});

describe('profileNameQualifier', () => {
  const profiles = [profile('abcdef123', 'Work'), profile('zyxwvu987', 'Work')];
  const colliding = collidingProfileNames(profiles);

  it('returns a six-character id for a colliding name', () => {
    expect(profileNameQualifier(profiles[0], colliding)).toBe('abcdef');
    expect(profileNameQualifier(profiles[1], colliding)).toBe('zyxwvu');
  });

  it('returns nothing for a name no other profile is using', () => {
    expect(
      profileNameQualifier(profile('solo', 'Personal'), colliding),
    ).toBeUndefined();
  });

  it('never qualifies a Task profile, whose scope label already does that job', () => {
    expect(
      profileNameQualifier(profile('t1', 'Work', 'task'), colliding),
    ).toBeUndefined();
  });
});
