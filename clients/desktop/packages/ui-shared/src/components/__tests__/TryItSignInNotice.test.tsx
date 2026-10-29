/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  TryItSignInNotice,
  type TryItSignInNoticeProps,
} from '../TryItSignInNotice';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('TryItSignInNotice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(
    props: Partial<TryItSignInNoticeProps> &
      Pick<TryItSignInNoticeProps, 'state'>,
  ): void {
    act(() => {
      root.render(<TryItSignInNotice capabilityName="Linear" {...props} />);
    });
  }

  function notice(): HTMLElement | null {
    return container.querySelector('[data-testid="try-it-sign-in-notice"]');
  }

  function control(suffix: string): HTMLElement {
    const element = container.querySelector(
      `[data-testid="try-it-sign-in-notice-${suffix}"]`,
    );
    if (!(element instanceof HTMLElement)) throw new Error(`no ${suffix}`);
    return element;
  }

  function mouse(element: HTMLElement, type: string, button: number): void {
    act(() => {
      element.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, button }),
      );
    });
  }

  beforeAll(() => {
    // jsdom cannot navigate; keep link activation in-document.
    document.addEventListener('click', (event) => event.preventDefault());
  });

  it('renders nothing when hidden', () => {
    render({ state: 'hidden' });
    expect(container.innerHTML).toBe('');
  });

  it('offers sign-in and account creation as links', () => {
    const onSignIn = jest.fn();
    const onCreate = jest.fn();
    render({
      state: 'sign-in',
      signIn: { href: '/login?callbackURL=%2Fchat%2Fc1', onActivate: onSignIn },
      createAccount: { href: '/login?mode=signup', onActivate: onCreate },
    });
    expect(notice()?.getAttribute('data-state')).toBe('sign-in');
    expect(notice()?.getAttribute('role')).toBe('status');
    expect(notice()?.textContent).toContain('Sign in to use Linear.');
    expect(notice()?.textContent).not.toContain('saved');
    const signIn = control('sign-in');
    expect(signIn.tagName).toBe('A');
    expect(signIn.textContent).toBe('Sign in to continue');
    expect(signIn.getAttribute('href')).toBe('/login?callbackURL=%2Fchat%2Fc1');
    expect(control('create-account').textContent).toBe('Create an account');
    // The recommended action is last.
    const actions = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a'),
      (anchor) => anchor.getAttribute('data-testid'),
    );
    expect(actions).toEqual([
      'try-it-sign-in-notice-create-account',
      'try-it-sign-in-notice-sign-in',
    ]);
    mouse(control('create-account'), 'click', 0);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it('only promises a saved prompt when the host saved it', () => {
    render({ state: 'sign-in', promptSaved: true, signIn: { href: '/login' } });
    expect(notice()?.textContent).toBe(
      'Sign in to use Linear. Your prompt is saved so you can continue after sign-in.Sign in to continue',
    );
  });

  it('activates on left, modified and middle clicks but not right clicks', () => {
    const onActivate = jest.fn();
    render({ state: 'sign-in', signIn: { href: '/login', onActivate } });
    const link = control('sign-in');
    mouse(link, 'click', 0);
    act(() => {
      link.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
          metaKey: true,
        }),
      );
    });
    mouse(link, 'auxclick', 1);
    mouse(link, 'auxclick', 2);
    mouse(link, 'contextmenu', 2);
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it('activates from the keyboard', () => {
    const onActivate = jest.fn();
    render({ state: 'sign-in', signIn: { href: '/login', onActivate } });
    // Enter on a focused link dispatches a synthetic left click.
    const link = control('sign-in');
    link.focus();
    act(() => {
      link.click();
    });
    expect(document.activeElement).toBe(link);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('renders a button when the host has no href', () => {
    const onActivate = jest.fn();
    render({ state: 'sign-in', signIn: { onActivate } });
    const button = control('sign-in');
    expect(button.tagName).toBe('BUTTON');
    mouse(button, 'click', 0);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('suppresses navigation and callbacks when disabled', () => {
    const onActivate = jest.fn();
    const onButton = jest.fn();
    render({
      state: 'sign-in',
      disabled: true,
      signIn: { href: '/login', onActivate },
      createAccount: { onActivate: onButton },
    });
    const link = control('sign-in');
    expect(link.hasAttribute('href')).toBe(false);
    expect(link.getAttribute('aria-disabled')).toBe('true');
    mouse(link, 'click', 0);
    mouse(link, 'auxclick', 1);
    const button = control('create-account');
    expect(button).toHaveProperty('disabled', true);
    mouse(button, 'click', 0);
    expect(onActivate).not.toHaveBeenCalled();
    expect(onButton).not.toHaveBeenCalled();
  });

  it.each([
    ['signing-in', 'Signing in…'],
    ['continuing', 'Continuing your prompt…'],
    [
      'setup-required',
      "You're signed in. Linear still needs setup before this prompt can run.",
    ],
  ] as const)('shows %s as information only', (state, copy) => {
    render({
      state,
      signIn: { href: '/login' },
      createAccount: { href: '/login?mode=signup' },
      onRetryContinuation: jest.fn(),
    });
    expect(notice()?.getAttribute('data-state')).toBe(state);
    expect(notice()?.textContent).toBe(copy);
    expect(container.querySelector('a, button')).toBeNull();
  });

  it('retries a sign-in that did not finish', () => {
    const onActivate = jest.fn();
    render({ state: 'retry', signIn: { href: '/login', onActivate } });
    expect(notice()?.getAttribute('data-retry')).toBe('authentication');
    expect(notice()?.textContent).toBe(
      "Sign-in didn't finish. Linear still needs an account.Try again",
    );
    const retry = control('retry');
    expect(retry.getAttribute('href')).toBe('/login');
    mouse(retry, 'click', 0);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('retries the continuation, not authentication, once signed in', () => {
    const onRetry = jest.fn();
    const onSignIn = jest.fn();
    render({
      state: 'retry',
      retry: 'continuation',
      signIn: { href: '/login', onActivate: onSignIn },
      onRetryContinuation: onRetry,
    });
    expect(notice()?.getAttribute('data-retry')).toBe('continuation');
    expect(notice()?.textContent).toBe(
      "Your prompt couldn't continue.Try again",
    );
    expect(container.querySelector('a')).toBeNull();
    mouse(control('retry'), 'click', 0);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it('uses host-approved error copy for a blocked handoff', () => {
    render({
      state: 'retry',
      retry: 'continuation',
      errorMessage: 'Finish or clear your New Task draft to continue.',
    });
    expect(notice()?.textContent).toBe(
      'Finish or clear your New Task draft to continue.',
    );
  });

  it('announces state changes in the same live region', () => {
    render({ state: 'sign-in', signIn: { href: '/login' } });
    const region = notice();
    render({ state: 'signing-in' });
    expect(notice()).toBe(region);
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.textContent).toBe('Signing in…');
  });
  describe('setup (CAN-4451)', () => {
    function setupAction(
      overrides: Partial<NonNullable<TryItSignInNoticeProps['setup']>> = {},
    ): NonNullable<TryItSignInNoticeProps['setup']> {
      return {
        requiresSignIn: true,
        route: 'embedded',
        onActivate: jest.fn(),
        onActivateExternal: jest.fn(),
        onCancel: jest.fn(),
        ...overrides,
      };
    }

    function query(suffix: string): Element | null {
      return container.querySelector(
        `[data-testid="try-it-sign-in-notice-${suffix}"]`,
      );
    }

    it('keeps the no-action notice without a setup descriptor', () => {
      render({ state: 'setup-required' });
      expect(notice()?.textContent).toBe(
        "You're signed in. Linear still needs setup before this prompt can run.",
      );
      expect(container.querySelector('button, a')).toBeNull();
    });

    it('offers Authorize and the default browser for an embedded route', () => {
      const setup = setupAction();
      render({ state: 'setup-required', setup });
      expect(notice()?.getAttribute('data-state')).toBe('setup-required');
      expect(notice()?.textContent).toBe(
        'Authorize Linear. Your prompt is saved and continues after you authorize Linear.Open in default browserAuthorize',
      );
      mouse(control('authorize'), 'click', 0);
      expect(setup.onActivate).toHaveBeenCalledTimes(1);
      mouse(control('authorize-external'), 'click', 0);
      expect(setup.onActivateExternal).toHaveBeenCalledTimes(1);
    });

    it('omits the browser alternative for an external route', () => {
      render({
        state: 'setup-required',
        setup: setupAction({ route: 'external' }),
      });
      expect(query('authorize')).not.toBeNull();
      expect(query('authorize-external')).toBeNull();
    });

    it('reads Connect for a connection without provider sign-in', () => {
      render({
        state: 'setup-required',
        setup: setupAction({ requiresSignIn: false }),
      });
      expect(notice()?.textContent).toBe(
        'Connect Linear. Your prompt is saved and continues after Linear connects.Connect',
      );
      expect(query('authorize-external')).toBeNull();
      render({
        state: 'authorizing',
        setup: setupAction({ requiresSignIn: false }),
      });
      expect(notice()?.textContent).toBe('Connecting Linear…Cancel');
    });

    it('waits with a usable Cancel even while starting is disabled', () => {
      const setup = setupAction();
      render({ state: 'authorizing', setup, disabled: true });
      expect(notice()?.getAttribute('data-state')).toBe('authorizing');
      expect(notice()?.textContent).toBe('Waiting for Linear sign-in…Cancel');
      expect(query('authorize')).toBeNull();
      const cancel = control('cancel');
      expect(cancel.hasAttribute('disabled')).toBe(false);
      mouse(cancel, 'click', 0);
      expect(setup.onCancel).toHaveBeenCalledTimes(1);
    });

    it('omits Cancel when the host cannot cancel', () => {
      render({
        state: 'authorizing',
        setup: setupAction({ onCancel: undefined }),
      });
      expect(query('cancel')).toBeNull();
    });

    it('disables setup actions without removing them', () => {
      const setup = setupAction();
      render({ state: 'setup-required', setup, disabled: true });
      expect(control('authorize').hasAttribute('disabled')).toBe(true);
      expect(control('authorize-external').hasAttribute('disabled')).toBe(true);
    });

    it('retries setup with the same route policy', () => {
      const setup = setupAction();
      render({ state: 'retry', retry: 'setup', setup });
      expect(notice()?.getAttribute('data-retry')).toBe('setup');
      expect(notice()?.textContent).toBe(
        "Authorization didn't finish. Linear still needs setup.Open in default browserRetry",
      );
      mouse(control('retry'), 'click', 0);
      expect(setup.onActivate).toHaveBeenCalledTimes(1);
      render({
        state: 'retry',
        retry: 'setup',
        setup,
        errorMessage: 'Add your Linear API key in Settings to continue.',
      });
      expect(notice()?.textContent).toBe(
        'Add your Linear API key in Settings to continue.Open in default browserRetry',
      );
    });

    it('announces authorization progress in the same live region', () => {
      render({ state: 'setup-required', setup: setupAction() });
      const region = notice();
      render({ state: 'authorizing', setup: setupAction() });
      expect(notice()).toBe(region);
      expect(region?.getAttribute('aria-live')).toBe('polite');
      render({ state: 'retry', retry: 'setup', setup: setupAction() });
      expect(notice()).toBe(region);
    });
  });
});
