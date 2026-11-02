import { memo, type JSX } from 'react';
import type {
  ExplorerFact,
  ExplorerRankedFact,
} from '@canopy/protocol/settings/organization-memory';
import { withPrivacyClass } from '../account/privacy-class';
import { useSettingsPrivacy } from '../host';

interface FactCardProps {
  fact: ExplorerFact | ExplorerRankedFact;
  onSelect?: (factId: string) => void;
}

function isRanked(
  fact: ExplorerFact | ExplorerRankedFact,
): fact is ExplorerRankedFact {
  return 'score' in fact;
}

// Memoized: list views append pages by replacing the array while keeping the
// same fact object references, so unchanged cards skip re-rendering as long as
// callers pass a stable onSelect (see the useCallback in fact-corpus-view).
function FactCardComponent({ fact, onSelect }: FactCardProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const content = (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`rounded-full px-2 py-0.5 font-semibold ${
            fact.liveness === 'live'
              ? 'bg-success-subtle fg-success'
              : 'bg-warning-subtle fg-warning'
          }`}
        >
          {fact.liveness === 'live' ? 'LIVE' : 'SUPERSEDED'}
        </span>
        <span className="rounded-full bg-base px-2 py-0.5 font-medium fg-secondary">
          {fact.evidenceType}
        </span>
        {isRanked(fact) && (
          <span className="ml-auto tabular-nums fg-secondary">
            score {fact.score.toFixed(3)}
          </span>
        )}
      </div>
      <p
        className={withPrivacyClass(
          'mt-3 line-clamp-4 text-s leading-6 fg-primary',
          blockClassName,
        )}
      >
        {fact.factText}
      </p>
      {fact.evidenceQuote !== null && (
        <p
          className={withPrivacyClass(
            'mt-2 line-clamp-2 border-l-2 border-line-accent pl-3 text-xs italic fg-secondary',
            blockClassName,
          )}
        >
          “{fact.evidenceQuote}”
        </p>
      )}
      {fact.entities.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {fact.entities.map((entity) => (
            <span
              key={entity.id}
              className={withPrivacyClass(
                'rounded-md border bg-base px-2 py-0.5 text-xs fg-secondary',
                blockClassName,
              )}
            >
              {entity.canonicalName}
            </span>
          ))}
        </div>
      )}
      <time
        dateTime={fact.createdAt}
        className="mt-3 block text-xs fg-tertiary"
      >
        {new Date(fact.createdAt).toLocaleString()}
      </time>
    </>
  );

  return (
    <article
      className="rounded-xl border bg-card p-4 transition-colors hover:border-fg-secondary/30"
      data-testid={`memory-fact-${fact.id}`}
    >
      {onSelect === undefined ? (
        <div className="w-full text-left">{content}</div>
      ) : (
        <button
          type="button"
          data-settings-control="row"
          className="w-full text-left"
          onClick={() => onSelect(fact.id)}
        >
          {content}
        </button>
      )}
    </article>
  );
}

export const FactCard = memo(FactCardComponent);
