import 'package:mobile/data/protocol/generated/usage.dart';

/// A time-series pivoted for a stacked bar chart.
class PivotedSeries {
  const PivotedSeries({
    required this.buckets,
    required this.keys,
    required this.valuesByBucket,
  });

  /// Bucket ISO starts, sorted ascending.
  final List<String> buckets;

  /// Distinct series keys, in first-seen order.
  final List<String> keys;

  /// `valuesByBucket[bucketIso][key]` -> summed value (0 for absent keys).
  final Map<String, Map<String, double>> valuesByBucket;
}

const Map<TelemetryTimeGranularity, int> _stepMsByGranularity = {
  TelemetryTimeGranularity.hour: 3600000,
  TelemetryTimeGranularity.day: 86400000,
  TelemetryTimeGranularity.week: 604800000,
};

/// Reproduce the DB-aligned bucket starts across `[startIso, endIso)`, phased
/// off [anchorIso] and walked in exact UTC step multiples so a single active
/// bucket renders one slot instead of stretching across the chart.
List<String> _expectedBucketStarts(
  TeamUsageResponseRange range,
  String anchorIso,
) {
  final step = _stepMsByGranularity[range.granularity];
  final start = DateTime.tryParse(range.startIso);
  final end = DateTime.tryParse(range.endIso);
  final anchor = DateTime.tryParse(anchorIso);
  if (step == null || start == null || end == null || anchor == null) {
    return const [];
  }
  final startMs = start.toUtc().millisecondsSinceEpoch;
  final endMs = end.toUtc().millisecondsSinceEpoch;
  final anchorMs = anchor.toUtc().millisecondsSinceEpoch;
  final offset = (((startMs - anchorMs) % step) + step) % step;
  final first = startMs - offset;
  final starts = <String>[];
  for (var ms = first; ms < endMs; ms += step) {
    starts.add(
      DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true).toIso8601String(),
    );
  }
  return starts;
}

/// Pivot flat [rows] into per-key series keyed by bucket, gap-filling the
/// expected bucket grid from [range]. Returns empty series when [rows] is empty.
PivotedSeries pivotBuckets<T>(
  List<T> rows,
  String Function(T) bucketOf,
  String Function(T) keyOf,
  double Function(T) valueOf,
  TeamUsageResponseRange range,
) {
  final keys = <String>[];
  final valuesByBucket = <String, Map<String, double>>{};
  final orderedBuckets = <String>[];

  for (final row in rows) {
    final key = keyOf(row);
    if (!keys.contains(key)) keys.add(key);
    final bucket = bucketOf(row);
    final byKey = valuesByBucket.putIfAbsent(bucket, () {
      orderedBuckets.add(bucket);
      return <String, double>{};
    });
    byKey[key] = (byKey[key] ?? 0) + valueOf(row);
  }

  if (orderedBuckets.isNotEmpty) {
    final anchor = orderedBuckets.first;
    for (final iso in _expectedBucketStarts(range, anchor)) {
      if (!valuesByBucket.containsKey(iso)) {
        valuesByBucket[iso] = <String, double>{};
        orderedBuckets.add(iso);
      }
    }
  }

  orderedBuckets.sort((a, b) => a.compareTo(b));
  for (final bucket in orderedBuckets) {
    final byKey = valuesByBucket[bucket]!;
    for (final key in keys) {
      byKey.putIfAbsent(key, () => 0);
    }
  }

  return PivotedSeries(
    buckets: orderedBuckets,
    keys: keys,
    valuesByBucket: valuesByBucket,
  );
}

/// Total tokens (all four categories) for a token bucket.
double tokenBucketTotal(TelemetryTokenBucket bucket) =>
    (bucket.inputTokens +
            bucket.outputTokens +
            bucket.cacheReadInputTokens +
            bucket.cacheCreationInputTokens)
        .toDouble();

/// One aggregated token row for the breakdown table.
class TokenBreakdownRow {
  const TokenBreakdownRow({
    required this.key,
    required this.inputTokens,
    required this.outputTokens,
    required this.total,
  });

  final String key;
  final double inputTokens;
  final double outputTokens;
  final double total;
}

/// Group token buckets by key, sum, and sort by total descending.
List<TokenBreakdownRow> aggregateTokenBreakdown(
  List<TelemetryTokenBucket> buckets,
) {
  final input = <String, double>{};
  final output = <String, double>{};
  final total = <String, double>{};
  final order = <String>[];
  for (final bucket in buckets) {
    if (!order.contains(bucket.key)) order.add(bucket.key);
    input[bucket.key] = (input[bucket.key] ?? 0) + bucket.inputTokens;
    output[bucket.key] = (output[bucket.key] ?? 0) + bucket.outputTokens;
    total[bucket.key] = (total[bucket.key] ?? 0) + tokenBucketTotal(bucket);
  }
  final rows = order
      .map(
        (key) => TokenBreakdownRow(
          key: key,
          inputTokens: input[key] ?? 0,
          outputTokens: output[key] ?? 0,
          total: total[key] ?? 0,
        ),
      )
      .toList();
  rows.sort((a, b) => b.total.compareTo(a.total));
  return rows;
}

/// One aggregated cost row for the breakdown table.
class CostBreakdownRow {
  const CostBreakdownRow({required this.key, required this.total});

  final String key;
  final double total;
}

/// Group cost buckets by key, sum, and sort by total descending.
List<CostBreakdownRow> aggregateCostBreakdown(
  List<TelemetryCostBucket> buckets,
) {
  final total = <String, double>{};
  final order = <String>[];
  for (final bucket in buckets) {
    if (!order.contains(bucket.key)) order.add(bucket.key);
    total[bucket.key] = (total[bucket.key] ?? 0) + bucket.totalCostUsd;
  }
  final rows = order
      .map((key) => CostBreakdownRow(key: key, total: total[key] ?? 0))
      .toList();
  rows.sort((a, b) => b.total.compareTo(a.total));
  return rows;
}

/// Pipeline type classification derived purely from the client pipeline id.
enum PipelineUsageType { bundled, shared, project, private }

final RegExp _yamlSuffix = RegExp(r'\.ya?ml$', caseSensitive: false);

/// Classify a pipeline's type from its [clientPipelineId] using stable id
/// conventions: `shared:` -> shared, `bundled-` -> bundled, `*.yaml`/path ->
/// project, anything else -> private.
PipelineUsageType classifyPipelineType(String clientPipelineId) {
  if (clientPipelineId.startsWith('shared:')) return PipelineUsageType.shared;
  if (clientPipelineId.startsWith('bundled-')) {
    return PipelineUsageType.bundled;
  }
  if (_yamlSuffix.hasMatch(clientPipelineId) ||
      clientPipelineId.contains('/') ||
      clientPipelineId.contains(r'\')) {
    return PipelineUsageType.project;
  }
  return PipelineUsageType.private;
}

/// Title-case a snake/UPPER enum string, e.g. `WORKTREE_CHAT` -> "Worktree Chat".
String _humanizeEnum(String value) => value
    .split(RegExp(r'[_\s]+'))
    .where((part) => part.isNotEmpty)
    .map((part) => part[0].toUpperCase() + part.substring(1).toLowerCase())
    .join(' ');

const Map<String, String> _eventTypeLabels = {
  'WORKTREE_CHAT': 'Worktree Chat',
  'STANDALONE_CHAT': 'Standalone Chat',
  'APP_ADVISOR': 'Orchestrator',
  'PIPELINE_EDITOR': 'Pipeline Editor',
  'PIPELINE_AGENT_TURN': 'Pipeline',
  'PIPELINE_ADVISOR': 'Pipeline Advisor',
  'PR_GENERATION': 'PR Generation',
  'COMMIT_MESSAGE_GENERATION': 'Commit Message',
  'BRANCH_NAMING': 'Branch Naming',
  'CRON_GENERATION': 'Cron Generation',
  'AUTOMATION_IF_COMMAND_GENERATION': 'Automation Command',
  'WORKTREE_SUMMARY': 'Worktree Summary',
  'CHAT_SUMMARY': 'Chat Summary',
  'ARCHIVE_SUMMARY': 'Archive Summary',
  'WORKTREE_PLAN_CHAT': 'Plan Chat',
  'WORKTREE_PLAN_DIAGRAM': 'Plan Diagram',
};

/// Friendly label for a telemetry event-type enum value.
String eventTypeLabel(String key) =>
    _eventTypeLabels[key] ?? _humanizeEnum(key);

const Map<String, String> _turnStatusLabels = {
  'RUNNING': 'Running',
  'SUCCESS': 'Success',
  'FAILURE': 'Failure',
  'CANCELLED': 'Cancelled',
  'INTERRUPTED': 'Interrupted',
};

/// Friendly label for a telemetry turn-status enum value.
String turnStatusLabel(String key) =>
    _turnStatusLabels[key] ?? _humanizeEnum(key);

const Map<String, String> _toolCategoryLabels = {
  // Retain the legacy telemetry key while keeping the visible category
  // independent of the active product brand.
  'CANOPY': 'Built-in',
};

/// Friendly, brand-neutral label for a telemetry tool category.
String toolCategoryLabel(String key) =>
    _toolCategoryLabels[key.toUpperCase()] ?? _humanizeEnum(key);

/// Keep the top [maxKeys] series by grand total and merge the remainder into a
/// single [othersKey] series (values summed per bucket). Series with <=
/// [maxKeys] keys are returned unchanged.
PivotedSeries foldTopKeys(
  PivotedSeries series, {
  int maxKeys = 6,
  String othersKey = 'Others',
}) {
  if (series.keys.length <= maxKeys) return series;
  final totals = <String, double>{};
  for (final key in series.keys) {
    var sum = 0.0;
    for (final bucket in series.buckets) {
      sum += series.valuesByBucket[bucket]?[key] ?? 0;
    }
    totals[key] = sum;
  }
  final ranked = series.keys.where((key) => key != othersKey).toList()
    ..sort((a, b) => (totals[b] ?? 0).compareTo(totals[a] ?? 0));
  final topKeys = ranked.take(maxKeys).toList();
  final foldedKeys = ranked.skip(maxKeys).toSet();
  final hasExistingOthers = series.keys.contains(othersKey);
  final nextKeys = [
    ...topKeys,
    if (hasExistingOthers || foldedKeys.isNotEmpty) othersKey,
  ];
  final nextValues = <String, Map<String, double>>{};
  for (final bucket in series.buckets) {
    final source = series.valuesByBucket[bucket] ?? const {};
    final byKey = <String, double>{};
    var others = source[othersKey] ?? 0.0;
    for (final entry in source.entries) {
      if (entry.key == othersKey) {
        continue;
      } else if (foldedKeys.contains(entry.key)) {
        others += entry.value;
      } else {
        byKey[entry.key] = entry.value;
      }
    }
    for (final key in topKeys) {
      byKey.putIfAbsent(key, () => 0);
    }
    if (hasExistingOthers || foldedKeys.isNotEmpty) {
      byKey[othersKey] = others;
    }
    nextValues[bucket] = byKey;
  }
  return PivotedSeries(
    buckets: series.buckets,
    keys: nextKeys,
    valuesByBucket: nextValues,
  );
}
