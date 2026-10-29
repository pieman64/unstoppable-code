import { renderToString } from 'react-dom/server';
import { MemberAvatar, initialsOf } from '../MemberAvatar';

describe('initialsOf', () => {
  it('builds up-to-2-letter uppercase initials', () => {
    expect(initialsOf('Grace Hopper')).toBe('GH');
    expect(initialsOf('madonna')).toBe('M');
  });

  it('falls back to "?" when no usable characters exist', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });
});

describe('MemberAvatar', () => {
  it('renders the initials placeholder when no image is present', () => {
    const html = renderToString(
      <MemberAvatar name="Grace Hopper" image={null} />,
    );
    expect(html).toContain('GH');
    expect(html).toContain('bg-accent');
    expect(html).toContain('fg-emphasis');
    // No <img> for the placeholder treatment.
    expect(html).not.toContain('<img');
  });

  it('renders a "?" placeholder for an unresolved actor with no name', () => {
    const html = renderToString(<MemberAvatar name="" image={null} />);
    expect(html).toContain('?');
  });

  it('gives the initials placeholder an accessible name for screen readers', () => {
    const html = renderToString(
      <MemberAvatar name="Grace Hopper" image={null} />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Grace Hopper"');
    // The placeholder must not be hidden from assistive technology.
    expect(html).not.toContain('aria-hidden');
  });

  it('labels an unnamed placeholder as an unknown member', () => {
    const html = renderToString(<MemberAvatar name="" image={null} />);
    expect(html).toContain('aria-label="Unknown member"');
  });

  it('renders the image avatar when an image URL is present', () => {
    const html = renderToString(
      <MemberAvatar name="Grace Hopper" image="https://example.com/a.png" />,
    );
    expect(html).toContain('<img');
    expect(html).toContain('rounded-full');
    expect(html).toContain('Grace Hopper');
  });
});
