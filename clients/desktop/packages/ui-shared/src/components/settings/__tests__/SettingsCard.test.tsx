/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_ROW_CLASS,
  SETTINGS_CARD_SUBTITLE_CLASS,
  SETTINGS_CARD_TITLE_CLASS,
  SettingsCard,
  SettingsCardSwitch,
} from '../SettingsCard';
import {
  expectNoLegacyCardShell,
  expectSettingsCardHeading,
  expectSettingsCardShell,
  parseMarkup,
} from './helpers/settings-card-assertions';

describe('SettingsCard', () => {
  it('renders the section as a section carrying exactly the shared class', () => {
    const root = parseMarkup(
      renderToStaticMarkup(
        <SettingsCard title="Subscription plan" testId="card-1" />,
      ),
    );

    expectSettingsCardShell(root, 'card-1');
  });

  it('renders a plain h2 for a string title', () => {
    const root = parseMarkup(
      renderToStaticMarkup(
        <SettingsCard title="AI credit pool" testId="card-2" />,
      ),
    );

    expectSettingsCardHeading(root, 'AI credit pool');
  });

  it('renders a node title verbatim, letting the caller own its heading row', () => {
    const root = parseMarkup(
      renderToStaticMarkup(
        <SettingsCard
          title={
            <div className="flex items-center gap-2">
              <h2 className={SETTINGS_CARD_TITLE_CLASS}>Billing history</h2>
              <span>pill</span>
            </div>
          }
          testId="card-3"
        />,
      ),
    );

    // The section must not wrap a node title in a second heading.
    expectSettingsCardHeading(root, 'Billing history');
    const headingRow = root.querySelector('h2')?.parentElement;
    expect(headingRow?.querySelector('span')?.textContent).toBe('pill');
  });

  it('draws a text-only heading: no icon medallion, no card surface', () => {
    const root = parseMarkup(
      renderToStaticMarkup(
        <SettingsCard
          title="Billing history"
          subtitle="Charges billed to your card in USD."
          testId="card-4"
        >
          <p data-testid="body">body</p>
        </SettingsCard>,
      ),
    );

    const section = root.querySelector('[data-testid="card-4"]');
    expect(section).toBeInstanceOf(Element);
    // The heading block holds only the heading and its explanation.
    const header = section?.firstElementChild;
    expect(
      Array.from(header?.children ?? []).map((child) => child.tagName),
    ).toEqual(['H2', 'P']);
    expect(section?.querySelector('.rounded-full')).toBeNull();
    expect(section?.classList.contains('shadow-sm')).toBe(false);

    const subtitle = header?.querySelector('p');
    expect(subtitle?.getAttribute('class')).toBe(SETTINGS_CARD_SUBTITLE_CLASS);
    expect(subtitle?.textContent).toBe('Charges billed to your card in USD.');
  });

  it('puts the body in one grouped box under the heading', () => {
    const root = parseMarkup(
      renderToStaticMarkup(
        <SettingsCard title="Push notifications" testId="card-5">
          <div className={SETTINGS_CARD_ROW_CLASS} data-testid="row-1" />
          <div className={SETTINGS_CARD_ROW_CLASS} data-testid="row-2" />
        </SettingsCard>,
      ),
    );

    const box = root.querySelector('[data-testid="row-1"]')?.parentElement;
    expect(box?.getAttribute('class')).toBe(SETTINGS_CARD_GROUP_CLASS);
    expect(box?.parentElement?.getAttribute('data-testid')).toBe('card-5');
    expect(root.querySelector('[data-testid="row-2"]')?.parentElement).toBe(
      box,
    );
  });

  it('omits the subtitle and the box when neither is supplied', () => {
    const root = parseMarkup(
      renderToStaticMarkup(<SettingsCard title="Security" testId="card-6" />),
    );

    const section = root.querySelector('[data-testid="card-6"]');
    expect(section?.querySelector('p')).toBeNull();
    expect(section?.children).toHaveLength(1);
  });

  it('splits rows with hairlines and lets rows set the box rhythm', () => {
    expect(SETTINGS_CARD_ROW_CLASS.split(' ')).toEqual(
      expect.arrayContaining(['settings-card-row', '[&+&]:border-t']),
    );
    expect(SETTINGS_CARD_ROW_CLASS).not.toContain('rounded');
    expect(SETTINGS_CARD_GROUP_CLASS.split(' ')).toEqual(
      expect.arrayContaining([
        'has-[.settings-card-row,[data-settings-card-rows]]:py-0',
        'bg-secondary',
      ]),
    );
  });

  it('catches the legacy shell whatever order its classes are written in', () => {
    // The guard these suites use to prove the old bordered card is gone. It
    // used to be a substring match on a fixed class string, so any Tailwind
    // reordering made it pass vacuously. Assert it actually fires — and fires
    // on a shuffled class list — so the "old shell is gone" guarantee is real.
    expectNoLegacyCardShell(
      parseMarkup('<section class="rounded-xl bg-card p-5 shadow-sm" />'),
    );

    for (const legacy of [
      'rounded-xl border border-border bg-card p-6',
      'p-6 bg-card border-border border rounded-xl',
    ]) {
      expect(() =>
        expectNoLegacyCardShell(parseMarkup(`<section class="${legacy}" />`)),
      ).toThrow();
    }
  });

  it('exports the section class the component renders', () => {
    const root = parseMarkup(renderToStaticMarkup(<SettingsCard title="x" />));
    expect(root.querySelector('section')?.getAttribute('class')).toBe(
      SETTINGS_CARD_CLASS,
    );
  });
});

describe('SettingsCardSwitch', () => {
  it('draws the shared 32x18 switch and reports busy', () => {
    const root = parseMarkup(
      renderToStaticMarkup(
        <SettingsCardSwitch
          checked
          busy
          label="Weekly"
          onChange={() => undefined}
          dataTestId="switch"
        />,
      ),
    );

    const button = root.querySelector('[data-testid="switch"]');
    expect(button?.getAttribute('role')).toBe('switch');
    expect(button?.getAttribute('aria-checked')).toBe('true');
    expect(button?.getAttribute('aria-busy')).toBe('true');
    expect(button?.querySelector('.h-4\\.5.w-8')).toBeInstanceOf(Element);
  });
});
