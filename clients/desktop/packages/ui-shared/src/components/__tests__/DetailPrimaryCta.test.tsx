/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DETAIL_PRIMARY_CTA_TEST_ID,
  DetailPrimaryCta,
  type DetailPrimaryCtaProps,
} from '../DetailPrimaryCta';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let container: HTMLDivElement;
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

function render(props: Partial<DetailPrimaryCtaProps>): HTMLButtonElement {
  act(() => {
    root.render(
      <DetailPrimaryCta
        state="try"
        onTry={(): void => {}}
        onInstall={(): void => {}}
        {...props}
      />,
    );
  });
  const button = container.querySelector<HTMLButtonElement>(
    `[data-testid="${DETAIL_PRIMARY_CTA_TEST_ID}"]`,
  );
  if (!button) throw new Error('CTA not rendered');
  return button;
}

describe('DetailPrimaryCta', () => {
  it('renders an enabled accent Try it that launches', () => {
    const onTry = jest.fn();
    const onInstall = jest.fn();
    const button = render({ onTry, onInstall, subjectName: 'Linear' });
    expect(button.textContent).toBe('Try it');
    expect(button.getAttribute('aria-label')).toBe('Try it with Linear');
    expect(button.dataset.state).toBe('try');
    expect(button.className).toContain('bg-accent');
    expect(button.querySelector('svg')).not.toBeNull();
    act(() => button.click());
    expect(onTry).toHaveBeenCalledTimes(1);
    expect(onInstall).not.toHaveBeenCalled();
  });

  it('routes Install to the host install flow', () => {
    const onTry = jest.fn();
    const onInstall = jest.fn();
    const button = render({
      state: 'install',
      onTry,
      onInstall,
      subjectName: 'Linear',
    });
    expect(button.textContent).toBe('Install');
    expect(button.getAttribute('aria-label')).toBe('Install Linear');
    act(() => button.click());
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(onTry).not.toHaveBeenCalled();
  });

  it('disables Try it while account or installation state is unresolved', () => {
    const onTry = jest.fn();
    const button = render({ state: 'pending', onTry });
    expect(button.textContent).toBe('Try it');
    expect(button.disabled).toBe(true);
    expect(button.dataset.state).toBe('pending');
    act(() => button.click());
    expect(onTry).not.toHaveBeenCalled();
  });

  it('shows busy copy and blocks repeat activation', () => {
    const tryButton = render({ busy: true });
    expect(tryButton.textContent).toBe('Opening chat…');
    expect(tryButton.disabled).toBe(true);
    expect(tryButton.dataset.state).toBe('busy');

    const installButton = render({
      state: 'install',
      busy: true,
      installBusyLabel: 'Installing…',
    });
    expect(installButton.textContent).toBe('Installing…');
    expect(
      installButton.getAttribute('aria-label')?.startsWith('Installing…'),
    ).toBe(true);
  });

  it('accepts a host install label', () => {
    const button = render({ state: 'install', installLabel: 'Connect' });
    expect(button.textContent).toBe('Connect');
  });
});
