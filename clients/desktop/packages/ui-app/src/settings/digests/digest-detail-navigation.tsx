import type { JSX } from 'react';
import { SettingsLink } from '../host';

export { digestNeighbors } from './digest-neighbors';

export interface DigestDetailNavigationProps {
  newerHref: string | null;
  olderHref: string | null;
  settingsHref: string | null;
}

export function DigestDetailNavigation({
  newerHref,
  olderHref,
  settingsHref,
}: DigestDetailNavigationProps): JSX.Element {
  return (
    <nav
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-3 text-xs"
      aria-label="Digest navigation"
      data-testid="digest-detail-navigation"
    >
      <div className="flex gap-3">
        {olderHref ? (
          <SettingsLink href={olderHref} className="fg-accent hover:underline">
            ← Older
          </SettingsLink>
        ) : (
          <span className="fg-secondary">← Older</span>
        )}
        {newerHref ? (
          <SettingsLink href={newerHref} className="fg-accent hover:underline">
            Newer →
          </SettingsLink>
        ) : (
          <span className="fg-secondary">Newer →</span>
        )}
      </div>
      {settingsHref && (
        <SettingsLink href={settingsHref} className="fg-accent hover:underline">
          Digest cadence settings
        </SettingsLink>
      )}
    </nav>
  );
}
