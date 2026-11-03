import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/widgets/chat_feed.dart';

void main() {
  Widget host(
    List<ChatMessage> messages, {
    ValueChanged<String>? onResend,
    ValueChanged<String>? onDiscard,
    bool Function(ChatMessage)? canResend,
  }) => MaterialApp(
    theme: AppTheme.light,
    home: Scaffold(
      body: ChatFeed(
        chatId: 'chat-1',
        messages: messages,
        expandedTurns: const {},
        turnInProgress: false,
        onToggleTurn: (_) {},
        onResend: onResend,
        canResend: canResend,
        onDiscard: onDiscard,
      ),
    ),
  );

  ChatMessage user(String id, {ChatDelivery? delivery, String? note}) =>
      ChatMessage(
        messageId: id,
        chatId: 'chat-1',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: 'hello $id',
        delivery: delivery,
        deliveryNote: note,
      );

  testWidgets('a not-sent row shows its reason, Resend, and Discard', (
    tester,
  ) async {
    final resent = <String>[], discarded = <String>[];
    await tester.pumpWidget(
      host(
        [
          user(
            'm1',
            delivery: ChatDelivery.notSent,
            note: 'Your desktop is offline.',
          ),
        ],
        onResend: resent.add,
        onDiscard: discarded.add,
      ),
    );
    expect(find.text('Not sent'), findsOneWidget);
    expect(find.text('Your desktop is offline.'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('message-resend-m1')));
    await tester.tap(find.byKey(const ValueKey('message-discard-m1')));
    expect(resent, ['m1']);
    expect(discarded, ['m1']);
  });

  testWidgets('a long delivery note is capped at three lines', (tester) async {
    await tester.pumpWidget(
      host([user('m1', delivery: ChatDelivery.notSent, note: 'reason ' * 200)]),
    );
    final note = tester.widget<Text>(find.text('reason ' * 200));
    expect(note.maxLines, 3);
    expect(note.overflow, TextOverflow.ellipsis);
  });

  testWidgets('an uncertain row reads Delivery uncertain', (tester) async {
    await tester.pumpWidget(
      host([user('m1', delivery: ChatDelivery.uncertain)], onResend: (_) {}),
    );
    expect(find.text('Delivery uncertain'), findsOneWidget);
    expect(find.text('Failed'), findsNothing);
  });

  testWidgets(
    'retry availability is resolved per message and refreshes cached rows',
    (tester) async {
      final messages = [
        user('uncertain', delivery: ChatDelivery.uncertain),
        user('rejected', delivery: ChatDelivery.notSent),
      ];
      final resent = <String>[], discarded = <String>[];
      bool canResend(ChatMessage message) =>
          message.delivery == ChatDelivery.notSent;
      await tester.pumpWidget(
        host(messages, onResend: resent.add, onDiscard: discarded.add),
      );
      expect(
        find.byKey(const ValueKey('message-resend-uncertain')),
        findsOneWidget,
      );
      await tester.pumpWidget(
        host(
          messages,
          onResend: resent.add,
          onDiscard: discarded.add,
          canResend: canResend,
        ),
      );
      expect(
        find.byKey(const ValueKey('message-resend-uncertain')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('message-discard-uncertain')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('message-resend-rejected')));
      await tester.tap(find.byKey(const ValueKey('message-discard-uncertain')));
      expect(resent, ['rejected']);
      expect(discarded, ['uncertain']);
      await tester.pumpWidget(
        host(messages, onResend: resent.add, onDiscard: discarded.add),
      );
      expect(
        find.byKey(const ValueKey('message-resend-uncertain')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('actions meet the 48px touch target', (tester) async {
    await tester.pumpWidget(
      host(
        [user('m1', delivery: ChatDelivery.notSent)],
        onResend: (_) {},
        onDiscard: (_) {},
      ),
    );
    final size = tester.getSize(
      find.byKey(const ValueKey('message-resend-m1')),
    );
    expect(size.height, greaterThanOrEqualTo(48));
  });

  testWidgets('a normal user row has no delivery footer', (tester) async {
    await tester.pumpWidget(host([user('m1')]));
    expect(find.byKey(const ValueKey('message-delivery-m1')), findsNothing);
  });
}
