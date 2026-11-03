/// Pure presentation rules for Account's Usage limits row and detail screen
/// (CAN-3636). The desktop normalizes every value; these rules only choose,
/// order and label them.
library;

import 'package:flutter/foundation.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/ui/core/format.dart';

/// Desktop thresholds (`USAGE_ALERT_WARNING_THRESHOLD` and
/// `USAGE_ALERT_CRITICAL_THRESHOLD` in
/// `packages/desktop-shared/src/lib/usage-alert.ts`).
const double kUsageWarningPercent = 80;
const double kUsageCriticalPercent = 98;

enum UsageTone { normal, warning, critical }

/// Tone of a used percentage, compared on the unrounded value.
UsageTone usageToneFor(num usedPercent) {
  if (usedPercent >= kUsageCriticalPercent) return UsageTone.critical;
  if (usedPercent >= kUsageWarningPercent) return UsageTone.warning;
  return UsageTone.normal;
}

/// Providers supported by every desktop version that supplies usage.
const List<PortalProviderUsageProvider> kUsageProviderOrder = [
  PortalProviderUsageProvider.claude,
  PortalProviderUsageProvider.codex,
];

/// Copilot appears only when the paired desktop publishes its gated entry.
List<PortalProviderUsageProvider> usageProviders(
  PortalProviderUsageProjection? projection,
) => [
  ...kUsageProviderOrder,
  if (usageEntryFor(projection, PortalProviderUsageProvider.copilot) != null)
    PortalProviderUsageProvider.copilot,
];

String usageProviderName(PortalProviderUsageProvider provider) =>
    switch (provider) {
      PortalProviderUsageProvider.claude => 'Claude',
      PortalProviderUsageProvider.codex => 'Codex',
      PortalProviderUsageProvider.copilot => 'Copilot',
    };

PortalProviderUsageEntry? usageEntryFor(
  PortalProviderUsageProjection? projection,
  PortalProviderUsageProvider provider,
) {
  if (projection == null) return null;
  for (final entry in projection.providers) {
    if (entry.provider == provider) return entry;
  }
  return null;
}

/// The window closest to its limit: the highest finite used percentage, the
/// first in desktop order on a tie. Null when no window reports one.
PortalProviderUsageWindow? mostUsedWindow(PortalProviderUsageEntry entry) {
  PortalProviderUsageWindow? best;
  for (final window in entry.windows) {
    final percent = window.usedPercent;
    if (window.unlimited == true || percent == null || !percent.isFinite) {
      continue;
    }
    if (best == null || percent > best.usedPercent!) best = window;
  }
  return best;
}

/// One provider line of the Account row.
@immutable
final class UsageSummaryLine {
  const UsageSummaryLine({
    required this.provider,
    this.usedPercent,
    this.windowLabel,
    this.unlimited = false,
  });

  final PortalProviderUsageProvider provider;

  /// The most-used window's percentage; null when no window reports one.
  final num? usedPercent;
  final String? windowLabel;
  final bool unlimited;

  /// `72% · 7-day`, or `Usage unavailable` without a percentage.
  String get valueLabel {
    final percent = usedPercent;
    if (unlimited) return 'Unlimited';
    if (percent == null) return 'Usage unavailable';
    final label = windowLabel;
    final value = '${percent.round()}%';
    return label == null || label.isEmpty ? value : '$value · $label';
  }

  @override
  bool operator ==(Object other) =>
      other is UsageSummaryLine &&
      other.provider == provider &&
      other.usedPercent == usedPercent &&
      other.windowLabel == windowLabel &&
      other.unlimited == unlimited;

  @override
  int get hashCode =>
      Object.hash(provider, usedPercent, windowLabel, unlimited);
}

/// The Account row's lines, one per signed-in provider in
/// [kUsageProviderOrder]. A provider whose usage fetch failed is still signed
/// in: its line reads unavailable, so the detail screen's error and refresh
/// stay reachable. Null hides the row: the desktop is unavailable or no
/// provider is signed in.
List<UsageSummaryLine>? usageSummaryLines({
  required bool desktopAvailable,
  required PortalProviderUsageProjection? projection,
}) {
  if (!desktopAvailable || projection == null) return null;
  final lines = [
    for (final provider in usageProviders(projection))
      if (usageEntryFor(projection, provider) case final entry?
          when entry.authState == PortalProviderUsageAuthState.authenticated ||
              entry.authState == PortalProviderUsageAuthState.error)
        _lineFor(entry),
  ];
  return lines.isEmpty ? null : List.unmodifiable(lines);
}

UsageSummaryLine _lineFor(PortalProviderUsageEntry entry) {
  final window = mostUsedWindow(entry);
  return UsageSummaryLine(
    provider: entry.provider,
    usedPercent: window?.usedPercent,
    windowLabel: window?.label,
    unlimited:
        entry.windows.isNotEmpty &&
        entry.windows.every((window) => window.unlimited == true),
  );
}

/// The reset instant of [window], or null when absent or unparseable.
DateTime? usageResetAt(PortalProviderUsageWindow window) {
  final raw = window.resetsAt;
  return raw == null ? null : DateTime.tryParse(raw);
}

/// Whether [window]'s reset time is at or before [now]; the desktop's
/// `isResetPassed`.
bool isUsageResetPassed(PortalProviderUsageWindow window, DateTime now) {
  final resetAt = usageResetAt(window);
  return resetAt != null && !resetAt.isAfter(now);
}

/// The earliest reset in [projection] still after [now], so an open screen
/// can show the passed-reset overlay when it arrives.
DateTime? nextUsageResetAfter(
  PortalProviderUsageProjection? projection,
  DateTime now,
) {
  DateTime? next;
  for (final entry in projection?.providers ?? const []) {
    for (final window in entry.windows) {
      final resetAt = usageResetAt(window);
      if (resetAt == null || !resetAt.isAfter(now)) continue;
      if (next == null || resetAt.isBefore(next)) next = resetAt;
    }
  }
  return next;
}

/// One decimal, like the desktop Usage page.
String formatUsedPercent(num usedPercent) =>
    '${usedPercent.toStringAsFixed(1)}%';

/// Bar fill for [usedPercent], clamped to the track.
double usageBarFraction(num usedPercent) =>
    (usedPercent / 100).clamp(0, 1).toDouble();

/// Credit lines for a window, only for amounts the desktop reported. USD
/// amounts are money; `credits` are a count and never take a dollar sign.
List<String> usageCreditLines(PortalProviderUsageCredits? credits) {
  if (credits == null) return const [];
  final usd = credits.unit == PortalProviderUsageCreditUnit.usd;
  String amount(num value) =>
      usd ? formatCurrency(value) : '${formatCount(value)} credits';
  final spent = credits.spent;
  final total = credits.total;
  final remaining = credits.remaining;
  return [
    if (spent != null)
      total == null
          ? 'Spent ${amount(spent)}'
          : 'Spent ${amount(spent)} of ${amount(total)}',
    if (remaining != null) '${amount(remaining)} remaining',
  ];
}
