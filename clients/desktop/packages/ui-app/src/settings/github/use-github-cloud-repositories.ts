'use client';

// ---------------------------------------------------------------------------
// The repositories of one GitHub installation, page by page, and whether a
// repository can be created there (REG-3021).
//
// Both hooks only read. They ask while `enabled` (the selected account is
// adopted and freshly verified, `isGitHubCloudReady`), never retry by
// themselves (a rate limit or an outage waits for Retry, Try again or Check
// again), and keep each answer to the question it answers:
//
// - one listing is keyed by user, installation, connection generation and the
//   applied search; any change starts it over (rows, cursor and the host's
//   selection with them) and aborts what the old one had in flight;
// - every request carries a generation, so a late answer for an older search,
//   page or installation is dropped rather than painted;
// - the search waits 300 ms after the last keystroke;
// - Load more keeps its cursor when a page fails, so the failure and Try
//   again stay where the page would have been;
// - unmounting, or the account stopping being ready, aborts.
//
// The server still checks authorization and the repository itself on submit:
// a listed row is never a grant. Requests go through the GitHub host's
// repository transport; a host without one answers `unavailable`.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CloudRepositoryFailureCode } from '@canopy/protocol/settings/cloud-repository-contracts';
import type { GitHubRepositoryCreationCapabilityDto } from '@canopy/protocol/settings/account-github';
import type {
  GitHubCloudRepositoryDto,
  GitHubCloudRepositoryPageDto,
} from '@canopy/protocol/settings/github-cloud-repository-listing';
import { GITHUB_REPOSITORY_QUERY_MAX_LENGTH } from '@canopy/protocol/settings/organization-repositories';
import {
  fetchGitHubCloudRepositoryPage,
  fetchGitHubRepositoryCreationCapability,
  gitHubCloudRepositoryErrorMessage,
  isGitHubCloudRepositoryApiError,
  type GitHubCloudRepositoryApiAction,
} from './github-cloud-api';
import {
  GITHUB_CLOUD_REPOSITORY_SEARCH_DEBOUNCE_MS,
  mergeRepositoryPage,
} from './github-cloud-repository-pages';
import { useGitHubCloudRepositoryTransport } from './github-cloud-host';

/** A failed listing or capability request: its typed code and fixed copy. */
export interface GitHubCloudRepositoryRequestFailure {
  /** A repository or GitHub connection code, or null for anything else. */
  readonly code: CloudRepositoryFailureCode | null;
  readonly message: string;
}

function requestFailure(
  error: unknown,
  action: GitHubCloudRepositoryApiAction,
): GitHubCloudRepositoryRequestFailure {
  return {
    code: isGitHubCloudRepositoryApiError(error) ? error.code : null,
    message: gitHubCloudRepositoryErrorMessage(error, action),
  };
}

/** The search as the route takes it: trimmed and bounded. */
function normalizeQuery(query: string): string {
  return query.trim().slice(0, GITHUB_REPOSITORY_QUERY_MAX_LENGTH);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface UseGitHubCloudRepositoriesOptions {
  /** The signed-in account's stable key. */
  readonly userId: string;
  /** The selected installation; null lists nothing. */
  readonly installationId: string | null;
  /**
   * Changes whenever the connection's evidence or identity does; a change
   * starts the listing over.
   */
  readonly connectionGeneration: string;
  /** The search as typed; asked after 300 ms without a keystroke. */
  readonly query: string;
  /** Ask only while true: the selected account is ready. */
  readonly enabled: boolean;
}

export interface GitHubCloudRepositories {
  /** Identity of the rows below; changes whenever the listing starts over. */
  readonly listKey: string;
  /** Rows of the pages loaded so far, deduped by repository id. */
  readonly repositories: readonly GitHubCloudRepositoryDto[];
  /** The search the rows answer (the text may still be being typed). */
  readonly appliedQuery: string;
  /** GitHub's total for the installation, before any search. */
  readonly totalCount: number;
  readonly repositorySelection: GitHubCloudRepositoryPageDto['repositorySelection'];
  /** The next unscanned page, or null. */
  readonly nextCursor: number | null;
  /** Pages remain that no answer has scanned. */
  readonly searchIncomplete: boolean;
  /** The first page of this listing is being asked for. */
  readonly loading: boolean;
  /** The first page of this listing answered. */
  readonly loaded: boolean;
  /** The first page failed; Retry asks again. */
  readonly failure: GitHubCloudRepositoryRequestFailure | null;
  /** A Load more page is in flight. */
  readonly loadingMore: boolean;
  /** The last Load more page failed; the cursor is kept for Try again. */
  readonly pageFailure: GitHubCloudRepositoryRequestFailure | null;
  /** Asks for the first page again after it failed. */
  readonly retry: () => void;
  /** Asks for the next page. */
  readonly loadMore: () => void;
}

interface ListingState {
  readonly key: string;
  /** `pending`: the first page is wanted (or in flight). */
  readonly phase: 'pending' | 'loaded' | 'failed';
  readonly repositories: readonly GitHubCloudRepositoryDto[];
  readonly totalCount: number;
  readonly repositorySelection: GitHubCloudRepositoryPageDto['repositorySelection'];
  readonly nextCursor: number | null;
  readonly searchIncomplete: boolean;
  readonly failure: GitHubCloudRepositoryRequestFailure | null;
  readonly loadingMore: boolean;
  readonly pageFailure: GitHubCloudRepositoryRequestFailure | null;
  /** Bumped by Retry so the first page is asked for again. */
  readonly attempt: number;
}

function initialListing(key: string): ListingState {
  return {
    key,
    phase: 'pending',
    repositories: [],
    totalCount: 0,
    repositorySelection: null,
    nextCursor: null,
    searchIncomplete: false,
    failure: null,
    loadingMore: false,
    pageFailure: null,
    attempt: 0,
  };
}

/** Applies `update` only while the listing is still `key`. */
function forKey(
  key: string,
  update: (state: ListingState) => ListingState,
): (state: ListingState) => ListingState {
  return (state) => (state.key === key ? update(state) : state);
}

function useDebouncedQuery(query: string): string {
  const [applied, setApplied] = useState(() => normalizeQuery(query));
  const next = normalizeQuery(query);
  useEffect(() => {
    if (next === applied) return undefined;
    const timer = setTimeout(
      () => setApplied(next),
      GITHUB_CLOUD_REPOSITORY_SEARCH_DEBOUNCE_MS,
    );
    return (): void => clearTimeout(timer);
  }, [applied, next]);
  return applied;
}

export function useGitHubCloudRepositories({
  userId,
  installationId,
  connectionGeneration,
  query,
  enabled,
}: UseGitHubCloudRepositoriesOptions): GitHubCloudRepositories {
  const transport = useGitHubCloudRepositoryTransport();
  const appliedQuery = useDebouncedQuery(query);
  const key = JSON.stringify([
    userId,
    installationId,
    connectionGeneration,
    appliedQuery,
  ]);
  const [stored, setState] = useState<ListingState>(() => initialListing(key));
  if (stored.key !== key) {
    // Another account, installation, connection generation or search: the
    // rows and the cursor belong to the old listing.
    setState(initialListing(key));
  }
  const state = stored.key === key ? stored : initialListing(key);
  const active = enabled && installationId !== null;

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const moreRef = useRef<{
    controller: AbortController;
    generation: number;
  } | null>(null);
  const moreGenerationRef = useRef(0);

  const abortMore = useCallback((): void => {
    moreGenerationRef.current += 1;
    moreRef.current?.controller.abort();
    moreRef.current = null;
  }, []);

  // The first page: asked for while wanted and active. The cleanup aborts it
  // when the listing starts over, the account stops being ready, or the
  // component unmounts; a late answer of an aborted request is dropped.
  const wantsFirstPage = active && state.phase === 'pending';
  useEffect(() => {
    if (!wantsFirstPage || installationId === null) return undefined;
    const controller = new AbortController();
    let current = true;
    fetchGitHubCloudRepositoryPage(
      transport,
      { installationId, cursor: 1, query: appliedQuery },
      controller.signal,
    ).then(
      (page) => {
        if (!current) return;
        setState(
          forKey(key, (previous) => ({
            ...previous,
            phase: 'loaded',
            repositories: mergeRepositoryPage([], page.repositories),
            totalCount: page.totalCount,
            repositorySelection: page.repositorySelection,
            nextCursor: page.nextCursor,
            searchIncomplete: page.searchIncomplete,
            failure: null,
          })),
        );
      },
      (error: unknown) => {
        if (!current) return;
        setState(
          forKey(key, (previous) => ({
            ...previous,
            phase: 'failed',
            failure: requestFailure(error, 'list'),
          })),
        );
      },
    );
    return (): void => {
      current = false;
      controller.abort();
    };
  }, [
    appliedQuery,
    installationId,
    key,
    state.attempt,
    transport,
    wantsFirstPage,
  ]);

  // A Load more in flight belongs to this listing while the account is ready.
  useEffect(() => {
    if (!active) return undefined;
    return (): void => {
      abortMore();
      setState(
        forKey(key, (previous) =>
          previous.loadingMore ? { ...previous, loadingMore: false } : previous,
        ),
      );
    };
  }, [abortMore, active, key]);

  const retry = useCallback((): void => {
    setState(
      forKey(key, (previous) =>
        previous.phase === 'failed'
          ? {
              ...previous,
              phase: 'pending',
              failure: null,
              attempt: previous.attempt + 1,
            }
          : previous,
      ),
    );
  }, [key]);

  const loadMore = useCallback((): void => {
    const latest = stateRef.current;
    const cursor = latest.nextCursor;
    if (
      !active ||
      installationId === null ||
      latest.key !== key ||
      latest.phase !== 'loaded' ||
      latest.loadingMore ||
      cursor === null
    ) {
      return;
    }
    abortMore();
    const controller = new AbortController();
    const generation = moreGenerationRef.current;
    moreRef.current = { controller, generation };
    // Read synchronously by a second press before React re-renders.
    stateRef.current = { ...latest, loadingMore: true, pageFailure: null };
    setState(
      forKey(key, (previous) => ({
        ...previous,
        loadingMore: true,
        pageFailure: null,
      })),
    );
    fetchGitHubCloudRepositoryPage(
      transport,
      { installationId, cursor, query: appliedQuery },
      controller.signal,
    ).then(
      (page) => {
        if (generation !== moreGenerationRef.current) return;
        moreRef.current = null;
        setState(
          forKey(key, (previous) => ({
            ...previous,
            loadingMore: false,
            repositories: mergeRepositoryPage(
              previous.repositories,
              page.repositories,
            ),
            totalCount: page.totalCount,
            repositorySelection: page.repositorySelection,
            nextCursor: page.nextCursor,
            searchIncomplete: page.searchIncomplete,
          })),
        );
      },
      (error: unknown) => {
        if (generation !== moreGenerationRef.current) return;
        moreRef.current = null;
        // The cursor stays: the page can be asked for again.
        setState(
          forKey(key, (previous) => ({
            ...previous,
            loadingMore: false,
            pageFailure: requestFailure(error, 'list'),
          })),
        );
      },
    );
  }, [abortMore, active, appliedQuery, installationId, key, transport]);

  return {
    listKey: key,
    repositories: state.repositories,
    appliedQuery,
    totalCount: state.totalCount,
    repositorySelection: state.repositorySelection,
    nextCursor: state.nextCursor,
    searchIncomplete: state.searchIncomplete,
    loading: wantsFirstPage,
    loaded: state.phase === 'loaded',
    failure: state.failure,
    loadingMore: active && state.loadingMore,
    pageFailure: state.pageFailure,
    retry,
    loadMore,
  };
}

// ---------------------------------------------------------------------------
// Creation capability (Create new only)
// ---------------------------------------------------------------------------

export interface UseGitHubRepositoryCreationCapabilityOptions {
  readonly userId: string;
  /** The selected installation; null checks nothing. */
  readonly installationId: string | null;
  /** Changes whenever the connection's evidence or identity does. */
  readonly connectionGeneration: string;
  /** Check only while true: Create new is the source and the account is ready. */
  readonly enabled: boolean;
}

export interface GitHubRepositoryCreationCapabilityCheck {
  /**
   * `idle`: nothing to check; `checking`: a request is in flight;
   * `answered`: `capability` holds the answer; `failed`: `failure` says why.
   */
  readonly status: 'idle' | 'checking' | 'answered' | 'failed';
  /** The answer for the selected installation, or null. */
  readonly capability: GitHubRepositoryCreationCapabilityDto | null;
  readonly failure: GitHubCloudRepositoryRequestFailure | null;
  /** Check again: one request now, replacing any in flight. */
  readonly check: () => void;
}

interface CapabilityState {
  readonly key: string;
  readonly capability: GitHubRepositoryCreationCapabilityDto | null;
  readonly failure: GitHubCloudRepositoryRequestFailure | null;
  /** Bumped by Check again; the answer must be for the latest attempt. */
  readonly attempt: number;
  /** The attempt the stored answer (or failure) is for. */
  readonly answered: number | null;
}

function initialCapability(key: string): CapabilityState {
  return { key, capability: null, failure: null, attempt: 0, answered: null };
}

export function useGitHubRepositoryCreationCapability({
  userId,
  installationId,
  connectionGeneration,
  enabled,
}: UseGitHubRepositoryCreationCapabilityOptions): GitHubRepositoryCreationCapabilityCheck {
  const transport = useGitHubCloudRepositoryTransport();
  const key = JSON.stringify([userId, installationId, connectionGeneration]);
  const [stored, setState] = useState<CapabilityState>(() =>
    initialCapability(key),
  );
  if (stored.key !== key) setState(initialCapability(key));
  const state = stored.key === key ? stored : initialCapability(key);
  const active = enabled && installationId !== null;
  const wanted = active && state.answered !== state.attempt;

  useEffect(() => {
    if (!wanted || installationId === null) return undefined;
    const controller = new AbortController();
    const attempt = state.attempt;
    let current = true;
    const settle = (
      patch: Pick<CapabilityState, 'capability' | 'failure'>,
    ): void => {
      if (!current) return;
      setState((previous) =>
        previous.key === key && previous.attempt === attempt
          ? { ...previous, ...patch, answered: attempt }
          : previous,
      );
    };
    fetchGitHubRepositoryCreationCapability(
      transport,
      installationId,
      controller.signal,
    ).then(
      (capability) => settle({ capability, failure: null }),
      (error: unknown) =>
        settle({
          capability: null,
          failure: requestFailure(error, 'capability'),
        }),
    );
    return (): void => {
      current = false;
      controller.abort();
    };
  }, [installationId, key, state.attempt, transport, wanted]);

  const check = useCallback((): void => {
    setState((previous) =>
      previous.key === key
        ? { ...previous, attempt: previous.attempt + 1 }
        : previous,
    );
  }, [key]);

  let status: GitHubRepositoryCreationCapabilityCheck['status'] = 'idle';
  if (wanted) status = 'checking';
  else if (active && state.failure !== null) status = 'failed';
  else if (active && state.capability !== null) status = 'answered';
  return {
    status,
    capability: active ? state.capability : null,
    failure: active ? state.failure : null,
    check,
  };
}
