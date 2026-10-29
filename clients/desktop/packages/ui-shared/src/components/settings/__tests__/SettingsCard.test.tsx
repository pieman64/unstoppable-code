/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_ICON_CLASS,
  SETTINGS_CARD_TITLE_CLASS,
  SettingsCard,
} from '../SettingsCard';
import {
  expectNoLegacyCardShell,
  expectSettingsCardHeading,
  expectSettingsCardShell,
  parseMarkup,
} from './helpers/settings-card-assertions';

describe('SettingsCard', () => {
  it('renders the shell as a section carrying exactly the shared card class', () => {
    const root = parseMarkup(
      renderToStaticMarkup(
        <SettingsCard
          icon={<svg />}
          title="Subscription plan"
          testId="card-1"
        />,
      ),
    );

    expectSettingsCardShell(root, 'card-1');
  });

  it('renders a plain h2 for a string title', () => {
    const root = parseMarkup(
      renderToStaticMarkup(
        <SettingsCard icon={<svg />} title="AI credit pool" testId="card-2" />,
      ),
    );

    expectSettingsCardHeading(root, 'AI credit pool');
  });

  it('renders a node title verbatim, letting the caller own its heading row', () => {
    const root = parseMarkup(
      renderToStaticMarkup(
        <SettingsCard
          icon={<svg />}
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

    // The card must not wrap a node title in a second heading.
    expectSettingsCardHeading(root, 'Billing history');
    // Scoped to the heading row, since the icon medallion is also a `span`.
    const headingRow = root.querySelector('h2')?.parentElement;
    expect(headingRow?.querySelector('span')?.textContent).toBe('pill');
  });

  it('renders the accent medallion, the subtitle, and the body', () => {
    const root = parseMarkup(
      renderToStaticMarkup(
        <SettingsCard
          icon={<span>icon</span>}
          title="Billing history"
          subtitle="Charges billed to your card in USD."
          testId="card-4"
        >
          <p data-testid="body">body</p>
        </SettingsCard>,
      ),
    );

    const medallion = root.querySelector(`[data-testid="card-4"] > div > span`);
    expect(medallion?.getAttribute('class')).toBe(SETTINGS_CARD_ICON_CLASS);

    const subtitle = root.querySelector('p.mt-1');
    expect(subtitle?.textContent).toBe('Charges billed to your card in USD.');

    const body = root.querySelector('[data-testid="body"]');
    expect(body?.parentElement?.getAttribute('class')).toBe('mt-4');
  });

  it('omits the subtitle and body wrappers when neither is supplied', () => {
    const root = parseMarkup(
      renderToStaticMarkup(
        <SettingsCard icon={<svg />} title="Security" testId="card-5" />,
      ),
    );

    const card = root.querySelector('[data-testid="card-5"]');
    expect(card?.querySelector('p')).toBeNull();
    expect(card?.querySelector('div.mt-4')).toBeNull();
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

  it('exports the shell class the bespoke-layout cards build on directly', () => {
    // The two plan cards keep hand-rolled internals (an `mt-auto` CTA pinned
    // diagonally opposite the actions menu), so they consume the constant
    // instead of the component. It must stay in sync with what the component
    // renders.
    expect(SETTINGS_CARD_CLASS).toBe('rounded-xl bg-card p-5 shadow-sm');

    const root = parseMarkup(
      renderToStaticMarkup(<SettingsCard icon={<svg />} title="x" />),
    );
    expect(root.querySelector('section')?.getAttribute('class')).toBe(
      SETTINGS_CARD_CLASS,
    );
  });
});
