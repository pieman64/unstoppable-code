import { canManagePublicLink } from '../canManagePublicLink';

describe('canManagePublicLink', () => {
  it('lets the author remove their public link', () => {
    expect(canManagePublicLink({ canUpdate: true, canDelete: true })).toBe(
      true,
    );
  });

  it("lets an organization admin remove a departed creator's link", () => {
    expect(canManagePublicLink({ canUpdate: false, canDelete: true })).toBe(
      true,
    );
  });

  it('hides the action from a viewer who can neither update nor delete', () => {
    expect(canManagePublicLink({ canUpdate: false, canDelete: false })).toBe(
      false,
    );
  });

  it('defers to the dialog before the detail loads', () => {
    expect(canManagePublicLink(null)).toBe(true);
  });
});
