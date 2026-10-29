'use client';

import { useRef, useState, type JSX } from 'react';
import type { CuratedPipelineSummary } from '@canopy/protocol/pipeline-catalog';
import {
  CuratedPipelineCatalog,
  type CuratedPipelineCatalogProps,
} from './CuratedPipelineCatalog';
import { DialogModal } from './DialogModal';
import { curatedPipelineFiltersActive } from '../lib/curated-pipeline-search';

export interface PipelineTemplatesSectionProps {
  catalog: CuratedPipelineCatalogProps;
}

const LINK_BUTTON =
  'focus-ring rounded-md px-2 py-1 text-xs fg-secondary hover:fg-primary disabled:opacity-50';

function CatalogStatus({
  catalog,
}: {
  catalog: CuratedPipelineCatalogProps;
}): JSX.Element {
  return catalog.error ? (
    <div className="flex flex-wrap items-center gap-3">
      <p role="alert" className="break-words text-sm fg-destructive">
        {catalog.error}
      </p>
      <button
        type="button"
        className={LINK_BUTTON}
        disabled={catalog.loading}
        onClick={catalog.onRefresh}
        data-testid="pipeline-templates-retry"
      >
        Try again
      </button>
    </div>
  ) : (
    <p role="status" className="text-sm fg-secondary">
      Loading pipeline templates…
    </p>
  );
}

export function PipelineTemplatesSection({
  catalog,
}: PipelineTemplatesSectionProps): JSX.Element | null {
  const [catalogOpen, setCatalogOpen] = useState(false);
  // The cards on screen when "View all templates" opened the catalog. A
  // search or filter in the catalog narrows `rows` (a host may clear them
  // while it refetches), which must not unmount the button the dialog returns
  // focus to. The cards stay until the catalog's own rows are back, or until
  // the catalog settles empty.
  const [openedCards, setOpenedCards] = useState<
    CuratedPipelineSummary[] | null
  >(null);
  const viewAllRef = useRef<HTMLButtonElement>(null);
  const dialogOpen = catalogOpen || Boolean(catalog.selectedKey);
  const filtered = curatedPipelineFiltersActive(catalog.query);
  const rowsPending =
    catalog.rows.length === 0 &&
    (filtered || catalog.loading || Boolean(catalog.error));
  const keepOpenedCards =
    openedCards !== null &&
    openedCards.length > 0 &&
    (catalogOpen || rowsPending);
  const cards = keepOpenedCards ? openedCards : catalog.rows;
  const hasCards = cards.length > 0;
  // Without cards or filters, the first page is still loading or failed: say
  // so, with a retry, instead of hiding the section. Only a successful empty
  // catalog hides it.
  const unfilteredStatus =
    !hasCards && !filtered && (Boolean(catalog.error) || catalog.loading);
  if (!hasCards && !unfilteredStatus && !dialogOpen) return null;

  const close = (): void => {
    setCatalogOpen(false);
    catalog.onBack();
    // Only a search or filter needs resetting; an unchanged query keeps the
    // pages already loaded, and the catalog's rows are on screen again.
    if (filtered) catalog.onQueryChange({ limit: 25 });
    else setOpenedCards(null);
  };

  return (
    <>
      {unfilteredStatus && (
        <section
          className="mt-10 min-w-0 space-y-3"
          aria-label="Pipeline templates"
          data-testid="pipeline-templates-section-status"
        >
          <h2 className="text-sm font-medium fg-primary">Pipeline templates</h2>
          <CatalogStatus catalog={catalog} />
        </section>
      )}
      {hasCards && (
        <section
          className="mt-10 min-w-0 space-y-3"
          aria-label="Pipeline templates"
          data-testid="pipeline-templates-section"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium fg-primary">
              Pipeline templates
            </h2>
            <button
              ref={viewAllRef}
              type="button"
              className={LINK_BUTTON}
              onClick={() => {
                setOpenedCards(cards);
                setCatalogOpen(true);
              }}
              data-testid="pipeline-templates-view-all"
            >
              View all templates
            </button>
          </div>
          {/* The kept cards stand in while the catalog reloads after a reset;
              a failed reload says so here, with a retry. */}
          {keepOpenedCards && !catalogOpen && catalog.error && (
            <CatalogStatus catalog={catalog} />
          )}
          <ul className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
            {cards.slice(0, 3).map((row) => (
              <li
                key={row.key}
                className="flex min-w-0 flex-col gap-3 rounded-lg ring-1 ring-inset ring-line-base p-3"
                data-testid={`pipeline-template-${row.key}`}
              >
                <div className="min-w-0">
                  <h3
                    className="truncate text-sm font-medium fg-primary"
                    title={row.name}
                  >
                    {row.name}
                  </h3>
                  <p
                    className="mt-1 truncate text-xs fg-secondary"
                    title={row.shortDescription}
                  >
                    {row.shortDescription}
                  </p>
                </div>
                <button
                  type="button"
                  className="focus-ring self-start rounded-md bg-secondary px-2.5 py-1.5 text-xs font-medium fg-primary hover:bg-accent-subtle"
                  onClick={() => catalog.onSelect(row)}
                  data-testid={`pipeline-template-use-${row.key}`}
                  aria-label={`Use template: ${row.name}`}
                >
                  Use template
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {dialogOpen && (
        <DialogModal
          title={
            catalog.selectedKey ? 'Preview pipeline' : 'Pipeline templates'
          }
          onClose={close}
          maxWidth="3xl"
          // Modal for the keyboard too: focus moves in, stays in, and returns
          // to the control that opened it.
          trapFocus
          restoreFocusRef={viewAllRef}
          dataTestId="pipeline-templates-dialog"
        >
          <CuratedPipelineCatalog {...catalog} />
        </DialogModal>
      )}
    </>
  );
}
