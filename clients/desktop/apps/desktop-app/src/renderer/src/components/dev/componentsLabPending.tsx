import { Heading } from '@canopy/ui-shared/components';
import type { JSX } from 'react';
import {
  Badge,
  Fact,
  FactList,
  ValueRow,
  ValueRows,
} from '@canopy/ui-shared/components';
import { SpecimenPanel } from './componentsLabParts';
import {
  PENDING_UNIFICATIONS,
  RATCHET_BACKLOG,
  type PendingStatus,
  type PendingUnification,
} from './componentsLabPendingData';

const STATUS_BADGE: Readonly<
  Record<PendingStatus, { label: string; tone: 'info' | 'success' | 'neutral' }>
> = {
  merging: { label: 'Merging now', tone: 'success' },
  'in-progress': { label: 'In progress', tone: 'info' },
  waiting: { label: 'Not started', tone: 'neutral' },
};

function PendingCard({
  item,
  rank,
}: {
  readonly item: PendingUnification;
  readonly rank: number;
}): JSX.Element {
  return (
    <SpecimenPanel>
      <div data-pending={item.id} className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <Heading level={3} variant="title">
              {rank}. {item.name}
            </Heading>
            <Badge tone={STATUS_BADGE[item.status].tone}>
              {STATUS_BADGE[item.status].label}
            </Badge>
          </div>
          <p className="text-xs fg-secondary">{item.count}</p>
        </div>
        <FactList labelWidth="6rem">
          <Fact label="Becomes">{item.planned}</Fact>
          <Fact label="Shared today">
            {item.shared.length > 0 ? item.shared.join(', ') : 'Nothing yet'}
          </Fact>
          {item.note ? <Fact label="Note">{item.note}</Fact> : null}
          <Fact label="Copies">
            <ul className="flex flex-col gap-0.5">
              {item.copies.map((copy) => (
                <li key={copy} className="break-all fg-secondary">
                  <code>{copy}</code>
                </li>
              ))}
            </ul>
          </Fact>
        </FactList>
      </div>
    </SpecimenPanel>
  );
}

/** The UI still waiting to be unified, from the standardization audit. */
export function PendingSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <Heading level={3} variant="label">
          Families with no ratchet yet, in priority order
        </Heading>
        {PENDING_UNIFICATIONS.map((item, index) => (
          <PendingCard key={item.id} item={item} rank={index + 1} />
        ))}
      </section>
      <section className="flex flex-col gap-3">
        <Heading level={3} variant="label">
          Ratcheted families still migrating: what each baseline still allows
        </Heading>
        <SpecimenPanel>
          <div className="max-w-160">
            <ValueRows dataTestId="components-lab-ratchet-backlog">
              {RATCHET_BACKLOG.map((row) => (
                <ValueRow
                  key={row.family}
                  label={row.family}
                  note={row.breakdown}
                  value={row.remaining.toLocaleString('en-US')}
                  title={row.baseline}
                />
              ))}
            </ValueRows>
          </div>
        </SpecimenPanel>
      </section>
    </div>
  );
}
