import type { JSX } from 'react';
import { brandText } from '@/lib/brand';

interface TelemetryDisclosureProps {
  /** Extra classes applied to the disclosure container. */
  className?: string;
}

/**
 * Shared, presentational data-disclosure copy for telemetry sharing. Rendered
 * by both the post-link opt-in modal (Settings → Account) and the persistent
 * Settings → Privacy tab so the user always sees the same description of what
 * leaves the machine, who can see it, and how it is protected.
 *
 * Pure: no `window.api`, no stores, no side effects.
 */
export function TelemetryDisclosure({
  className = '',
}: TelemetryDisclosureProps): JSX.Element {
  return (
    <div
      className={`space-y-4 text-s fg-secondary ${className}`}
      data-testid="telemetry-disclosure"
    >
      {/*
        Deliberately stops at what sharing is FOR. Encryption, secret scrubbing,
        and private-by-default are each stated on their own line in the
        protection box below, so restating them here made the member read the
        same three guarantees twice before reaching a single control.
      */}
      {/*
        The closing sentence is basic usage analytics, not activity sharing:
        sent messages are counted whatever the scopes below are set to. It is a
        passing aside, so it rides on the intro. It makes no "never your
        prompts" promise, which beside this intro read as a claim about sharing.
      */}
      <p>
        Activity sharing syncs your agent activity to {brandText.appName} Cloud
        so you can revisit and search past runs from anywhere, pick up work
        across machines, and share runs with your team.{' '}
        <span data-testid="telemetry-disclosure-basic-usage">
          {brandText.appName} always counts how many messages you send.
        </span>
      </p>

      {/* Spacing and a sub-heading carry this group; it needs no box. */}
      <div className="space-y-1" data-testid="telemetry-disclosure-protection">
        <h3 className="text-s font-medium fg-primary">
          How your data is protected
        </h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Secrets like API keys are scrubbed before anything leaves the app.
          </li>
          <li>
            Your uploaded transcripts and plans are encrypted and stored
            securely on {brandText.appName} Cloud.
          </li>
        </ul>
      </div>
    </div>
  );
}
