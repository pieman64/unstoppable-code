import { type JSX, type ReactNode, useId, useState } from 'react';
import { CONSENT_TOS_VERSION } from '@canopy/desktop-shared/constants/consent';
import { BrandLogo } from '@/components/BrandLogo';
import { brandText } from '@/lib/brand';
import { useCanopyLegalUrls } from '@/hooks/useCanopyLegalUrls';

export interface LegalConsentGateProps {
  /**
   * Called once the user has accepted and the acceptance has been persisted.
   * The host (`App.tsx`) unmounts the gate and lets startup proceed.
   */
  onAccepted: () => void;
}

function openExternal(url: string): void {
  void window.api.browser.openExternal({ url });
}

interface LegalDocumentLinkProps {
  url: string | null;
  testId: string;
  children: ReactNode;
}

/**
 * A legal document name in the consent sentence. It sits outside the
 * checkbox's `<label>`, so clicking it never toggles acceptance (CAN-2621).
 * It opens the Cloud-hosted page once the base URL resolves; until then, or
 * in a local build with no base URL configured, it is inert text.
 */
function LegalDocumentLink({
  url,
  testId,
  children,
}: LegalDocumentLinkProps): JSX.Element {
  if (!url) {
    return <span data-testid={testId}>{children}</span>;
  }
  return (
    <button
      type="button"
      data-testid={testId}
      className="underline underline-offset-2 hover:fg-primary"
      onClick={(): void => openExternal(url)}
    >
      {children}
    </button>
  );
}

/**
 * Blocking first-run legal gate (CAN-934). Presented before the app shell on
 * every first run, independent of the guest-mode / cloud-sign-in feature flags,
 * so every user accepts the Terms of Service and Privacy Policy before using the
 * app. Acceptance is persisted to `PreferencesData.legalConsentAcceptedAt` +
 * `legalConsentTosVersion`; until it is recorded the shell stays gated. All
 * product names come from the brand runtime per the branding rules.
 */
export function LegalConsentGate({
  onAccepted,
}: LegalConsentGateProps): JSX.Element {
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { termsUrl, privacyUrl } = useCanopyLegalUrls();
  const checkboxId = useId();

  const handleContinue = async (): Promise<void> => {
    if (!agreed || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await window.api.savePreferences({
        legalConsentAcceptedAt: new Date().toISOString(),
        legalConsentTosVersion: CONSENT_TOS_VERSION,
      });
      onAccepted();
    } catch {
      setError('Could not save your acceptance. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-modal flex flex-col items-center justify-center bg-base fg-primary animate-fade-in"
      data-testid="legal-consent-gate"
    >
      {/* Keep the window draggable behind the centered content. */}
      <div className="electron-drag h-10 shrink-0 w-full" />
      <div className="flex flex-1 w-full items-center justify-center overflow-y-auto px-6 pb-10">
        <div className="w-full max-w-md flex flex-col items-center gap-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <BrandLogo size={72} className="select-none fg-accent" />
            <div className="flex flex-col items-center gap-2">
              <h1 className="text-2xl font-semibold">
                Welcome to {brandText.appName}
              </h1>
              <p className="text-s fg-secondary">
                Before you get started, please review and accept our terms.
              </p>
            </div>
          </div>

          {error && (
            <p
              className="w-full text-center text-s fg-destructive"
              data-testid="legal-consent-error"
              role="alert"
            >
              {error}
            </p>
          )}

          <div className="flex w-full items-start gap-3 rounded-lg border bg-card p-4 text-left">
            <input
              id={checkboxId}
              type="checkbox"
              aria-label="I have read and agree to the Terms of Service and Privacy Policy"
              checked={agreed}
              onChange={(e): void => setAgreed(e.target.checked)}
              disabled={submitting}
              data-testid="legal-consent-checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-accent"
            />
            {/* Only the agreement phrase is the checkbox label; the document
                names stay outside it so clicking one never accepts them. */}
            <p className="text-s fg-secondary">
              <label
                htmlFor={checkboxId}
                className="cursor-pointer"
                data-testid="legal-consent-label"
              >
                I have read and agree to the
              </label>{' '}
              <LegalDocumentLink
                url={termsUrl}
                testId="legal-consent-terms-link"
              >
                Terms of Service
              </LegalDocumentLink>{' '}
              and{' '}
              <LegalDocumentLink
                url={privacyUrl}
                testId="legal-consent-privacy-link"
              >
                Privacy Policy
              </LegalDocumentLink>
              .
            </p>
          </div>

          <button
            type="button"
            data-testid="legal-consent-accept"
            disabled={!agreed || submitting}
            onClick={(): void => void handleContinue()}
            className="w-full rounded-md bg-accent px-4 py-2.5 text-s font-medium fg-emphasis transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Saving…' : 'Agree & continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
