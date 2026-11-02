import type {
  ExternalProjectCandidate,
  ExternalProjectDiscoverResponse,
  ExternalProjectImportItemResult,
} from '@canopy/desktop-shared/types';
import {
  failClientOperation,
  startClientOperation,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';
import {
  createFirstRunImportVisit,
  deriveProjectImportResult,
  projectImportModalEntry,
  providerConnection,
  startProjectImportSubmission,
  type ImportScanState,
} from '../projectImportTelemetry';

jest.mock('@canopy/desktop-instrumentation/client', () => ({
  startClientOperation: jest.fn(),
  succeedClientOperation: jest.fn(),
  failClientOperation: jest.fn(),
}));

const start = jest.mocked(startClientOperation);
const succeed = jest.mocked(succeedClientOperation);
const fail = jest.mocked(failClientOperation);

function candidate(
  id: string,
  providers: ExternalProjectCandidate['providers'],
): ExternalProjectCandidate {
  return {
    id,
    providers,
    surfaces: ['claude-code'],
    displayName: `Secret ${id}`,
    rootPath: `/Users/me/${id}`,
    kind: 'git',
    status: 'available',
    linkedWorktreePaths: [],
    lastActivityAt: null,
    sessions: [],
    sessionCount: 0,
    importableSessionCount: 0,
  };
}

function result(
  candidateId: string,
  status: ExternalProjectImportItemResult['status'],
  chats = 0,
): ExternalProjectImportItemResult {
  return {
    candidateId,
    displayName: `Secret ${candidateId}`,
    rootPath: `/Users/me/${candidateId}`,
    status,
    ...(status === 'imported' ? { workspaceId: `ws-${candidateId}` } : {}),
    chatsImported: chats,
    chatsReadOnly: 0,
    chatsSkipped: 0,
    retryable: status === 'failed',
  };
}

const BOTH = candidate('both', ['claude', 'codex']);
const CLAUDE = candidate('claude-only', ['claude']);
const CODEX = candidate('codex-only', ['codex']);
const FOLDER = candidate('folder', []);

function completed(found: ExternalProjectCandidate[]): ImportScanState {
  const scan: ExternalProjectDiscoverResponse = {
    scanId: 'scan-raw-id',
    scannedAt: '2026-10-29T00:00:00.000Z',
    candidates: found,
    diagnostics: [],
    providersDetected: { claude: true, codex: false },
    detectedPlugins: [],
  };
  return { kind: 'completed', scan, found };
}

const CONNECTIONS = { claude: 'connected', codex: 'unknown' } as const;

beforeEach(() => {
  start.mockReset();
  succeed.mockReset();
  fail.mockReset();
});

describe('providerConnection', () => {
  it('maps unresolved and failed checks to unknown', () => {
    expect(providerConnection(null)).toBe('unknown');
    expect(
      providerConnection({
        authenticated: false,
        accountLabel: null,
        detail: null,
        error: 'boom',
        probeFailed: true,
      }),
    ).toBe('unknown');
    expect(
      providerConnection({
        authenticated: false,
        accountLabel: null,
        detail: null,
        error: null,
      }),
    ).toBe('not_connected');
    expect(
      providerConnection({
        authenticated: true,
        accountLabel: 'me',
        detail: null,
        error: null,
      }),
    ).toBe('connected');
  });

  it.each(['Claude', 'Codex'])(
    'reports a confirmed %s sign-out despite its explanatory error',
    (provider) => {
      expect(
        providerConnection({
          authenticated: false,
          accountLabel: null,
          detail: null,
          error: `${provider} is not authenticated.`,
        }),
      ).toBe('not_connected');
    },
  );

  it('reports an inconclusive probe without error text as unknown', () => {
    expect(
      providerConnection({
        authenticated: false,
        accountLabel: null,
        detail: null,
        error: null,
        probeFailed: true,
      }),
    ).toBe('unknown');
  });
});

describe('projectImportModalEntry', () => {
  it('normalizes the store entries and omits the rest', () => {
    expect(projectImportModalEntry('invite')).toBe('invite');
    expect(projectImportModalEntry('settings')).toBe('settings');
    expect(projectImportModalEntry('app-advisor')).toBe('app_advisor');
    expect(projectImportModalEntry('checklist')).toBeUndefined();
    expect(projectImportModalEntry('command')).toBeUndefined();
    expect(projectImportModalEntry(undefined)).toBeUndefined();
  });
});

describe('deriveProjectImportResult', () => {
  const found = [BOTH, CLAUDE, CODEX, FOLDER];

  it('counts a two-provider project in both buckets but once in totals', () => {
    expect(
      deriveProjectImportResult(['both', 'claude-only'], found, {
        results: [
          result('both', 'imported', 2),
          result('claude-only', 'imported', 1),
        ],
      }),
    ).toEqual({
      outcome: 'imported',
      selectedCount: 2,
      importedCount: 2,
      importedClaudeCount: 2,
      importedCodexCount: 1,
      failedCount: 0,
      chatsImportedCount: 3,
    });
  });

  it('reports partial, none imported, and request failures', () => {
    const partial = deriveProjectImportResult(['codex-only', 'folder'], found, {
      results: [result('codex-only', 'imported'), result('folder', 'skipped')],
    });
    expect(partial).toMatchObject({
      outcome: 'partial',
      importedCount: 1,
      failedCount: 1,
    });
    expect(partial.importedCount + partial.failedCount).toBe(
      partial.selectedCount,
    );

    expect(
      deriveProjectImportResult(['folder'], found, {
        results: [result('folder', 'failed')],
      }),
    ).toMatchObject({
      outcome: 'none_imported',
      importedCount: 0,
      failedCount: 1,
    });

    expect(deriveProjectImportResult(['both', 'folder'], found, null)).toEqual({
      outcome: 'request_failed',
      selectedCount: 2,
      importedCount: 0,
      importedClaudeCount: 0,
      importedCodexCount: 0,
      failedCount: 2,
      chatsImportedCount: 0,
    });
  });

  it('ignores duplicate and unselected results', () => {
    expect(
      deriveProjectImportResult(['both'], found, {
        results: [
          result('both', 'imported'),
          result('both', 'imported'),
          result('claude-only', 'imported'),
        ],
      }),
    ).toMatchObject({ outcome: 'imported', importedCount: 1, failedCount: 0 });
  });
});

describe('startProjectImportSubmission', () => {
  it('snapshots modal context and emits one keyed end per submission', () => {
    const selected = ['both', 'folder'];
    const tracking = startProjectImportSubmission({
      surface: { source: 'import_modal', modalEntry: 'app-advisor' },
      scan: completed([BOTH, CLAUDE, FOLDER]),
      selectedIds: selected,
      pickedFolder: true,
    });
    // A later selection change does not alter the submitted counts.
    selected.push('claude-only');
    tracking.settle({
      results: [result('both', 'imported', 4), result('folder', 'failed')],
    });
    tracking.fail();

    expect(start).toHaveBeenCalledTimes(1);
    const operationKey = start.mock.calls[0]?.[1]?.operationKey;
    expect(operationKey).toEqual(expect.any(String));
    expect(fail).not.toHaveBeenCalled();
    expect(succeed).toHaveBeenCalledTimes(1);
    expect(succeed).toHaveBeenCalledWith('canopy.project_import', {
      operationKey,
      context: {
        source: 'import_modal',
        modal_entry: 'app_advisor',
        scan_outcome: 'found',
        claude_data_detected: true,
        codex_data_detected: false,
        found_count: 3,
        found_claude_count: 2,
        found_codex_count: 1,
        picked_folder: true,
        outcome: 'partial',
        selected_count: 2,
        imported_count: 1,
        imported_claude_count: 1,
        imported_codex_count: 1,
        failed_count: 1,
        chats_imported_count: 4,
      },
    });
    const serialized = JSON.stringify([start.mock.calls, succeed.mock.calls]);
    for (const raw of ['Secret', '/Users/me', 'scan-raw-id', 'ws-'])
      expect(serialized).not.toContain(raw);
  });

  it('records first-run connections and fails zero-import submissions', () => {
    const first = startProjectImportSubmission({
      surface: { source: 'first_run', connections: CONNECTIONS },
      scan: completed([CLAUDE]),
      selectedIds: ['claude-only'],
      pickedFolder: false,
    });
    const second = startProjectImportSubmission({
      surface: { source: 'first_run', connections: CONNECTIONS },
      scan: completed([CLAUDE]),
      selectedIds: ['claude-only'],
      pickedFolder: false,
    });
    first.settle({ results: [result('claude-only', 'failed')] });
    second.fail();

    const keys = start.mock.calls.map(([, options]) => options?.operationKey);
    expect(new Set(keys).size).toBe(2);
    expect(fail.mock.calls.map(([name, reason]) => [name, reason])).toEqual([
      ['canopy.project_import', 'error'],
      ['canopy.project_import', 'error'],
    ]);
    expect(
      fail.mock.calls.map(([, , options]) => options?.operationKey),
    ).toEqual(keys);
    expect(fail.mock.calls[0]?.[2]?.context).toMatchObject({
      source: 'first_run',
      claude_connection: 'connected',
      codex_connection: 'unknown',
      outcome: 'none_imported',
      chats_imported_count: 0,
    });
    expect(fail.mock.calls[1]?.[2]?.context).toMatchObject({
      outcome: 'request_failed',
      imported_count: 0,
      failed_count: 1,
    });
  });

  it('omits scan counts when no scan completed', () => {
    startProjectImportSubmission({
      surface: { source: 'import_modal' },
      scan: { kind: 'unknown' },
      selectedIds: ['x'],
      pickedFolder: false,
    }).fail();
    const context = fail.mock.calls[0]?.[2]?.context ?? {};
    expect(context).toMatchObject({ scan_outcome: 'unknown' });
    expect(context).not.toHaveProperty('modal_entry');
    expect(context).not.toHaveProperty('found_count');
    expect(context).not.toHaveProperty('claude_data_detected');
  });

  it('never throws when instrumentation does', () => {
    start.mockImplementation(() => {
      throw new Error('boom');
    });
    succeed.mockImplementation(() => {
      throw new Error('boom');
    });
    const tracking = startProjectImportSubmission({
      surface: { source: 'import_modal' },
      scan: completed([CLAUDE]),
      selectedIds: ['claude-only'],
      pickedFolder: false,
    });
    expect(
      tracking.settle({ results: [result('claude-only', 'imported')] }),
    ).toMatchObject({ outcome: 'imported' });
  });
});

describe('createFirstRunImportVisit', () => {
  it('isolates random-key failures without changing confirmed import results', () => {
    const uuid = jest.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('random source unavailable');
    });
    try {
      const visit = createFirstRunImportVisit();
      visit.begin(CONNECTIONS);
      const submission = startProjectImportSubmission({
        surface: { source: 'first_run', connections: CONNECTIONS },
        scan: completed([CLAUDE]),
        selectedIds: ['claude-only'],
        pickedFolder: false,
      });
      expect(
        submission.settle({ results: [result('claude-only', 'imported')] }),
      ).toMatchObject({ outcome: 'imported', importedCount: 1 });
      visit.complete(completed([CLAUDE]), CONNECTIONS);
      expect(start).not.toHaveBeenCalled();
      expect(succeed).not.toHaveBeenCalled();
    } finally {
      uuid.mockRestore();
    }
  });

  it('views once and completes once with the visit totals', () => {
    const visit = createFirstRunImportVisit();
    visit.begin(CONNECTIONS);
    visit.begin(CONNECTIONS);
    visit.markPickedFolder();
    visit.markCreditsOffered();
    visit.recordSubmission(
      deriveProjectImportResult(['claude-only'], [CLAUDE], null),
    );
    visit.recordSubmission(
      deriveProjectImportResult(['claude-only'], [CLAUDE], {
        results: [result('claude-only', 'imported')],
      }),
    );
    visit.complete(completed([CLAUDE]), {
      claude: 'connected',
      codex: 'not_connected',
    });
    visit.complete(completed([CLAUDE]), CONNECTIONS);

    expect(
      succeed.mock.calls.filter(
        ([name]) => name === 'canopy.first_run_import_view',
      ),
    ).toEqual([
      [
        'canopy.first_run_import_view',
        {
          context: {
            claude_connection: 'connected',
            codex_connection: 'unknown',
          },
        },
      ],
    ]);
    const visitStart = start.mock.calls.find(
      ([name]) => name === 'canopy.first_run_import',
    );
    const ends = succeed.mock.calls.filter(
      ([name]) => name === 'canopy.first_run_import',
    );
    expect(ends).toEqual([
      [
        'canopy.first_run_import',
        {
          operationKey: visitStart?.[1]?.operationKey,
          context: {
            outcome: 'imported',
            scan_outcome: 'found',
            claude_data_detected: true,
            codex_data_detected: false,
            claude_connection: 'connected',
            codex_connection: 'not_connected',
            found_count: 1,
            credits_offered: true,
            imported_count: 1,
            submission_count: 2,
            failed_submission_count: 1,
            picked_folder: true,
          },
        },
      ],
    ]);
  });

  it('distinguishes an empty continue from a skip', () => {
    const empty = createFirstRunImportVisit();
    empty.begin(CONNECTIONS);
    empty.complete(completed([]), CONNECTIONS);
    const failed = createFirstRunImportVisit();
    failed.begin(CONNECTIONS);
    failed.complete({ kind: 'failed' }, CONNECTIONS);
    const ends = succeed.mock.calls
      .filter(([name]) => name === 'canopy.first_run_import')
      .map(([, options]) => options?.context);
    expect(ends[0]).toMatchObject({
      outcome: 'continued_empty',
      scan_outcome: 'empty',
      found_count: 0,
    });
    expect(ends[1]).toMatchObject({
      outcome: 'skipped',
      scan_outcome: 'failed',
    });
    expect(ends[1]).not.toHaveProperty('found_count');
    expect(ends[1]).not.toHaveProperty('claude_data_detected');
  });

  it('gives each visit its own key and completes nothing unbegun', () => {
    const unbegun = createFirstRunImportVisit();
    unbegun.complete(completed([]), CONNECTIONS);
    expect(succeed).not.toHaveBeenCalled();

    createFirstRunImportVisit().begin(CONNECTIONS);
    createFirstRunImportVisit().begin(CONNECTIONS);
    const keys = start.mock.calls
      .filter(([name]) => name === 'canopy.first_run_import')
      .map(([, options]) => options?.operationKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
