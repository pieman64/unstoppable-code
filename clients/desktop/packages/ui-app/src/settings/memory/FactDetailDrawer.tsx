'use client';

import type { JSX } from 'react';
import { X } from '@canopy/ui-shared/icons/AppIcons';
import type { ExplorerFactDetail } from '@canopy/protocol/settings/organization-memory';
import { withPrivacyClass } from '../account/privacy-class';
import { SettingsLink, useSettingsPrivacy } from '../host';

interface FactDetailDrawerProps {
  orgId: string;
  detail: ExplorerFactDetail;
  onClose?: () => void;
  embedded?: boolean;
}

export function FactDetailDrawer({
  orgId,
  detail,
  onClose,
  embedded = false,
}: FactDetailDrawerProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  return (
    <aside
      className={
        embedded
          ? 'rounded-xl border bg-card p-5'
          : // Content-only variant: the shared Sheet supplies the sliding
            // panel, backdrop, and dismiss behavior.
            'h-full overflow-y-auto p-5'
      }
      aria-label="Memory fact detail"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-wrap gap-2 text-xs">
          <span
            className={`rounded-full px-2 py-0.5 font-semibold ${
              detail.liveness === 'live'
                ? 'bg-success-subtle fg-success'
                : 'bg-warning-subtle fg-warning'
            }`}
          >
            {detail.liveness === 'live' ? 'LIVE' : 'SUPERSEDED'}
          </span>
          <span className="rounded-full bg-base px-2 py-0.5 fg-secondary">
            {detail.evidenceType}
          </span>
        </div>
        {onClose !== undefined && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 fg-secondary hover:bg-base hover:fg-primary"
            aria-label="Close fact detail"
          >
            <X size={18} />
          </button>
        )}
      </div>

      <h2 className="mt-5 text-lg font-semibold fg-primary">Fact</h2>
      <p
        className={withPrivacyClass(
          'mt-2 whitespace-pre-wrap text-s leading-6 fg-primary',
          blockClassName,
        )}
      >
        {detail.factText}
      </p>

      {detail.evidenceQuote !== null && (
        <section className="mt-6">
          <h3 className="text-sm font-semibold fg-primary">Evidence</h3>
          <blockquote
            className={withPrivacyClass(
              'mt-2 rounded-lg border-l-2 border-line-accent bg-accent/5 px-4 py-3 text-s italic fg-secondary',
              blockClassName,
            )}
          >
            “{detail.evidenceQuote}”
          </blockquote>
        </section>
      )}

      <section className="mt-6">
        <h3 className="text-sm font-semibold fg-primary">Provenance</h3>
        {detail.sources.length === 0 ? (
          <p className="mt-2 text-s fg-secondary">No source rows recorded.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {detail.sources.map((source) => (
              <li
                key={source.id}
                className="rounded-lg border bg-base p-3 text-xs fg-secondary"
              >
                <div
                  className={withPrivacyClass(
                    'font-medium fg-primary',
                    blockClassName,
                  )}
                >
                  {source.actor?.name ?? source.actor?.email ?? 'Unknown actor'}
                </div>
                <div className="mt-1">
                  {new Date(source.referenceTime).toLocaleString()}
                </div>
                <SettingsLink
                  className="mt-2 inline-block font-medium fg-accent hover:underline"
                  href={`/organization/${orgId}/memory/fact/${detail.id}?source=${source.id}`}
                >
                  View source
                </SettingsLink>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.supersessionChain.length > 1 && (
        <section className="mt-6">
          <h3 className="text-sm font-semibold fg-primary">
            Supersession chain
          </h3>
          <ol className="mt-2 space-y-2 border-l pl-4">
            {detail.supersessionChain.map((fact) => (
              <li key={fact.id} className="relative text-xs fg-secondary">
                <span className="absolute -left-4.75 top-1 h-2 w-2 rounded-full bg-fg-tertiary" />
                <SettingsLink
                  href={`/organization/${orgId}/memory/fact/${fact.id}`}
                  className={withPrivacyClass(
                    'line-clamp-2 hover:fg-accent',
                    blockClassName,
                  )}
                >
                  {fact.factText}
                </SettingsLink>
              </li>
            ))}
          </ol>
        </section>
      )}
    </aside>
  );
}
