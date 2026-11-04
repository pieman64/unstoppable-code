import { displayInitials } from '../display-avatar';

describe('displayInitials', () => {
  it('uses first + last word initials for multi-word names', () => {
    expect(displayInitials('Aaron Quirk')).toBe('AQ');
    expect(displayInitials('  ada  beatrice  lovelace ')).toBe('AL');
  });

  it('uses the first two letters of a single-word name', () => {
    expect(displayInitials('teammate')).toBe('TE');
  });

  it('falls back to "?" for empty input', () => {
    expect(displayInitials('   ')).toBe('?');
  });
});
