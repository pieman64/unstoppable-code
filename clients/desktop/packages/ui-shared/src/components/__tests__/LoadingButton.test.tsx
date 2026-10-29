import { renderToStaticMarkup } from 'react-dom/server';
import { SHARE_LANDER_BUTTON_CLASS_NAME } from '../../lib/share-lander';
import { LoadingButton } from '../LoadingButton';

function classAttribute(html: string): string {
  return /class="([^"]*)"/.exec(html)?.[1] ?? '';
}

describe('LoadingButton presentation', () => {
  it('renders the house pill by default', () => {
    const tokens = classAttribute(
      renderToStaticMarkup(<LoadingButton>Save</LoadingButton>),
    ).split(/\s+/);

    expect(tokens).toContain('rounded-full');
    expect(tokens).not.toContain('rounded-md');
  });

  it('renders the squared share-lander control in place of the pill', () => {
    const className = classAttribute(
      renderToStaticMarkup(
        <LoadingButton presentation="share-lander">Install</LoadingButton>,
      ),
    );

    // The exact recipe the landers put on their plain buttons and links, so
    // a busy lander button cannot drift from its neighbours.
    expect(className).toBe(SHARE_LANDER_BUTTON_CLASS_NAME);
    const tokens = className.split(/\s+/);
    expect(tokens).toContain('rounded-md');
    expect(tokens).toContain('bg-accent');
    expect(tokens).toContain('fg-emphasis');
    expect(tokens).not.toContain('rounded-full');
  });

  it('appends a placement class to either presentation', () => {
    const pill = classAttribute(
      renderToStaticMarkup(
        <LoadingButton className="mt-2">Save</LoadingButton>,
      ),
    ).split(/\s+/);
    const lander = classAttribute(
      renderToStaticMarkup(
        <LoadingButton presentation="share-lander" className="mt-2">
          Install
        </LoadingButton>,
      ),
    ).split(/\s+/);

    expect(pill).toContain('rounded-full');
    expect(pill).toContain('mt-2');
    expect(lander).toContain('rounded-md');
    expect(lander).toContain('mt-2');
  });

  it('reports and disables while loading in both presentations', () => {
    const lander = renderToStaticMarkup(
      <LoadingButton
        presentation="share-lander"
        loading
        loadingLabel="Installing…"
        spinnerTestId="spinner"
      >
        Install
      </LoadingButton>,
    );

    expect(lander).toContain('aria-busy="true"');
    expect(lander).toContain('disabled=""');
    expect(lander).toContain('data-testid="spinner"');
    expect(lander).toContain('Installing…');
  });
});
