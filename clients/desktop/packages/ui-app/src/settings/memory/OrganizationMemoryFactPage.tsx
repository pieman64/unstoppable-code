'use client';

import { useEffect, useState, type JSX } from 'react';
import type { ExplorerSourceTranscript } from '@canopy/protocol/settings/organization-memory';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { useSettingsClient, useSettingsSearchParams } from '../host';
import type { SettingsPageProps } from '../pages/page-props';
import { fetchMemoryFactSource } from './api';
import { FactDetailDrawer } from './FactDetailDrawer';
import { useMemoryErrorCopy } from './memory-error-copy';
import { memoryOrganizationId } from './memory-route';
import {
  MemoryFactsBackLink,
  OrganizationMemoryLayout,
} from './OrganizationMemoryLayout';
import { SourceTranscriptView } from './SourceTranscriptView';

type SelectedTranscript =
  | { status: 'ready'; transcript: ExplorerSourceTranscript | null }
  | { status: 'loading' }
  | { status: 'error'; copy: string; retry: () => void };

interface LoadedSource {
  readonly key: string;
  readonly result:
    | { ok: true; transcript: ExplorerSourceTranscript }
    | { ok: false; copy: string };
}

/**
 * The transcript for the `?source=` the viewer selected. Page data carries
 * the transcript of the source its loader read: the selected one on web, the
 * first one when a host's page data has no query. Any other selection is
 * read through `organization.memory.factSource`.
 */
function useSelectedTranscript(
  orgId: string,
  factId: string,
  pageTranscript: ExplorerSourceTranscript | null,
  sourceId: string | null,
): SelectedTranscript {
  const client = useSettingsClient();
  const errorCopy = useMemoryErrorCopy();
  const needsRead = sourceId !== null && pageTranscript?.source.id !== sourceId;
  // Retry bumps the attempt, which changes the key: the failed result no
  // longer matches, so the view shows its loading placeholder and reads again.
  const [attempt, setAttempt] = useState(0);
  const key = `${orgId}/${factId}/${sourceId ?? ''}/${attempt}`;
  const [loaded, setLoaded] = useState<LoadedSource | null>(null);

  useEffect(() => {
    if (!needsRead || sourceId === null) return;
    let cancelled = false;
    fetchMemoryFactSource(client, orgId, factId, sourceId).then(
      (transcript) => {
        if (!cancelled) setLoaded({ key, result: { ok: true, transcript } });
      },
      (caught: unknown) => {
        if (cancelled) return;
        setLoaded({
          key,
          result: { ok: false, copy: errorCopy.loadCopy(caught) },
        });
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [client, errorCopy, factId, key, needsRead, orgId, sourceId]);

  if (!needsRead) return { status: 'ready', transcript: pageTranscript };
  if (loaded === null || loaded.key !== key) return { status: 'loading' };
  return loaded.result.ok
    ? { status: 'ready', transcript: loaded.result.transcript }
    : {
        status: 'error',
        copy: loaded.result.copy,
        retry: () => setAttempt((current) => current + 1),
      };
}

/**
 * `/organization/[orgId]/memory/fact/[factId]`: the fact's provenance beside
 * one source's transcript, selected with `?source=`.
 */
export function OrganizationMemoryFactPage({
  route,
  page,
}: SettingsPageProps<'organization.memory.fact'>): JSX.Element {
  const orgId = memoryOrganizationId(route);
  const { data } = page;
  // A fact is a drill-down under Facts: that view stays selected, and the
  // content leads with the way back to the list.
  return (
    <OrganizationMemoryLayout
      orgId={orgId}
      team={data.team}
      view="facts"
      enabled={data.enabled}
    >
      {data.enabled && (
        <>
          <MemoryFactsBackLink orgId={orgId} />
          <div className="grid items-start gap-5 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
            <FactDetailDrawer orgId={orgId} detail={data.detail} embedded />
            <FactSourceTranscript
              orgId={orgId}
              factId={data.detail.id}
              pageTranscript={data.transcript}
            />
          </div>
        </>
      )}
    </OrganizationMemoryLayout>
  );
}

function FactSourceTranscript({
  orgId,
  factId,
  pageTranscript,
}: {
  orgId: string;
  factId: string;
  pageTranscript: ExplorerSourceTranscript | null;
}): JSX.Element {
  const sourceId = useSettingsSearchParams().get('source');
  const selected = useSelectedTranscript(
    orgId,
    factId,
    pageTranscript,
    sourceId,
  );
  if (selected.status === 'loading') {
    return (
      <div className="flex min-h-40">
        <DelayedLoadingPlaceholder>
          <CenteredLoadingSpinner />
        </DelayedLoadingPlaceholder>
      </div>
    );
  }
  if (selected.status === 'error') {
    return (
      <ErrorBanner
        className=""
        error={selected.copy}
        onRetry={selected.retry}
      />
    );
  }
  if (selected.transcript === null) {
    return (
      <div className="rounded-xl border border-dashed py-16 text-center text-s fg-secondary">
        No transcript source is attached to this fact.
      </div>
    );
  }
  return <SourceTranscriptView transcript={selected.transcript} />;
}
