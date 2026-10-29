'use client';

import type { JSX, MouseEvent, ReactNode } from 'react';
import type { TryItSignInGateState } from '@canopy/protocol/try-it/continuation';
import { Notice, NoticeButton, noticeButtonClassName } from './Notice';

/**
 * An authentication control. `href` renders a link that runs `onActivate`
 * before the browser follows it; without `href` it is a button that runs
 * `onActivate` instead of navigating.
 */
export interface TryItSignInAction {
  href?: string;
  onActivate?: (activation: { newTab: boolean }) => void;
}

/**
 * The setup step a signed-in Try it chat offers before its saved prompt runs
 * (CAN-4451). The host resolves the target and owns the attempt; this only
 * names where the primary action opens authorization.
 */
export interface TryItSetupAction {
  /** False for a connection that needs no provider sign-in: reads Connect. */
  requiresSignIn: boolean;
  /** Where the primary action opens: the host's own pane or the default browser. */
  route: 'embedded' | 'external';
  onActivate: () => void;
  /** An embedded route's default-browser alternative. */
  onActivateExternal?: () => void;
  /** Cancels the in-flight attempt; omit when the host can't cancel it. */
  onCancel?: () => void;
}

export interface TryItSignInNoticeProps {
  state: TryItSignInGateState;
  /** The Try it capability's display name. */
  capabilityName: string;
  /** Set only after the host durably saved the continuation. */
  promptSaved?: boolean;
  /**
   * What a `retry` recovers: a sign-in that didn't finish, or a signed-in
   * continuation that couldn't run, or a setup step that didn't finish.
   * Defaults to `authentication`.
   */
  retry?: 'authentication' | 'continuation' | 'setup';
  /** Host-approved copy for a continuation or setup failure. */
  errorMessage?: string;
  signIn?: TryItSignInAction;
  createAccount?: TryItSignInAction;
  /** Retries the signed-in continuation, never authentication. */
  onRetryContinuation?: () => void;
  /** Offers setup for `setup-required`, `authorizing` and setup `retry`. */
  setup?: TryItSetupAction;
  /** Disables every action without removing it. */
  disabled?: boolean;
  testId?: string;
}

function AuthControl({
  action,
  variant,
  disabled,
  testId,
  children,
}: {
  action: TryItSignInAction;
  variant: 'primary' | 'secondary';
  disabled: boolean;
  testId: string;
  children: ReactNode;
}): JSX.Element {
  if (action.href === undefined) {
    return (
      <NoticeButton
        variant={variant}
        disabled={disabled}
        onClick={() => action.onActivate?.({ newTab: false })}
        data-testid={testId}
      >
        {children}
      </NoticeButton>
    );
  }
  if (disabled) {
    // No href, so neither activation nor middle-click can navigate.
    return (
      <a
        role="link"
        aria-disabled="true"
        className={noticeButtonClassName(
          variant,
          'pointer-events-none opacity-50',
        )}
        data-testid={testId}
      >
        {children}
      </a>
    );
  }
  // Enter and every left click (modified or not) dispatch `click`; a middle
  // click opens a tab through `auxclick`. A right click only opens the
  // context menu and must not save anything.
  const activate = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.button === 0 || event.button === 1)
      action.onActivate?.({
        newTab:
          event.button === 1 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey,
      });
  };
  return (
    <a
      href={action.href}
      rel="noopener"
      className={noticeButtonClassName(variant)}
      onClick={activate}
      onAuxClick={activate}
      data-testid={testId}
    >
      {children}
    </a>
  );
}

function SetupActions({
  setup,
  label,
  disabled,
  testId,
  primaryTestId,
}: {
  setup: TryItSetupAction;
  label: string;
  disabled: boolean;
  testId: string;
  primaryTestId: string;
}): JSX.Element {
  // A no-auth connection has no provider page, so it has no browser choice.
  const external =
    setup.requiresSignIn &&
    setup.route === 'embedded' &&
    setup.onActivateExternal !== undefined
      ? setup.onActivateExternal
      : undefined;
  return (
    <>
      {external && (
        <NoticeButton
          variant="secondary"
          disabled={disabled}
          onClick={external}
          data-testid={`${testId}-authorize-external`}
        >
          Open in default browser
        </NoticeButton>
      )}
      <NoticeButton
        variant="primary"
        disabled={disabled}
        onClick={setup.onActivate}
        data-testid={primaryTestId}
      >
        {label}
      </NoticeButton>
    </>
  );
}

/**
 * The composer notice for a guest Try it chat whose capability needs an
 * account (CAN-4396), and for its signed-in setup step (CAN-4451). Pure display: the host resolves `state` with
 * `resolveTryItSignInGate`, owns persistence, and supplies the actions.
 */
export function TryItSignInNotice({
  state,
  capabilityName,
  promptSaved = false,
  retry = 'authentication',
  errorMessage,
  signIn,
  createAccount,
  onRetryContinuation,
  setup,
  disabled = false,
  testId = 'try-it-sign-in-notice',
}: TryItSignInNoticeProps): JSX.Element | null {
  if (state === 'hidden') return null;
  const common = { 'data-testid': testId, 'data-state': state };

  if (state === 'sign-in') {
    const actions =
      signIn || createAccount ? (
        <>
          {createAccount && (
            <AuthControl
              action={createAccount}
              variant="secondary"
              disabled={disabled}
              testId={`${testId}-create-account`}
            >
              Create an account
            </AuthControl>
          )}
          {signIn && (
            <AuthControl
              action={signIn}
              variant="primary"
              disabled={disabled}
              testId={`${testId}-sign-in`}
            >
              Sign in to continue
            </AuthControl>
          )}
        </>
      ) : undefined;
    return promptSaved ? (
      <Notice
        {...common}
        title={`Sign in to use ${capabilityName}`}
        actions={actions}
      >
        Your prompt is saved so you can continue after sign-in.
      </Notice>
    ) : (
      <Notice {...common} actions={actions}>
        Sign in to use {capabilityName}.
      </Notice>
    );
  }

  if (state === 'signing-in') {
    return <Notice {...common}>Signing in…</Notice>;
  }

  if (state === 'continuing') {
    return <Notice {...common}>Continuing your prompt…</Notice>;
  }

  if (state === 'authorizing') {
    return (
      <Notice
        {...common}
        actions={
          setup?.onCancel ? (
            <NoticeButton
              variant="secondary"
              onClick={setup.onCancel}
              data-testid={`${testId}-cancel`}
            >
              Cancel
            </NoticeButton>
          ) : undefined
        }
      >
        {setup?.requiresSignIn === false
          ? `Connecting ${capabilityName}…`
          : `Waiting for ${capabilityName} sign-in…`}
      </Notice>
    );
  }

  if (state === 'setup-required' && setup) {
    const verb = setup.requiresSignIn ? 'Authorize' : 'Connect';
    return (
      <Notice
        {...common}
        title={`${verb} ${capabilityName}`}
        actions={
          <SetupActions
            setup={setup}
            label={verb}
            disabled={disabled}
            testId={testId}
            primaryTestId={`${testId}-authorize`}
          />
        }
      >
        {setup.requiresSignIn
          ? `Your prompt is saved and continues after you authorize ${capabilityName}.`
          : `Your prompt is saved and continues after ${capabilityName} connects.`}
      </Notice>
    );
  }

  if (state === 'setup-required') {
    return (
      <Notice {...common} intent="attention" title="You're signed in">
        {capabilityName} still needs setup before this prompt can run.
      </Notice>
    );
  }

  if (retry === 'setup') {
    return (
      <Notice
        {...common}
        data-retry="setup"
        intent="attention"
        actions={
          setup ? (
            <SetupActions
              setup={setup}
              label="Retry"
              disabled={disabled}
              testId={testId}
              primaryTestId={`${testId}-retry`}
            />
          ) : undefined
        }
      >
        {errorMessage ??
          `${setup?.requiresSignIn === false ? "Connection didn't finish" : "Authorization didn't finish"}. ${capabilityName} still needs setup.`}
      </Notice>
    );
  }

  if (retry === 'continuation') {
    return (
      <Notice
        {...common}
        data-retry="continuation"
        intent="attention"
        actions={
          onRetryContinuation ? (
            <NoticeButton
              variant="primary"
              disabled={disabled}
              onClick={onRetryContinuation}
              data-testid={`${testId}-retry`}
            >
              Try again
            </NoticeButton>
          ) : undefined
        }
      >
        {errorMessage ?? "Your prompt couldn't continue."}
      </Notice>
    );
  }

  return (
    <Notice
      {...common}
      data-retry="authentication"
      intent="attention"
      title="Sign-in didn't finish"
      actions={
        signIn ? (
          <AuthControl
            action={signIn}
            variant="primary"
            disabled={disabled}
            testId={`${testId}-retry`}
          >
            Try again
          </AuthControl>
        ) : undefined
      }
    >
      {capabilityName} still needs an account.
    </Notice>
  );
}
