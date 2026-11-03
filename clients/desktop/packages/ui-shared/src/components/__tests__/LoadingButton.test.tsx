/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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

  it('reports busy and unavailable while loading in both presentations', () => {
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
    expect(lander).toContain('aria-disabled="true"');
    expect(lander).not.toContain('disabled=""');
    expect(lander).toContain('data-testid="spinner"');
    expect(lander).toContain('Installing…');
  });
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('LoadingButton width', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderStart(loading: boolean): HTMLButtonElement {
    act(() => {
      root.render(
        <LoadingButton
          size="compact"
          loading={loading}
          loadingLabel="Starting…"
          spinnerTestId="start-spinner"
        >
          Start proxy
        </LoadingButton>,
      );
    });
    const button = container.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('no button');
    return button;
  }

  function layer(name: 'rest' | 'busy'): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      `[data-busy-layer="${name}"]`,
    );
    if (!(element instanceof HTMLElement)) throw new Error(`no ${name} layer`);
    return element;
  }

  function reserved(element: HTMLElement): string | null {
    return (
      element
        .querySelector<HTMLElement>('[data-reserved-label]')
        ?.getAttribute('data-reserved-label') ?? null
    );
  }

  it('reserves the busy label in the same cell from the first render', () => {
    const button = renderStart(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(button.disabled).toBe(false);
    // Only the showing label is text in the DOM.
    expect(button.textContent).toBe('Start proxy');
    expect(layer('rest').classList.contains('invisible')).toBe(false);
    // The busy label is laid out but hidden, so the width never jumps.
    expect(layer('busy').classList.contains('invisible')).toBe(true);
    expect(layer('busy').getAttribute('aria-hidden')).toBe('true');
    expect(reserved(layer('busy'))).toBe('Starting…');
    // The spinner's room is held without running a spinner.
    expect(container.querySelector('[data-testid="start-spinner"]')).toBeNull();
    for (const element of [layer('rest'), layer('busy')]) {
      expect(element.classList.contains('col-start-1')).toBe(true);
      expect(element.classList.contains('row-start-1')).toBe(true);
    }
  });

  it('shows the spinner and the verb in progress in the same cell', () => {
    const button = renderStart(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    // Unavailable but still focusable, so focus never drops to the page.
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.textContent).toBe('Starting…');
    expect(layer('rest').classList.contains('invisible')).toBe(true);
    expect(layer('rest').getAttribute('aria-hidden')).toBe('true');
    expect(reserved(layer('rest'))).toBe('Start proxy');
    expect(layer('busy').classList.contains('invisible')).toBe(false);
    expect(layer('busy').hasAttribute('aria-hidden')).toBe(false);
    const spinner = layer('busy').querySelector(
      '[data-testid="start-spinner"]',
    );
    expect(spinner).toBeInstanceOf(Element);
    // Decorative, so the name stays "Starting…", not "Loading Starting…".
    expect(spinner?.getAttribute('aria-label')).toBeNull();
  });

  it('keeps the resting label while busy when no busy label is given', () => {
    act(() => {
      root.render(<LoadingButton loading>Apply</LoadingButton>);
    });
    expect(layer('busy').textContent).toBe('Apply');
    expect(reserved(layer('rest'))).toBe('Apply');
  });

  it('reserves a label built from text and numbers as one string', () => {
    const count = 3;
    act(() => {
      root.render(
        <LoadingButton loading>Create {count} projects</LoadingButton>,
      );
    });
    expect(reserved(layer('rest'))).toBe('Create 3 projects');
    expect(container.querySelector('button')?.textContent).toBe(
      'Create 3 projects',
    );
  });

  it('does not start the work again while busy', () => {
    const onClick = jest.fn();
    act(() => {
      root.render(
        <LoadingButton loading onClick={onClick}>
          Apply
        </LoadingButton>,
      );
    });
    container.querySelector('button')?.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not submit its form again while busy', () => {
    const onSubmit = jest.fn((event: SubmitEvent) => event.preventDefault());
    act(() => {
      root.render(
        <form>
          <LoadingButton type="submit" loading>
            Save
          </LoadingButton>
        </form>,
      );
    });
    const form = container.querySelector('form');
    form?.addEventListener('submit', onSubmit);
    container.querySelector('button')?.click();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('stays disabled when the caller disables it', () => {
    act(() => {
      root.render(
        <LoadingButton loading disabled>
          Apply
        </LoadingButton>,
      );
    });
    expect(container.querySelector('button')?.disabled).toBe(true);
  });
});
