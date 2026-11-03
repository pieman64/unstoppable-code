/// Synthetic `provider_usage` singleton payloads (CAN-3635/CAN-3636) in the
/// desktop-normalized wire shape (`PortalProviderUsageProjection`). Accounts,
/// plans and amounts are invented test data; no real account is represented.
library;

/// The instant every usage fixture is relative to, fixed once per run on a
/// whole minute. Widget tests inject it as the clock, so reset and updated
/// labels are deterministic; device runs, which use the real clock, still see
/// future resets as future.
final DateTime usageFixtureNow = () {
  final now = DateTime.now().toUtc();
  return DateTime.utc(now.year, now.month, now.day, now.hour, now.minute);
}();

String _at(Duration offset) => usageFixtureNow.add(offset).toIso8601String();

const String usageFixtureEmail = 'ada@example.test';

/// Claude, signed in, whose most-used window is `7-day` at 72%.
Map<String, dynamic> claudeUsageEntry({
  double fiveHour = 41,
  double sevenDay = 72,
  double sevenDayOpus = 12,
  Duration updatedAgo = const Duration(minutes: 2),
  Duration fiveHourResetIn = const Duration(hours: 2, minutes: 30),
  bool includeExtraUsage = true,
}) => {
  'provider': 'claude',
  'authState': 'authenticated',
  'planLabel': 'Claude Max 20x',
  'accountEmail': usageFixtureEmail,
  'lastUpdatedAt': _at(-updatedAgo),
  'windows': [
    {
      'id': 'five_hour',
      'label': '5-hour window',
      'usedPercent': fiveHour,
      'resetsAt': _at(fiveHourResetIn),
      'windowDurationMs': 5 * 60 * 60 * 1000,
    },
    {
      'id': 'seven_day',
      'label': '7-day',
      'usedPercent': sevenDay,
      'resetsAt': _at(const Duration(days: 3, hours: 4)),
      'windowDurationMs': 7 * 24 * 60 * 60 * 1000,
    },
    {
      'id': 'seven_day_opus',
      'label': '7-day Opus',
      'usedPercent': sevenDayOpus,
      'resetsAt': _at(const Duration(days: 3, hours: 4)),
      'windowDurationMs': 7 * 24 * 60 * 60 * 1000,
    },
    if (includeExtraUsage)
      {
        'id': 'extra_usage',
        'label': 'Extra usage',
        'usedPercent': 30,
        'credits': {'spent': 15.5, 'total': 50, 'unit': 'usd'},
      },
  ],
};

/// Codex, signed in, whose most-used window is `7-day window` at 55%.
Map<String, dynamic> codexUsageEntry({
  double primary = 18,
  double secondary = 55,
  Duration updatedAgo = const Duration(minutes: 5),
}) => {
  'provider': 'codex',
  'authState': 'authenticated',
  'planLabel': 'ChatGPT Pro',
  'accountEmail': usageFixtureEmail,
  'lastUpdatedAt': _at(-updatedAgo),
  'windows': [
    {
      'id': 'codex-primary',
      'label': '5-hour window',
      'usedPercent': primary,
      'resetsAt': _at(const Duration(hours: 1)),
      'windowDurationMs': 5 * 60 * 60 * 1000,
      'credits': {'remaining': 1250, 'unit': 'credits'},
    },
    {
      'id': 'codex-secondary',
      'label': '7-day window',
      'usedPercent': secondary,
      'resetsAt': _at(const Duration(days: 6)),
      'windowDurationMs': 7 * 24 * 60 * 60 * 1000,
      'credits': {'remaining': 1250, 'unit': 'credits'},
    },
  ],
};

/// Copilot quotas supplied by a desktop with the harness enabled.
Map<String, dynamic> copilotUsageEntry({
  double premium = 25,
  bool allUnlimited = false,
}) => {
  'provider': 'copilot',
  'authState': 'authenticated',
  'accountLabel': 'fixture-github-user',
  'lastUpdatedAt': _at(const Duration(minutes: -1)),
  'windows': [
    {'id': 'copilot-chat', 'label': 'Chat', 'unlimited': true},
    {
      'id': 'copilot-premium',
      'label': 'Premium requests',
      if (allUnlimited) 'unlimited': true else 'usedPercent': premium,
    },
  ],
};

Map<String, dynamic> signedOutUsageEntry(String provider) => {
  'provider': provider,
  'authState': 'unauthenticated',
  'windows': <Object>[],
};

Map<String, dynamic> failedUsageEntry(
  String provider, {
  String message = "Couldn't reach Claude. Check the desktop's connection.",
}) => {
  'provider': provider,
  'authState': 'error',
  'planLabel': 'Claude Max 20x',
  'accountEmail': usageFixtureEmail,
  'lastUpdatedAt': _at(const Duration(minutes: -1)),
  'error': {'kind': 'network', 'message': message},
  'windows': <Object>[],
};

/// The singleton payload carrying [claude] and [codex].
Map<String, dynamic> providerUsagePayload({
  Map<String, dynamic>? claude,
  Map<String, dynamic>? codex,
  Map<String, dynamic>? copilot,
  Duration updatedAgo = const Duration(minutes: 1),
}) => {
  'updatedAt': _at(-updatedAgo),
  'providers': [
    claude ?? claudeUsageEntry(),
    codex ?? codexUsageEntry(),
    ?copilot,
  ],
};

/// The `PortalEntityEnvelope` for the singleton.
Map<String, dynamic> providerUsageEntity(Map<String, dynamic> payload) => {
  'entityType': 'provider_usage',
  'localId': 'overview',
  'payload': payload,
};

/// A `portal.state.delta` envelope upserting the singleton.
Map<String, dynamic> providerUsageDeltaEnvelope(
  Map<String, dynamic> payload, {
  required int cursor,
}) => {
  'eventId': 'evt-usage-$cursor',
  'cursor': cursor,
  'type': 'portal.state.delta',
  'payload': {
    'scope': 'overview',
    'entities': [providerUsageEntity(payload)],
  },
};
