import {
  createPostHogOperationTracker,
  DESKTOP_OPERATIONS,
  type DesktopOperationName,
} from '../operations';

const contracts: ReadonlyArray<
  readonly [DesktopOperationName, string, readonly string[]]
> = [
  [
    'canopy.first_run_import_view',
    'onboarding:first_run_import_view',
    ['claude_connection', 'codex_connection'],
  ],
  [
    'canopy.first_run_import',
    'onboarding:first_run_import_end',
    [
      'outcome',
      'scan_outcome',
      'claude_data_detected',
      'codex_data_detected',
      'claude_connection',
      'codex_connection',
      'credits_offered',
      'found_count',
      'imported_count',
      'submission_count',
      'failed_submission_count',
      'picked_folder',
    ],
  ],
  [
    'canopy.project_import',
    'projects:import_end',
    [
      'source',
      'modal_entry',
      'scan_outcome',
      'claude_data_detected',
      'codex_data_detected',
      'claude_connection',
      'codex_connection',
      'found_count',
      'found_claude_count',
      'found_codex_count',
      'selected_count',
      'imported_count',
      'imported_claude_count',
      'imported_codex_count',
      'failed_count',
      'chats_imported_count',
      'picked_folder',
      'outcome',
    ],
  ],
  [
    'canopy.invite_send',
    'sharing:invite_send',
    [
      'invite_type',
      'invite_ref',
      'grant_ref',
      'recipient_kind',
      'share_audience',
      'container_type',
      'send_surface',
      'delivery',
    ],
  ],
  [
    'canopy.invite_accept',
    'sharing:invite_accept',
    [
      'invite_type',
      'invite_ref',
      'accept_surface',
      'container_type',
      'is_first_accept_on_install',
      'install_age_days',
    ],
  ],
  [
    'canopy.organization_create',
    'organization:create',
    ['creation_method', 'invite_included', 'project_count'],
  ],
  [
    'canopy.remote_pairing_start',
    'remote:pairing_start',
    ['pairing_kind', 'pairing_entry', 'peer_platform', 'is_additional_device'],
  ],
  [
    'canopy.remote_pairing',
    'remote:pairing_end',
    [
      'pairing_kind',
      'pairing_entry',
      'peer_platform',
      'is_additional_device',
      'outcome',
    ],
  ],
];

it.each(contracts)(
  'registers the approved contract for %s',
  (name, event, keys) => {
    expect(DESKTOP_OPERATIONS[name]).toEqual({
      kind: 'product',
      posthogEvent: event,
      contextKeys: keys,
    });
  },
);

it('correlates interleaved pairing durations and projects only validated bounded context', () => {
  let now = 10;
  const tracker = createPostHogOperationTracker({ now: () => now });
  tracker.start('canopy.remote_pairing', { operationKey: 'a' });
  now = 20;
  tracker.start('canopy.remote_pairing', { operationKey: 'b' });
  now = 30;
  expect(
    tracker.finish(
      'canopy.remote_pairing',
      { status: 'failure', failureReason: 'abandoned' },
      'background',
      {
        operationKey: 'a',
        context: {
          pairing_kind: 'phone_code',
          pairing_entry: 'portal_modal',
          peer_platform: 'unknown',
          is_additional_device: false,
          outcome: 'expired',
          pairing_code: '123456',
          device_name: 'private',
        },
      },
    ),
  ).toEqual({
    event: 'remote:pairing_end',
    properties: {
      pairing_kind: 'phone_code',
      pairing_entry: 'portal_modal',
      peer_platform: 'unknown',
      is_additional_device: false,
      outcome: 'expired',
      status: 'failure',
      failure_reason: 'abandoned',
      duration_ms: 20,
      surface: 'background',
    },
  });
  expect(
    tracker.finish(
      'canopy.remote_pairing',
      { status: 'success' },
      'background',
      {
        operationKey: 'b',
        context: {
          peer_platform: 'private-device',
          is_additional_device: 'yes',
        },
      },
    )?.properties,
  ).toEqual({ status: 'success', duration_ms: 10, surface: 'background' });
});

it('keeps visit timing across interleaved submissions and retries', () => {
  let now = 0;
  const tracker = createPostHogOperationTracker({ now: () => now });
  tracker.start('canopy.first_run_import', { operationKey: 'visit' });
  now = 10;
  tracker.start('canopy.project_import', { operationKey: 'first' });
  now = 20;
  tracker.start('canopy.project_import', { operationKey: 'second' });
  now = 30;
  expect(
    tracker.finish(
      'canopy.project_import',
      { status: 'failure', failureReason: 'error' },
      'main',
      { operationKey: 'first' },
    )?.properties.duration_ms,
  ).toBe(20);
  now = 50;
  expect(
    tracker.finish('canopy.project_import', { status: 'success' }, 'main', {
      operationKey: 'second',
    })?.properties.duration_ms,
  ).toBe(30);
  now = 70;
  expect(
    tracker.finish('canopy.first_run_import', { status: 'success' }, 'main', {
      operationKey: 'visit',
    })?.properties.duration_ms,
  ).toBe(70);
});

it('omits invalid enums, booleans, counts and raw attribution identifiers', () => {
  const tracker = createPostHogOperationTracker({ now: () => 0 });
  tracker.start('canopy.project_import');
  expect(
    tracker.finish(
      'canopy.project_import',
      { status: 'failure', failureReason: 'error' },
      'main',
      {
        context: {
          source: 'private',
          selected_count: -1,
          imported_count: 1.5,
          found_count: Infinity,
          picked_folder: 'yes',
          scan_outcome: 'empty',
          imported_codex_count: 0,
        },
      },
    )?.properties,
  ).toEqual({
    scan_outcome: 'empty',
    imported_codex_count: 0,
    status: 'failure',
    failure_reason: 'error',
    surface: 'main',
    duration_ms: 0,
  });
  expect(
    tracker.finish('canopy.invite_send', { status: 'success' }, 'background', {
      context: {
        invite_ref: 'raw-server-id',
        grant_ref: 'a'.repeat(16),
        delivery: 'sent',
      },
    })?.properties,
  ).toEqual({
    grant_ref: 'a'.repeat(16),
    delivery: 'sent',
    status: 'success',
    surface: 'background',
  });
});
