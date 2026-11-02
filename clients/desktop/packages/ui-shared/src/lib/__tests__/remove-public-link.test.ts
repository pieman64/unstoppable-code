import { removePublicLinkMessage } from '../remove-public-link';

describe('removePublicLinkMessage (CAN-5221)', () => {
  it('says a private-only resource leaves shared lists', () => {
    expect(removePublicLinkMessage()).toBe(
      "Anyone with the link will lose access, and it won't show up in shared lists anymore. You can share it again later.",
    );
  });

  it.each(['Acme Robotics', 'Platform', 'Shared organization', 'Shared team'])(
    'names the team or organization that keeps access (%s)',
    (name) => {
      expect(removePublicLinkMessage({ name })).toBe(
        `People outside ${name} who have the link will lose access. ${name} members keep access, including through links they already have.`,
      );
    },
  );

  it('keeps the Personal context without naming a member group', () => {
    expect(
      removePublicLinkMessage({ name: 'Aaron’s organization', personal: true }),
    ).toBe(
      'Anyone else with the link will lose access. It stays in your Personal context.',
    );
  });

  it('reads Personal from the flag, not the name', () => {
    expect(removePublicLinkMessage({ name: 'Personal' })).toBe(
      'People outside Personal who have the link will lose access. Personal members keep access, including through links they already have.',
    );
  });
});
