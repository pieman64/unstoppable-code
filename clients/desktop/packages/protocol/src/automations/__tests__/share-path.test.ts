import { AUTOMATION_SHARE_PATH_PREFIX, automationSharePath } from '../index';

describe('automation share path', (): void => {
  it('builds the canonical automation share path', (): void => {
    expect(AUTOMATION_SHARE_PATH_PREFIX.split('/')).toEqual([
      '',
      'portal',
      'plugins',
      'automations',
    ]);
    expect(automationSharePath('11111111-1111-4111-8111-111111111111')).toBe(
      `${AUTOMATION_SHARE_PATH_PREFIX}/11111111-1111-4111-8111-111111111111`,
    );
  });

  it('URL-encodes the id', (): void => {
    expect(automationSharePath('a b')).toBe(
      `${AUTOMATION_SHARE_PATH_PREFIX}/a%20b`,
    );
  });
});
