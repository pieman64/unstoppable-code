import { committedSelectionsStillStored } from '../committed-plugin-selections';

const DEPLOY = {
  collectionIds: [],
  skillRefs: [{ sourceId: 'user', skillName: 'deploy' }],
  pluginRefs: [],
};

describe('a committed plugin change reaches the live session only while it is stored (CAN-5999)', () => {
  it('the stored selections the caller committed may go live', () => {
    // Compared as core compares expectedPluginSelections.
    expect(
      committedSelectionsStillStored(
        { ...DEPLOY, collectionIds: ['c1', 'c1'] },
        { ...DEPLOY, collectionIds: ['c1'] },
      ),
    ).toBe(true);
    expect(committedSelectionsStillStored(undefined, undefined)).toBe(true);
  });

  it('selections edited since the commit are never overwritten or shadowed', () => {
    expect(
      committedSelectionsStillStored(
        {
          ...DEPLOY,
          skillRefs: [{ sourceId: 'user', skillName: 'review' }],
        },
        DEPLOY,
      ),
    ).toBe(false);
    expect(committedSelectionsStillStored(undefined, DEPLOY)).toBe(false);
  });
});
