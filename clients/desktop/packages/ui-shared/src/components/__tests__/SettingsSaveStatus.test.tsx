import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsSaveStatus } from '../SettingsSaveStatus';

describe('SettingsSaveStatus', () => {
  it('says changes save automatically at rest', () => {
    const html = renderToStaticMarkup(<SettingsSaveStatus state="idle" />);
    expect(html).toContain('Changes save automatically');
    expect(html).toContain('role="status"');
    expect(html).toContain('data-state="idle"');
  });

  it('renders nothing at rest when the page has no idle line', () => {
    expect(
      renderToStaticMarkup(
        <SettingsSaveStatus state="idle" idleLabel={null} />,
      ),
    ).toBe('');
  });

  it('reports saving, saved and a failed save', () => {
    expect(
      renderToStaticMarkup(<SettingsSaveStatus state="saving" />),
    ).toContain('Saving…');
    const saved = renderToStaticMarkup(<SettingsSaveStatus state="saved" />);
    expect(saved).toContain('Saved');
    expect(saved).toContain('<svg');
    expect(
      renderToStaticMarkup(
        <SettingsSaveStatus state="error" errorLabel="Not saved" />,
      ),
    ).toContain('Not saved');
  });
});
