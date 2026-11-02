'use client';

import { useRef, useState, type JSX } from 'react';
import type {
  ExplorerIngestJob,
  ExplorerIngestJobStatus,
  ExplorerMemoryConfigSnapshot,
  ExplorerSearchLogEntry,
} from '@canopy/protocol/settings/organization-memory';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  SettingsTableSkeleton,
  SettingsSelect,
} from '@canopy/ui-shared/components';
import { withPrivacyClass } from '../account/privacy-class';
import { useSettingsClient, useSettingsPrivacy } from '../host';
import { fetchMemoryJobs } from './api';
import { useMemoryErrorCopy } from './memory-error-copy';

interface OpsViewProps {
  orgId: string;
  jobs: ExplorerIngestJob[];
  counts: Record<ExplorerIngestJobStatus, number>;
  searchEntries: ExplorerSearchLogEntry[];
  config: ExplorerMemoryConfigSnapshot;
}

const STATUSES: readonly ExplorerIngestJobStatus[] = [
  'PENDING',
  'RUNNING',
  'DONE',
  'FAILED',
  'DEAD',
];

function statusClasses(status: ExplorerIngestJobStatus): string {
  if (status === 'DONE') return 'bg-success-subtle fg-success';
  if (status === 'FAILED' || status === 'DEAD') {
    return 'bg-destructive-subtle fg-destructive';
  }
  if (status === 'RUNNING') return 'bg-accent-subtle fg-accent';
  return 'bg-base fg-secondary';
}

function isJobStatus(value: string): value is ExplorerIngestJobStatus {
  return STATUSES.some((status) => status === value);
}

export function OpsView({
  orgId,
  jobs,
  counts,
  searchEntries,
  config,
}: OpsViewProps): JSX.Element {
  const client = useSettingsClient();
  const { blockClassName } = useSettingsPrivacy();
  const errorCopy = useMemoryErrorCopy();
  const [status, setStatus] = useState<ExplorerIngestJobStatus | 'ALL'>('ALL');
  // Status selection refetches from the status-aware endpoint — the initial
  // server payload is only the first page, so filtering it client-side would
  // hide older jobs of the selected status while counts still report them.
  const [filteredJobs, setFilteredJobs] = useState<ExplorerIngestJob[] | null>(
    null,
  );
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const selectStatus = (next: ExplorerIngestJobStatus | 'ALL'): void => {
    setStatus(next);
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    if (next === 'ALL') {
      setFilteredJobs(null);
      setJobsLoading(false);
      setJobsError(null);
      return;
    }
    setFilteredJobs(null);
    setJobsLoading(true);
    setJobsError(null);
    void fetchMemoryJobs(client, orgId, next)
      .then((payload) => {
        if (requestSeq.current !== seq) return;
        setFilteredJobs(payload.jobs);
      })
      .catch((caught: unknown) => {
        if (requestSeq.current !== seq) return;
        setJobsError(errorCopy.loadCopy(caught));
      })
      .finally(() => {
        if (requestSeq.current === seq) setJobsLoading(false);
      });
  };
  const visibleJobs = status === 'ALL' ? jobs : (filteredJobs ?? []);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
      <div className="space-y-6">
        <section className="rounded-xl border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
            <div>
              <h2 className="text-base font-semibold fg-primary">
                Ingest jobs
              </h2>
              <p className="mt-1 text-xs fg-secondary">
                Attempts, worker heartbeat, and terminal errors.
              </p>
            </div>
            <SettingsSelect
              value={status}
              onValueChange={(value) => {
                if (value === 'ALL' || isJobStatus(value)) {
                  selectStatus(value);
                }
              }}
              width="fill"
              aria-label="Filter ingest jobs"
              options={[
                { value: 'ALL', label: 'All jobs' },
                ...STATUSES.map((item) => ({
                  value: item,
                  label: `${item} (${counts[item]})`,
                })),
              ]}
            />
          </div>
          {jobsLoading && jobsError === null && visibleJobs.length === 0 ? (
            <div className="p-4">
              <DelayedLoadingPlaceholder>
                <SettingsTableSkeleton />
              </DelayedLoadingPlaceholder>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-190 text-left text-xs">
                <thead className="bg-base fg-secondary">
                  <tr>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Created</th>
                    <th className="px-4 py-3 font-medium">Attempts</th>
                    <th className="px-4 py-3 font-medium">Heartbeat</th>
                    <th className="px-4 py-3 font-medium">Last error</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {jobsError !== null && visibleJobs.length === 0 ? (
                    <tr>
                      <td className="px-4 py-3" colSpan={5}>
                        <ErrorBanner
                          className=""
                          error={jobsError}
                          onRetry={() => selectStatus(status)}
                        />
                      </td>
                    </tr>
                  ) : null}
                  {visibleJobs.map((job) => (
                    <tr key={job.id}>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 font-semibold ${statusClasses(job.status)}`}
                        >
                          {job.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 fg-secondary">
                        {new Date(job.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 tabular-nums fg-primary">
                        {job.attempts}
                      </td>
                      <td
                        className={`px-4 py-3 ${
                          job.heartbeatStale
                            ? 'font-medium fg-destructive'
                            : 'fg-secondary'
                        }`}
                      >
                        {job.heartbeatStale
                          ? 'Stale'
                          : job.lastHeartbeatAt === null
                            ? '—'
                            : new Date(job.lastHeartbeatAt).toLocaleString()}
                      </td>
                      <td className="max-w-sm truncate px-4 py-3 fg-secondary">
                        {job.lastError ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-xl border bg-card p-4">
          <h2 className="text-base font-semibold fg-primary">
            Recently injected
          </h2>
          <div className="mt-4 space-y-4 border-l pl-4">
            {searchEntries.length === 0 ? (
              <p className="text-s fg-secondary">No search activity yet.</p>
            ) : (
              searchEntries.map((entry) => (
                <article key={entry.id} className="relative">
                  <span
                    className={`absolute -left-5.25 top-1 h-2.5 w-2.5 rounded-full ${
                      entry.gatePassed ? 'bg-success' : 'bg-fg-tertiary'
                    }`}
                  />
                  <div className="flex flex-wrap items-center gap-2 text-xs fg-secondary">
                    <time dateTime={entry.createdAt}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                    <span>·</span>
                    <span>{entry.latencyMs} ms</span>
                    <span
                      className={
                        entry.gatePassed ? 'fg-success' : 'fg-secondary'
                      }
                    >
                      {entry.gatePassed ? 'gate passed' : 'gate blocked'}
                    </span>
                  </div>
                  <p
                    className={withPrivacyClass(
                      'mt-1 text-s font-medium fg-primary',
                      blockClassName,
                    )}
                  >
                    {entry.query ??
                      (entry.queryDecryptFailed
                        ? 'Encrypted query unavailable'
                        : 'Empty query')}
                  </p>
                  <p className="mt-1 text-xs fg-secondary">
                    {blockClassName === '' ? (
                      (entry.user.name ?? entry.user.email)
                    ) : (
                      <span className={blockClassName}>
                        {entry.user.name ?? entry.user.email}
                      </span>
                    )}{' '}
                    · {entry.injectedFacts.length} facts injected
                  </p>
                  {entry.injectedFacts.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {entry.injectedFacts.map((fact) => (
                        <li
                          key={fact.id}
                          className={withPrivacyClass(
                            'line-clamp-2 rounded-md bg-base px-2 py-1.5 text-xs fg-secondary',
                            blockClassName,
                          )}
                        >
                          {fact.factText}
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              ))
            )}
          </div>
        </section>
      </div>

      <aside className="h-fit rounded-xl border bg-card p-4 xl:sticky xl:top-6">
        <h2 className="text-base font-semibold fg-primary">
          Effective configuration
        </h2>
        <dl className="mt-4 space-y-3 text-xs">
          {Object.entries(config).map(([key, value]) => (
            <div
              key={key}
              className="flex items-start justify-between gap-4 border-b pb-2 last:border-0"
            >
              <dt className="fg-secondary">{key}</dt>
              <dd className="max-w-13/20 break-all text-right font-mono fg-primary">
                {value === null ? 'not set' : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      </aside>
    </div>
  );
}
