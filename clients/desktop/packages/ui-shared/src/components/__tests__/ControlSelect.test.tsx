import { renderToStaticMarkup } from 'react-dom/server';
import { ControlSelect } from '../ControlSelect';
import { SettingsControlSelect } from '../SettingsControlSelect';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

describe('ControlSelect', () => {
  it('renders a native select on the 28px control surface with a chevron', () => {
    const html = renderToStaticMarkup(
      <ControlSelect aria-label="Sound" value="a" onChange={() => undefined}>
        <option value="a">A</option>
      </ControlSelect>,
    );

    expect(html).toContain('<select');
    expect(html).toContain('aria-label="Sound"');
    expect(html).toContain('h-7');
    expect(html).toContain('rounded-md');
    expect(html).toContain('text-xs');
    expect(html).toContain('appearance-none');
    expect(html).toContain('bg-quaternary');
    expect(html).toContain('<svg');
    expect(html).toContain('max-w-64');
    expect(html).not.toContain('w-full');
  });

  it('fills its parent when a column of dropdowns shares one width', () => {
    const html = renderToStaticMarkup(
      <ControlSelect
        fill
        aria-label="Sound"
        value="a"
        onChange={() => undefined}
      >
        <option value="a">A</option>
      </ControlSelect>,
    );

    expect(html).toContain('w-full');
    expect(html).not.toContain('max-w-64');
  });

  it('lets a filling dropdown shrink to leave room for its row neighbours', () => {
    const html = renderToStaticMarkup(
      <ControlSelect
        fill
        aria-label="Sound"
        value="a"
        onChange={() => undefined}
      >
        <option value="a">A</option>
      </ControlSelect>,
    );
    const wrapperClass = /^<span class="([^"]*)"/.exec(html)?.[1] ?? '';

    expect(wrapperClass.split(' ')).toContain('min-w-0');
    expect(wrapperClass.split(' ')).not.toContain('shrink-0');
  });
});

it('shares capsule geometry across Settings while preserving native form and privacy props', () => {
  const html = renderToStaticMarkup(
    <SettingsControlSelect
      name="role"
      aria-label="Member role"
      defaultValue="member"
      disabled
      replayPrivacy={{ blockClassName: REPLAY_BLOCK_CLASS }}
    >
      <option value="member">Member</option>
      <option value="admin">Admin</option>
    </SettingsControlSelect>,
  );
  expect(html).toContain('rounded-full');
  expect(html).not.toContain('rounded-md');
  expect(html).toContain('name="role"');
  expect(html).toContain(REPLAY_BLOCK_CLASS);
  expect(html).toContain('disabled=""');
  expect(html).toContain('selected=""');
});
