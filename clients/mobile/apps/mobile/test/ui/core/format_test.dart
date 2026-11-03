import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/ui/core/format.dart';

void main() {
  group('format', () {
    test('formatCurrency groups thousands with two decimals', () {
      expect(formatCurrency(1284.5), '\$1,284.50');
      expect(formatCurrency(0), '\$0.00');
      expect(formatCurrency(1234567.891), '\$1,234,567.89');
    });

    test('formatCount groups thousands as an integer', () {
      expect(formatCount(3120), '3,120');
      expect(formatCount(42), '42');
    });

    test('formatCompact abbreviates large numbers', () {
      expect(formatCompact(950), '950');
      expect(formatCompact(1200), '1.2K');
      expect(formatCompact(48200000), '48.2M');
      expect(formatCompact(2000000000), '2B');
    });

    test('formatTrend returns a signed percentage or null', () {
      expect(formatTrend(110, 100), '+10%');
      expect(formatTrend(90, 100), '-10%');
      expect(formatTrend(100, null), isNull);
      expect(formatTrend(100, 0), isNull);
    });

    test('formatHeadlineValue dispatches on unit', () {
      expect(
        formatHeadlineValue(1284.5, TelemetryCardUnit.currency),
        '\$1,284.50',
      );
      expect(formatHeadlineValue(48200000, TelemetryCardUnit.tokens), '48.2M');
      expect(formatHeadlineValue(3120, TelemetryCardUnit.count), '3,120');
    });

    test('formatDuration renders compact durations', () {
      expect(formatDuration(45000), '45s');
      expect(formatDuration(200000), '3m 20s');
      expect(formatDuration(180000), '3m');
      expect(formatDuration(7500000), '2h 5m');
    });

    test('formatRelativeTime describes recent and old timestamps', () {
      final now = DateTime.now();
      expect(formatRelativeTime(now.toIso8601String()), 'just now');
      expect(
        formatRelativeTime(
          now.subtract(const Duration(hours: 3)).toIso8601String(),
        ),
        '3h ago',
      );
      expect(formatRelativeTime('not-a-date'), '');
    });

    group('formatPercent', () {
      test('rounds numerator/denominator to a whole percent', () {
        expect(formatPercent(3, 4), '75%');
        expect(formatPercent(1, 3), '33%');
        expect(formatPercent(5, 5), '100%');
      });

      test('returns an em dash when the denominator is zero', () {
        expect(formatPercent(3, 0), '—');
        expect(formatPercent(0, 0), '—');
      });
    });

    group('formatBucketTick', () {
      test('renders a short UTC date for day granularity', () {
        expect(
          formatBucketTick(
            '2026-07-02T00:00:00.000Z',
            TelemetryTimeGranularity.day,
          ),
          'Jul 2',
        );
      });

      test('includes the hour for hour granularity', () {
        expect(
          formatBucketTick(
            '2026-07-02T15:00:00.000Z',
            TelemetryTimeGranularity.hour,
          ),
          'Jul 2, 3 PM',
        );
      });

      test('returns the raw input when it cannot be parsed', () {
        expect(
          formatBucketTick('not-a-date', TelemetryTimeGranularity.day),
          'not-a-date',
        );
      });
    });
  });
}
