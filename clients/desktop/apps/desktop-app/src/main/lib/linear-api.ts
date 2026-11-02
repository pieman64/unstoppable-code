/**
 * Every Linear request Electron main makes, without `@linear/sdk`.
 *
 * The SDK (v79) cannot be reduced: its `exports` map exposes only `.`,
 * `./webhooks` and `./package.json`, and `.` is a single 2.4 MB bundle that
 * inlines graphql 15 and a client class with every API method, so deep imports
 * and tree shaking have nothing to cut. Loading it cost main 2.4 MB parsed and
 * about 7.8 MB resident at startup, for the five operations below: `viewer`
 * (key validation), `searchIssues` and `issue_attachments` (ticket search),
 * and `referencePreviewIssue` and `referencePreviewTeams` (transcript
 * previews). Builtin Linear actions keep the SDK; they run in the pipeline
 * utility process, not in main.
 *
 * Safety: documents are fixed constants and data travels only in variables;
 * inputs are checked before any request; the key goes only in `Authorization`;
 * responses are size-capped, type-checked and never retained in errors.
 */

import {
  LINEAR_ISSUE_IDENTIFIER_PATTERN,
  parseLinearIssueSearchQuery,
} from '@canopy/protocol/reference-previews';

const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ATTACHMENT_PAGE_SIZE = 50;
const TEAM_PAGE_SIZE = 250;
// 5,000 teams; a larger catalog fails closed rather than publishing a prefix.
const MAX_TEAM_PAGES = 20;
const MAX_CURSOR_LENGTH = 512;

// Field and argument names follow the current Linear GraphQL schema:
// https://studio.apollographql.com/public/Linear-API/variant/current/home
// Each selection names only the fields main reads: Linear caps one query at
// 10,000 complexity points and rate-limits by complexity as well as requests
// (with `X-RateLimit-*` headers): https://linear.app/developers/rate-limiting
const VIEWER_QUERY = `query viewer {
  viewer { name displayName }
}`;

const SEARCH_ISSUES_QUERY = `query searchIssues($term: String!) {
  searchIssues(term: $term) {
    nodes { id identifier title description url priority priorityLabel branchName }
  }
}`;

const ISSUE_ATTACHMENTS_QUERY = `query issue_attachments($id: String!, $first: Int!) {
  issue(id: $id) {
    attachments(first: $first) {
      nodes { url sourceType title }
      pageInfo { hasNextPage }
    }
  }
}`;

// Keep these preview selections byte-for-byte aligned with the reference-preview contract.
// Field and argument names follow the current Linear GraphQL schema:
// https://studio.apollographql.com/public/Linear-API/variant/current/home
const ISSUE_PREVIEW_QUERY = `query referencePreviewIssue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    updatedAt
    state { name }
    assignee { displayName name }
    project { name }
  }
}`;

// Cursor pagination uses Linear's first/after/pageInfo convention:
// https://linear.app/developers/pagination
const TEAM_KEYS_QUERY = `query referencePreviewTeams($first: Int!, $after: String) {
  teams(first: $first, after: $after) {
    nodes { key }
    pageInfo { hasNextPage endCursor }
  }
}`;

const API_KEY_PATTERN = /^[\x21-\x7e]{1,512}$/;
const ISSUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// `application/json`, or a `+json` type, with optional parameters such as charset.
const JSON_CONTENT_TYPE_PATTERN =
  /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;
// eslint-disable-next-line no-control-regex -- cursors containing controls are rejected.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export type LinearApiOperation =
  | 'viewer'
  | 'searchIssues'
  | 'issue_attachments'
  | 'referencePreviewIssue'
  | 'referencePreviewTeams';

export type LinearApiErrorType =
  | 'authentication'
  | 'forbidden'
  | 'feature_not_accessible'
  | 'invalid_input'
  | 'ratelimited'
  | 'network'
  | 'internal'
  | 'unknown';

/** The only error the helper throws; it retains no provider or request data. */
export class LinearApiError extends Error {
  override readonly name: 'LinearApiError';
  readonly operation: LinearApiOperation;
  readonly type: LinearApiErrorType;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  /** True only when Linear identifies a missing entity in an error message. */
  readonly notFound: boolean;

  constructor(
    operation: LinearApiOperation,
    type: LinearApiErrorType,
    status: number | null,
    retryAfterMs: number | null,
    notFound: boolean,
  ) {
    super(`Linear ${operation} request failed (${type})`);
    this.name = 'LinearApiError';
    this.operation = operation;
    this.type = type;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.notFound = notFound;
  }
}

export function isLinearApiError(value: unknown): value is LinearApiError {
  return value instanceof LinearApiError;
}

export interface LinearViewer {
  readonly name: string;
  readonly displayName: string | null;
}

export interface LinearIssueSearchResult {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  readonly priority: number;
  readonly priorityLabel: string;
  readonly branchName: string;
}

export interface LinearIssueAttachment {
  readonly url: string;
  readonly sourceType?: string | null;
  readonly title?: string | null;
}

export interface LinearIssueAttachments {
  /** At most the first 50 nodes. */
  readonly attachments: readonly LinearIssueAttachment[];
  /** True only for an explicitly final page with no more than 50 returned nodes. */
  readonly complete: boolean;
}

export interface LinearIssuePreviewNode {
  readonly identifier: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly url: string | null;
  readonly updatedAt: string | null;
  readonly state: { readonly name: string | null } | null;
  readonly assignee: {
    readonly displayName: string | null;
    readonly name: string | null;
  } | null;
  readonly project: { readonly name: string | null } | null;
}

export interface LinearRequestOptions {
  readonly signal?: AbortSignal;
}

interface RequestParameters {
  readonly operation: LinearApiOperation;
  readonly apiKey: string;
  readonly query: string;
  readonly variables: Readonly<Record<string, string | number | null>>;
  readonly signal?: AbortSignal;
}

interface ApiResponse {
  readonly data: unknown;
  readonly status: number;
  readonly retryAfterMs: number | null;
}

type BodyReadResult =
  | { readonly kind: 'read'; readonly bytes: Uint8Array }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'failed' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidInput(operation: LinearApiOperation): LinearApiError {
  return new LinearApiError(operation, 'invalid_input', null, null, false);
}

function isValidApiKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const matched = API_KEY_PATTERN.exec(value);
  return matched !== null && matched[0].length === value.length;
}

function isValidIssueId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const matched = ISSUE_ID_PATTERN.exec(value);
  return matched !== null && matched[0].length === value.length;
}

function isValidIssueIdentifier(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const matched = LINEAR_ISSUE_IDENTIFIER_PATTERN.exec(value);
  return matched !== null && matched[0].length === value.length;
}

function unknownResponse(
  operation: LinearApiOperation,
  status: number,
  retryAfterMs: number | null,
): LinearApiError {
  return new LinearApiError(operation, 'unknown', status, retryAfterMs, false);
}

function readRetryAfter(response: Response): number | null {
  // A numeric Retry-After is Linear's documented rate-limit retry delay:
  // https://linear.app/developers/rate-limiting
  const value = response.headers.get('retry-after');
  if (value === null) return null;
  const seconds = Number(value);
  const milliseconds = seconds * 1_000;
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? milliseconds
    : null;
}

function statusErrorType(status: number): LinearApiErrorType {
  if (status === 403) return 'forbidden';
  if (status === 429) return 'ratelimited';
  if (status >= 400 && status < 500) return 'authentication';
  if (status === 500) return 'internal';
  if (status >= 500 && status < 600) return 'network';
  return 'unknown';
}

// Mirror SDK 79's parseLinearError classification: the first GraphQL error
// decides before the HTTP fallback. The SDK error reference documents types
// and retry-after behavior; Linear's documented RATELIMITED code is an extra.
// https://linear.app/developers/sdk-errors
// https://github.com/linear/linear/blob/master/packages/sdk/src/error.ts
// HTTP 400 rate limits use extensions.code RATELIMITED:
// https://linear.app/developers/rate-limiting
function graphqlErrorType(error: unknown): LinearApiErrorType {
  const extensions =
    isRecord(error) && isRecord(error.extensions) ? error.extensions : null;
  if (extensions?.code === 'RATELIMITED') return 'ratelimited';

  switch (extensions?.type) {
    case 'authentication error':
      return 'authentication';
    case 'forbidden':
      return 'forbidden';
    case 'feature not accessible':
      return 'feature_not_accessible';
    case 'invalid input':
      return 'invalid_input';
    case 'ratelimited':
      return 'ratelimited';
    case 'network error':
      return 'network';
    case 'internal error':
      return 'internal';
    default:
      return 'unknown';
  }
}

function hasEntityNotFound(errors: unknown[]): boolean {
  return errors.some((error) => {
    if (!isRecord(error)) return false;
    const message = error.message;
    const extensions = isRecord(error.extensions) ? error.extensions : null;
    const userPresentableMessage = extensions?.userPresentableMessage;
    return (
      (typeof message === 'string' && /entity not found/i.test(message)) ||
      (typeof userPresentableMessage === 'string' &&
        /entity not found/i.test(userPresentableMessage))
    );
  });
}

function isHttpJson(response: Response): boolean {
  const contentType = response.headers.get('content-type');
  return contentType !== null && JSON_CONTENT_TYPE_PATTERN.test(contentType);
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined);
      reject(new Error('Linear response read aborted'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('Linear response read failed'));
      },
    );
  });
}

async function readResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<BodyReadResult> {
  if (!response.body) return { kind: 'read', bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await readChunk(reader, signal);
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { kind: 'too_large' };
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: 'read', bytes };
  } catch {
    void reader.cancel().catch(() => undefined);
    return { kind: 'failed' };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read may still be unwinding after abort; its reader is private.
    }
  }
}

function parseJson(
  value: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    const parsed: unknown = JSON.parse(value);
    return { ok: true, value: parsed };
  } catch {
    return { ok: false };
  }
}

function responseError(
  operation: LinearApiOperation,
  response: Response,
  payload: unknown,
  retryAfterMs: number | null,
): LinearApiError | null {
  // The SDK classifies the first GraphQL error before falling back to status;
  // `errors: []` therefore follows the same HTTP path.
  const errors = isRecord(payload) ? payload.errors : null;
  if (Array.isArray(errors) && errors.length > 0) {
    const firstError: unknown = errors[0];
    return new LinearApiError(
      operation,
      graphqlErrorType(firstError),
      response.status,
      retryAfterMs,
      hasEntityNotFound(errors),
    );
  }
  if (!response.ok) {
    return new LinearApiError(
      operation,
      statusErrorType(response.status),
      response.status,
      retryAfterMs,
      false,
    );
  }
  return null;
}

/** One private transport entry point; callers cannot choose documents or operations. */
async function request(parameters: RequestParameters): Promise<ApiResponse> {
  let response: Response | null = null;
  try {
    // The timeout also bounds reading the body, not only the response headers.
    const signals: AbortSignal[] = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
    if (parameters.signal) signals.push(parameters.signal);
    const signal = AbortSignal.any(signals);
    // The E2E mock endpoint sits behind a build-time gate that production
    // builds remove, so no runtime value can redirect a shipped app's requests.
    const endpoint =
      __CANOPY_E2E__ && __CANOPY_LINEAR_API_BASE_URL__
        ? __CANOPY_LINEAR_API_BASE_URL__
        : LINEAR_GRAPHQL_ENDPOINT;
    // Linear's GraphQL endpoint accepts the API key raw in Authorization:
    // https://linear.app/developers/graphql#authentication
    response = await globalThis.fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: parameters.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      // User and response values stay in variables; no manual escaping or
      // query interpolation can alter the fixed operation document.
      // https://graphql.org/learn/queries/#variables
      // https://graphql.org/learn/serving-over-http/
      body: JSON.stringify({
        query: parameters.query,
        variables: parameters.variables,
      }),
      redirect: 'error',
      signal,
    });

    const retryAfterMs = readRetryAfter(response);
    const body = await readResponseBody(response, signal);
    if (body.kind === 'too_large') {
      throw unknownResponse(
        parameters.operation,
        response.status,
        retryAfterMs,
      );
    }
    if (body.kind === 'failed') {
      throw new LinearApiError(
        parameters.operation,
        'network',
        response.status,
        retryAfterMs,
        false,
      );
    }

    let payload: unknown = null;
    if (isHttpJson(response)) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(
          body.bytes,
        );
        const parsed = parseJson(text);
        if (parsed.ok) payload = parsed.value;
      } catch {
        // Fatal UTF-8 decoding fails closed as an unparseable JSON response.
      }
    }
    const failure = responseError(
      parameters.operation,
      response,
      payload,
      retryAfterMs,
    );
    if (failure) throw failure;

    const data = isRecord(payload) ? payload.data : null;
    if (!isRecord(data)) {
      throw unknownResponse(
        parameters.operation,
        response.status,
        retryAfterMs,
      );
    }
    return { data, status: response.status, retryAfterMs };
  } catch (error: unknown) {
    if (isLinearApiError(error)) throw error;
    throw new LinearApiError(
      parameters.operation,
      'network',
      response?.status ?? null,
      response ? readRetryAfter(response) : null,
      false,
    );
  }
}

function operationResultError(
  operation: LinearApiOperation,
  response: ApiResponse,
): LinearApiError {
  return unknownResponse(operation, response.status, response.retryAfterMs);
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readPreviewNode(value: unknown): LinearIssuePreviewNode | null {
  if (!isRecord(value)) return null;
  const state = isRecord(value.state)
    ? { name: readNullableString(value.state.name) }
    : null;
  const assignee = isRecord(value.assignee)
    ? {
        displayName: readNullableString(value.assignee.displayName),
        name: readNullableString(value.assignee.name),
      }
    : null;
  const project = isRecord(value.project)
    ? { name: readNullableString(value.project.name) }
    : null;
  return {
    identifier: readNullableString(value.identifier),
    title: readNullableString(value.title),
    description: readNullableString(value.description),
    url: readNullableString(value.url),
    updatedAt: readNullableString(value.updatedAt),
    state,
    assignee,
    project,
  };
}

export async function readLinearViewer(
  apiKey: string,
  options?: LinearRequestOptions,
): Promise<LinearViewer> {
  const operation: LinearApiOperation = 'viewer';
  if (!isValidApiKey(apiKey)) throw invalidInput(operation);
  const response = await request({
    operation,
    apiKey,
    query: VIEWER_QUERY,
    variables: {},
    signal: options?.signal,
  });
  const viewer = isRecord(response.data) ? response.data.viewer : null;
  if (
    !isRecord(viewer) ||
    typeof viewer.name !== 'string' ||
    (viewer.displayName !== undefined &&
      viewer.displayName !== null &&
      typeof viewer.displayName !== 'string')
  ) {
    throw operationResultError(operation, response);
  }
  return {
    name: viewer.name,
    displayName: readNullableString(viewer.displayName),
  };
}

function isLinearIssueSearchResult(
  value: unknown,
): value is LinearIssueSearchResult {
  return (
    isRecord(value) &&
    isValidIssueId(value.id) &&
    isValidIssueIdentifier(value.identifier) &&
    typeof value.title === 'string' &&
    (value.description === undefined ||
      value.description === null ||
      typeof value.description === 'string') &&
    typeof value.url === 'string' &&
    typeof value.priority === 'number' &&
    typeof value.priorityLabel === 'string' &&
    typeof value.branchName === 'string'
  );
}

export async function searchLinearIssues(
  apiKey: string,
  term: string,
  options?: LinearRequestOptions,
): Promise<LinearIssueSearchResult[]> {
  const operation: LinearApiOperation = 'searchIssues';
  if (!isValidApiKey(apiKey) || parseLinearIssueSearchQuery(term) !== term) {
    throw invalidInput(operation);
  }
  const response = await request({
    operation,
    apiKey,
    query: SEARCH_ISSUES_QUERY,
    variables: { term },
    signal: options?.signal,
  });
  const result = isRecord(response.data) ? response.data.searchIssues : null;
  if (!isRecord(result) || !Array.isArray(result.nodes)) {
    throw operationResultError(operation, response);
  }
  const nodes: unknown[] = result.nodes;
  const issues: LinearIssueSearchResult[] = [];
  for (const node of nodes) {
    if (!isLinearIssueSearchResult(node)) {
      throw operationResultError(operation, response);
    }
    issues.push({
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      description: node.description ?? null,
      url: node.url,
      priority: node.priority,
      priorityLabel: node.priorityLabel,
      branchName: node.branchName,
    });
  }
  return issues;
}

function isLinearIssueAttachment(
  value: unknown,
): value is LinearIssueAttachment {
  return (
    isRecord(value) &&
    typeof value.url === 'string' &&
    (value.sourceType === undefined ||
      value.sourceType === null ||
      typeof value.sourceType === 'string') &&
    (value.title === undefined ||
      value.title === null ||
      typeof value.title === 'string')
  );
}

export async function readLinearIssueAttachments(
  apiKey: string,
  issueId: string,
  options?: LinearRequestOptions,
): Promise<LinearIssueAttachments> {
  const operation: LinearApiOperation = 'issue_attachments';
  if (!isValidApiKey(apiKey) || !isValidIssueId(issueId)) {
    throw invalidInput(operation);
  }
  const response = await request({
    operation,
    apiKey,
    query: ISSUE_ATTACHMENTS_QUERY,
    variables: { id: issueId, first: ATTACHMENT_PAGE_SIZE },
    signal: options?.signal,
  });
  const issue = isRecord(response.data) ? response.data.issue : null;
  const connection = isRecord(issue) ? issue.attachments : null;
  if (!isRecord(connection) || !Array.isArray(connection.nodes)) {
    throw operationResultError(operation, response);
  }
  const rawNodes: unknown[] = connection.nodes;
  const pageInfo = connection.pageInfo;
  if (
    pageInfo !== undefined &&
    (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== 'boolean')
  ) {
    throw operationResultError(operation, response);
  }
  const attachments: LinearIssueAttachment[] = [];
  for (const node of rawNodes) {
    if (!isLinearIssueAttachment(node)) {
      throw operationResultError(operation, response);
    }
    attachments.push({
      url: node.url,
      ...(node.sourceType !== undefined ? { sourceType: node.sourceType } : {}),
      ...(node.title !== undefined ? { title: node.title } : {}),
    });
  }
  return {
    attachments: attachments.slice(0, ATTACHMENT_PAGE_SIZE),
    complete:
      isRecord(pageInfo) &&
      pageInfo.hasNextPage === false &&
      rawNodes.length <= ATTACHMENT_PAGE_SIZE,
  };
}

export async function readLinearIssuePreview(
  apiKey: string,
  identifier: string,
  options?: LinearRequestOptions,
): Promise<LinearIssuePreviewNode | null> {
  const operation: LinearApiOperation = 'referencePreviewIssue';
  if (!isValidApiKey(apiKey) || !isValidIssueIdentifier(identifier)) {
    throw invalidInput(operation);
  }
  const response = await request({
    operation,
    apiKey,
    query: ISSUE_PREVIEW_QUERY,
    variables: { id: identifier },
    signal: options?.signal,
  });
  const issue = isRecord(response.data) ? response.data.issue : null;
  return readPreviewNode(issue);
}

interface TeamPage {
  readonly keys: string[];
  readonly next: string | null;
}

function readTeamPage(data: unknown): TeamPage | null {
  const teams = isRecord(data) ? data.teams : null;
  if (!isRecord(teams) || !Array.isArray(teams.nodes)) return null;
  const pageInfo = teams.pageInfo;
  if (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== 'boolean') {
    return null;
  }
  let next: string | null = null;
  if (pageInfo.hasNextPage) {
    const cursor: unknown = pageInfo.endCursor;
    if (
      typeof cursor !== 'string' ||
      cursor.length === 0 ||
      cursor.length > MAX_CURSOR_LENGTH ||
      CONTROL_CHARACTER_PATTERN.test(cursor)
    ) {
      return null;
    }
    next = cursor;
  }
  const keys: string[] = [];
  const nodes: unknown[] = teams.nodes;
  for (const node of nodes) {
    const key: unknown = isRecord(node) ? node.key : null;
    if (typeof key === 'string') keys.push(key);
  }
  return { keys, next };
}

export async function readLinearTeamKeys(
  apiKey: string,
  options?: LinearRequestOptions,
): Promise<string[]> {
  const operation: LinearApiOperation = 'referencePreviewTeams';
  if (!isValidApiKey(apiKey)) throw invalidInput(operation);
  const keys: string[] = [];
  let after: string | null = null;
  let status = 200;
  let retryAfterMs: number | null = null;
  for (let page = 0; page < MAX_TEAM_PAGES; page += 1) {
    const response = await request({
      operation,
      apiKey,
      query: TEAM_KEYS_QUERY,
      variables: { first: TEAM_PAGE_SIZE, after },
      signal: options?.signal,
    });
    status = response.status;
    retryAfterMs = response.retryAfterMs;
    const parsed = readTeamPage(response.data);
    if (!parsed) throw operationResultError(operation, response);
    keys.push(...parsed.keys);
    if (parsed.next === null) return keys;
    after = parsed.next;
  }
  throw unknownResponse(operation, status, retryAfterMs);
}
