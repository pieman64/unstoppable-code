import 'package:mobile/data/protocol/generated/usage.dart';

/// Formats a headline metric [value] according to its [TelemetryCardUnit].
String formatHeadlineValue(num value, TelemetryCardUnit unit) => switch (unit) {
  TelemetryCardUnit.currency => formatCurrency(value),
  TelemetryCardUnit.tokens => formatCompact(value),
  TelemetryCardUnit.count => formatCount(value),
};

/// `$1,284.50` — two decimals, thousands separators.
String formatCurrency(num usd) => '\$${_group(usd, 2)}';

/// `3,120` — integer with thousands separators.
String formatCount(num value) => _group(value, 0);

/// `1.2K` / `48.2M` / `2B` — compact, one decimal, trailing `.0` trimmed.
String formatCompact(num value) {
  final abs = value.abs();
  if (abs >= 1e9) return '${_trimOne(value / 1e9)}B';
  if (abs >= 1e6) return '${_trimOne(value / 1e6)}M';
  if (abs >= 1e3) return '${_trimOne(value / 1e3)}K';
  return _group(value, 0);
}

/// Signed percentage change from [previous] to [current] (e.g. `+12%`,
/// `-8%`), or `null` when there is no usable comparison base.
String? formatTrend(num current, num? previous) {
  if (previous == null || previous == 0) return null;
  final rounded = (((current - previous) / previous) * 100).round();
  return '${rounded > 0 ? '+' : ''}$rounded%';
}

/// `45s` / `3m 20s` / `2h 5m` — compact duration from milliseconds.
String formatDuration(num milliseconds) {
  final totalSeconds = (milliseconds / 1000).floor();
  if (totalSeconds < 60) return '${totalSeconds}s';
  final minutes = totalSeconds ~/ 60;
  final seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds == 0 ? '${minutes}m' : '${minutes}m ${seconds}s';
  }
  final hours = minutes ~/ 60;
  final remainderMinutes = minutes % 60;
  return remainderMinutes == 0 ? '${hours}h' : '${hours}h ${remainderMinutes}m';
}

/// `just now` / `5m ago` / `3h ago` / `2d ago` from an ISO-8601 timestamp;
/// empty string when [iso] cannot be parsed. [now] defaults to the clock.
String formatRelativeTime(String iso, {DateTime? now}) {
  final date = DateTime.tryParse(iso);
  if (date == null) return '';
  return formatRelativeDate(date, now: now);
}

/// [formatRelativeTime] for callers that already hold a [DateTime], so they do
/// not serialize one only to have it parsed straight back.
String formatRelativeDate(DateTime date, {DateTime? now}) {
  final diff = (now ?? DateTime.now()).difference(date);
  if (diff.inSeconds < 60) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
  if (diff.inHours < 24) return '${diff.inHours}h ago';
  return '${diff.inDays}d ago';
}

/// Whole-percent label for `numerator / denominator`, or `—` when the
/// denominator is zero (so callers never divide by zero).
String formatPercent(num numerator, num denominator) {
  if (denominator == 0) return '—';
  return '${((numerator / denominator) * 100).round()}%';
}

const List<String> _shortMonths = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// Short UTC axis-tick label for a bucket [iso], varying detail by
/// [granularity] (hour shows the hour; day/week show a short date). Rendered in
/// UTC to match the UTC-bucketed rollup; returns [iso] unchanged when it cannot
/// be parsed.
String formatBucketTick(String iso, TelemetryTimeGranularity granularity) {
  final parsed = DateTime.tryParse(iso);
  if (parsed == null) return iso;
  final date = parsed.toUtc();
  final month = _shortMonths[date.month - 1];
  if (granularity == TelemetryTimeGranularity.hour) {
    final rawHour = date.hour % 12 == 0 ? 12 : date.hour % 12;
    final meridiem = date.hour < 12 ? 'AM' : 'PM';
    return '$month ${date.day}, $rawHour $meridiem';
  }
  return '$month ${date.day}';
}

String _trimOne(num value) {
  final fixed = value.toStringAsFixed(1);
  return fixed.endsWith('.0') ? fixed.substring(0, fixed.length - 2) : fixed;
}

String _group(num value, int decimals) {
  final fixed = value.toStringAsFixed(decimals);
  final dot = fixed.indexOf('.');
  final intPart = dot == -1 ? fixed : fixed.substring(0, dot);
  final fraction = dot == -1 ? '' : fixed.substring(dot);
  final negative = intPart.startsWith('-');
  final digits = negative ? intPart.substring(1) : intPart;
  final buffer = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) buffer.write(',');
    buffer.write(digits[i]);
  }
  return '${negative ? '-' : ''}$buffer$fraction';
}
