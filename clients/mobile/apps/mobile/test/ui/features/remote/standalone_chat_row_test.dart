import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/ui/features/remote/views/widgets/standalone_chat_row.dart';

void main() {
  group('StandaloneChatRow activity indicators', () {
    Widget host(RemoteStandaloneChat chat) => MaterialApp(
      theme: AppTheme.light,
      home: Scaffold(body: StandaloneChatRow(chat: chat)),
    );

    testWidgets('hasUnread shows the unread dot', (tester) async {
      await tester.pumpWidget(
        host(
          const RemoteStandaloneChat(
            localId: 'chat-1',
            projectLocalId: 'ws-1',
            title: 'Notes',
            hasUnread: true,
          ),
        ),
      );
      await tester.pump();

      expect(find.byTooltip('Unread'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('hasActiveChat swaps the dot for a working spinner', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          const RemoteStandaloneChat(
            localId: 'chat-1',
            projectLocalId: 'ws-1',
            title: 'Notes',
            hasActiveChat: true,
          ),
        ),
      );
      await tester.pump();

      // An active agent turn is always an animated spinner, never a static dot.
      expect(tester.hasRunningAnimations, isTrue);
      expect(
        find.byKey(const ValueKey('standalone-chat-working')),
        findsOneWidget,
      );
      expect(find.byType(ThinkingSpinner), findsOneWidget);
      expect(find.byTooltip('Working'), findsOneWidget);
      expect(
        tester.getCenter(find.byType(ThinkingSpinner)).dx,
        greaterThan(tester.getCenter(find.text('Notes')).dx),
      );
      expect(find.byKey(const ValueKey('standalone-chat-dot')), findsNothing);
    });

    testWidgets(
      'an idle chat has one muted title and no dot or model subtitle',
      (tester) async {
        await tester.pumpWidget(
          host(
            const RemoteStandaloneChat(
              localId: 'chat-1',
              projectLocalId: 'ws-1',
              title: 'Notes',
              modelLabel: 'GPT 5.6 Luna',
              archived: true,
            ),
          ),
        );
        await tester.pump();

        expect(find.byTooltip('Unread'), findsNothing);
        expect(find.text('Archived'), findsOneWidget);
        expect(find.byKey(const ValueKey('standalone-chat-dot')), findsNothing);
        expect(find.text('GPT 5.6 Luna'), findsNothing);
        expect(tester.widget<ListTile>(find.byType(ListTile)).leading, isNull);
      },
    );
  });
}
