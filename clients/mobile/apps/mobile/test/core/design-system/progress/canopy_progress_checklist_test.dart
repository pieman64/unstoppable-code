import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/progress/canopy_progress_checklist.dart';
import 'package:mobile/data/models/remote_progress_phases.dart';
import 'package:mobile/ui/core/theme.dart';

void main() {
  Widget host(Widget child) => MaterialApp(
    theme: AppTheme.dark,
    home: Scaffold(body: child),
  );

  testWidgets('renders one row per step with its label', (tester) async {
    await tester.pumpWidget(
      host(
        const CanopyProgressChecklist(
          steps: [
            CanopyProgressChecklistStep(
              label: 'Gathering changes',
              status: RemoteProgressStepStatus.completed,
            ),
            CanopyProgressChecklistStep(
              label: 'Summarizing changes',
              status: RemoteProgressStepStatus.active,
            ),
            CanopyProgressChecklistStep(
              label: 'Pushing to remote',
              status: RemoteProgressStepStatus.pending,
            ),
          ],
        ),
      ),
    );

    expect(find.text('Gathering changes'), findsOneWidget);
    expect(find.text('Summarizing changes'), findsOneWidget);
    expect(find.text('Pushing to remote'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('progress-icon-completed')),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('progress-icon-completed')),
        matching: find.byType(CanopyIcon),
      ),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('progress-icon-active')), findsOneWidget);
    expect(find.byKey(const ValueKey('progress-icon-pending')), findsOneWidget);
  });

  testWidgets('renders the badge and error text when supplied', (tester) async {
    await tester.pumpWidget(
      host(
        const CanopyProgressChecklist(
          steps: [
            CanopyProgressChecklistStep(
              label: 'Pushing to remote',
              status: RemoteProgressStepStatus.error,
            ),
          ],
          badge: CanopyProgressBadge(
            label: 'Failed',
            tone: CanopyProgressBadgeTone.error,
          ),
          error: 'no upstream branch',
        ),
      ),
    );

    expect(find.text('Failed'), findsOneWidget);
    expect(find.text('no upstream branch'), findsOneWidget);
    expect(find.byKey(const ValueKey('progress-icon-error')), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('progress-icon-error')),
        matching: find.byType(CanopyIcon),
      ),
      findsOneWidget,
    );
  });
}
