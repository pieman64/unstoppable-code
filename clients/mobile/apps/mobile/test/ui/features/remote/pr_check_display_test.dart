import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/data/models/remote_pr_check.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/features/remote/view_models/pr_check_display.dart';

void main() {
  RemotePrCheck check({String? status, String? executionState, Uri? uri}) =>
      RemotePrCheck(
        name: 'build',
        status: status,
        executionState: executionState,
        detailsUri: uri,
      );

  test('maps every detailed state to its label', () {
    const expected = {
      'queued': 'Queued',
      'running': 'Running',
      'success': 'Succeeded',
      'failure': 'Failed',
      'cancelled': 'Canceled',
      'timed_out': 'Timed out',
      'skipped': 'Skipped',
      'action_required': 'Action required',
      'neutral': 'Neutral',
    };
    for (final MapEntry(key: wire, value: label) in expected.entries) {
      // The detailed state wins over a contradicting coarse status.
      expect(
        prCheckDisplayState(
          check(status: 'success', executionState: wire),
        ).label,
        label,
        reason: wire,
      );
    }
  });

  test("falls back to an older desktop's four statuses", () {
    expect(prCheckDisplayState(check(status: 'success')).label, 'Succeeded');
    expect(prCheckDisplayState(check(status: 'failure')).label, 'Failed');
    expect(prCheckDisplayState(check(status: 'pending')).label, 'Pending');
    expect(prCheckDisplayState(check(status: 'neutral')).label, 'Neutral');
  });

  test('reads unknown or missing values as Neutral', () {
    expect(
      prCheckDisplayState(check(status: 'pending', executionState: 'paused')),
      PrCheckDisplayState.neutral,
    );
    expect(
      prCheckDisplayState(check(status: 'exploded')),
      PrCheckDisplayState.neutral,
    );
    expect(prCheckDisplayState(check()), PrCheckDisplayState.neutral);
  });

  test('colors states with the shared status vocabulary', () {
    for (final colors in [StatusColors.light, StatusColors.dark]) {
      final expected = {
        PrCheckDisplayState.running: colors.active,
        PrCheckDisplayState.queued: colors.quaternary,
        PrCheckDisplayState.skipped: colors.quaternary,
        PrCheckDisplayState.pending: colors.quaternary,
        PrCheckDisplayState.succeeded: colors.success,
        PrCheckDisplayState.failed: colors.failed,
        PrCheckDisplayState.timedOut: colors.failed,
        PrCheckDisplayState.actionRequired: colors.warning,
        PrCheckDisplayState.canceled: colors.neutral,
        PrCheckDisplayState.neutral: colors.neutral,
      };
      expect(expected.keys, unorderedEquals(PrCheckDisplayState.values));
      for (final MapEntry(key: state, value: color) in expected.entries) {
        expect(state.color(colors), color, reason: state.name);
      }
    }
  });

  test('only Running animates; every other state has a static glyph', () {
    for (final state in PrCheckDisplayState.values) {
      expect(state.isRunning, state == PrCheckDisplayState.running);
      expect(state.glyph == null, state.isRunning, reason: state.name);
    }
    expect(PrCheckDisplayState.pending.glyph, CanopyGlyph.clock);
  });

  test('counts succeeded checks in the header', () {
    expect(
      prChecksHeaderLabel([
        check(executionState: 'success'),
        check(status: 'success'),
        check(executionState: 'neutral'),
        check(executionState: 'failure'),
      ]),
      'Checks (2/4 passed)',
    );
    expect(prChecksHeaderLabel(const []), 'Checks (0/0 passed)');
  });

  test('opens by default only while the summary needs attention', () {
    expect(prChecksExpandedByDefault('failing'), isTrue);
    expect(prChecksExpandedByDefault('pending'), isTrue);
    expect(prChecksExpandedByDefault('passing'), isFalse);
    expect(prChecksExpandedByDefault('neutral'), isFalse);
    expect(prChecksExpandedByDefault('none'), isFalse);
    expect(prChecksExpandedByDefault('mystery'), isFalse);
    expect(prChecksExpandedByDefault(null), isFalse);
  });

  test('announces the name, state and link', () {
    expect(
      prCheckSemanticsLabel(
        check(
          executionState: 'failure',
          uri: Uri.parse('https://ci.example.com/1'),
        ),
      ),
      'build, Failed, opens in browser',
    );
    expect(
      prCheckSemanticsLabel(check(executionState: 'skipped')),
      'build, Skipped',
    );
  });
}
