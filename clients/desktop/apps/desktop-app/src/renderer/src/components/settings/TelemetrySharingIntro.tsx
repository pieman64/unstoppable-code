import type { JSX } from 'react';
import { Notice } from '@canopy/ui-shared/components';
import { brandText } from '@/lib/brand';

interface TelemetrySharingIntroProps {
  /** Extra classes applied to the intro container. */
  className?: string;
}

/**
 * Shared, presentational data-use copy for telemetry sharing (always shown,
 * not a show-more toggle; the `telemetry-disclosure` test ids predate the
 * rename and stay for the specs that key on them). Rendered
 * by both the post-link opt-in modal (Settings → Account) and the persistent
 * Settings → Privacy tab so the user always sees the same description of what
 * leaves the machine, who can see it, and how it is protected.
 *
 * Pure: no `window.api`, no stores, no side effects.
 */
export function TelemetrySharingIntro({
  className = '',
}: TelemetrySharingIntroProps): JSX.Element {
  return (
    <div
      className={`flex flex-col gap-3 ${className}`}
      data-testid="telemetry-disclosure"
    >
      {/*
        Deliberately stops at what sharing is FOR. Encryption and secret
        scrubbing are stated once, in the notice below, so restating them here
        made the member read the same guarantees twice before reaching a
        single control.
      */}
      {/*
        The closing sentence is basic usage analytics, not activity sharing:
        sent messages are counted whatever the scopes below are set to. It is a
        passing aside, so it rides on the intro. It makes no "never your
        prompts" promise, which beside this intro read as a claim about sharing.
      */}
      <p className="text-xs text-pretty fg-secondary">
        Activity sharing syncs your agent activity to {brandText.appName} Cloud
        so you can revisit and search past runs from anywhere, pick up work
        across machines, and share runs with your team.{' '}
        <span data-testid="telemetry-disclosure-basic-usage">
          {brandText.appName} always counts how many messages you send.
        </span>
      </p>

      {/* The guarantees are one settings notice between the intro and the
          choices, not a sub-heading and a list. */}
      <Notice
        role="none"
        title="How your data is protected"
        data-testid="telemetry-disclosure-protection"
      >
        Secrets like API keys are scrubbed before anything leaves the app, and
        your uploaded transcripts and plans are encrypted and stored securely on{' '}
        {brandText.appName} Cloud.
      </Notice>
    </div>
  );
}
