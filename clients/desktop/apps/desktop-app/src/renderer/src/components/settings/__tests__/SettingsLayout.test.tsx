/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SettingsDescriptionLoading,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsTextField,
} from '../SettingsLayout';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('SettingsPage drill-in back control', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('uses the shared 28px rounded field with a neutral focus edge', () => {
    act(() =>
      root.render(
        <SettingsTextField
          type="number"
          width="xs"
          min={1}
          max={90}
          defaultValue={7}
        />,
      ),
    );
    const field = container.querySelector('input');
    // Fields are rounded rectangles; only buttons are capsules.
    expect(field?.classList.contains('rounded-row')).toBe(true);
    expect(field?.classList.contains('shadow-field')).toBe(true);
    expect(field?.classList.contains('focus-visible:shadow-field-focus')).toBe(
      true,
    );
    expect(field?.value).toBe('7');
    expect(field?.min).toBe('1');
    expect(field?.max).toBe('90');
  });

  it('renders no back control without `back`', () => {
    act(() => {
      root.render(<SettingsPage title="Environments" />);
    });
    expect(
      container.querySelector('[data-testid="settings-page-back"]'),
    ).toBeNull();
  });

  it('renders the back control above the title and calls its handler', () => {
    const onClick = jest.fn();
    act(() => {
      root.render(
        <SettingsPage
          title="Staging"
          back={{ label: 'Environments', onClick }}
        />,
      );
    });
    const back = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-page-back"]',
    );
    const title = container.querySelector('h1');
    if (!back || !title) throw new Error('Missing back control or title');
    expect(back.textContent).toBe('Environments');
    // The Settings rail's quiet Back row, not a filled capsule.
    expect(back.hasAttribute('data-sidebar-nav-row')).toBe(true);
    expect(back.className).not.toContain('rounded-full');
    expect(
      back.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    act(() => back.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('settings loading placeholders', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  function placeholder(): Element | null {
    return container.querySelector(
      '[data-testid="delayed-loading-placeholder"]',
    );
  }

  it('reserves a form skeleton at once and shows it after the delay', () => {
    act(() => {
      root.render(<SettingsLoading rows={2} dataTestId="tab-loading" />);
    });
    const skeleton = container.querySelector(
      '[data-testid="tab-loading"] [data-testid="settings-skeleton-form"]',
    );
    expect(skeleton?.getAttribute('role')).toBe('status');
    expect(container.textContent).toBe('Loading');
    expect(placeholder()?.getAttribute('data-visible')).toBe('false');

    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(placeholder()?.getAttribute('data-visible')).toBe('true');
  });

  it('renders one centered spinner for the spinner variant', () => {
    act(() => {
      root.render(<SettingsLoading variant="spinner" />);
    });
    expect(
      container.querySelectorAll('[data-testid="centered-loading-spinner"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="settings-skeleton-form"]'),
    ).toBeNull();
    expect(container.textContent).toBe('Loading');
  });

  it('holds a description line with a bar that appears after the delay', () => {
    act(() => {
      root.render(<SettingsDescriptionLoading dataTestId="row-loading" />);
    });
    const status = container.querySelector('[data-testid="row-loading"]');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.querySelector('.canopy-inline-skeleton')).not.toBeNull();
    expect(status?.classList.contains('invisible')).toBe(true);
    expect(status?.textContent).toBe('Loading');

    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(status?.classList.contains('invisible')).toBe(false);
  });
});

it('reserves a subtitle line for each Settings row without constraining longer content', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <>
          <SettingsRow label="Color mode" dataTestId="plain" />
          <SettingsRow
            label="Theme"
            description="The color palette."
            dataTestId="hint"
          />
        </>,
      ),
    );
    for (const id of ['plain', 'hint']) {
      const content = container.querySelector(`[data-testid="${id}"] > div`);
      expect(content?.classList.contains('min-h-10')).toBe(true);
      expect(content?.classList.contains('h-10')).toBe(false);
    }
  } finally {
    act(() => root.unmount());
  }
});
