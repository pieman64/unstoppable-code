import { useState, type JSX } from 'react';
import { ClaudeAiCreditsFallbackErrorNotice } from '@canopy/ui-shared/components';
import { AuthLoginModal } from '../settings/AuthLoginModal';

/** Native sign-in adapter for the shared fallback explanation. */
export function ClaudeAiCreditsFallbackError(): JSX.Element {
  const [signInOpen, setSignInOpen] = useState(false);
  return (
    <>
      <ClaudeAiCreditsFallbackErrorNotice
        onSignIn={(): void => setSignInOpen(true)}
      />
      {signInOpen ? (
        <AuthLoginModal
          provider="claude"
          onClose={(): void => setSignInOpen(false)}
        />
      ) : null}
    </>
  );
}
