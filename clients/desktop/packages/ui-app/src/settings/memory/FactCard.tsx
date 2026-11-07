import { memo, type JSX } from 'react';
import type {
  ExplorerFact,
  ExplorerRankedFact,
} from '@canopy/protocol/settings/organization-memory';
import { withPrivacyClass } from '../account/privacy-class';
import { useSettingsPrivacy } from '../host';
import { Surface } from '@canopy/ui-shared/components';
import { Badge } from '@canopy/ui-shared/components/Badge';

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
        <Badge tone={fact.liveness === 'live' ? 'success' : 'warning'}>
          {fact.liveness === 'live' ? 'LIVE' : 'SUPERSEDED'}
        </Badge>
        <Badge>{fact.evidenceType}</Badge>
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
              className={blockClassName === '' ? undefined : blockClassName}
            >
              <Badge>{entity.canonicalName}</Badge>
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
    <Surface
      as="article"
      variant="card"
      interactive={onSelect !== undefined}
      padding="default"
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
    </Surface>
  );
}

export const FactCard = memo(FactCardComponent);
