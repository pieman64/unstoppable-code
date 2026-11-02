import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsBackButton } from '../SettingsBackButton';

it('draws the back control as the Settings rail Back row: no fill, secondary ink, hover only', () => {
  const html = renderToStaticMarkup(
    <SettingsBackButton
      label="Environments"
      onClick={() => undefined}
      dataTestId="settings-page-back"
    />,
  );
  expect(html).toContain('<button');
  expect(html).toContain('data-testid="settings-page-back"');
  // The shared nav row, in its quiet tone.
  expect(html).toContain('data-sidebar-nav-row');
  expect(html).toContain('fg-secondary hover:bg-subtle');
  // Not a filled capsule.
  expect(html).not.toContain('rounded-full');
  expect(html).not.toMatch(/class="[^"]*\bbg-(secondary|muted|base)\b/);
  // Hangs out by the row's 8px inset so the arrow lines up with the title.
  expect(html).toContain('-ml-2');
  expect(html).toContain('w-fit');
  expect(html).toContain('<svg');
  expect(html).toContain('Environments');
});
