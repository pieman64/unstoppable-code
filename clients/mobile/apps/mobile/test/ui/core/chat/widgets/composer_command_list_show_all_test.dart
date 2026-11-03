import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/ui/core/chat/view_models/composer_menu_controller.dart';
import 'package:mobile/ui/core/chat/widgets/composer_command_list.dart';
import 'package:mobile/ui/core/theme.dart';

/// CAN-5271: a capped typed search ends with Show all, which expands in place
/// without editing the draft or moving focus, and rows keep unique keys
/// across repeated group runs.
void main() {
  Future<TextEditingController> pump(
    WidgetTester tester,
    List<ComposerCommand> rows,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final draft = TextEditingController();
    final focus = FocusNode();
    addTearDown(draft.dispose);
    addTearDown(focus.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: ComposerCommandMenu(
              draft: draft,
              source: ComposerCommandSource(
                scope: 'chat-1',
                load: () async => rows,
              ),
              actions: const [],
              enabled: true,
              dollar: false,
              child: TextField(controller: draft, focusNode: focus),
            ),
          ),
        ),
      ),
    );
    focus.requestFocus();
    await tester.pump();
    draft.value = const TextEditingValue(
      text: '/deploy',
      selection: TextSelection.collapsed(offset: 7),
    );
    await tester.pumpAndSettle();
    return draft;
  }

  testWidgets('Show all expands in place and keeps focus and draft', (
    tester,
  ) async {
    final draft = await pump(tester, [
      for (var index = 0; index < 7; index++)
        ComposerCommand(name: 'deploy-$index', insertText: '/deploy-$index '),
    ]);
    final list = find.descendant(
      of: find.byKey(const ValueKey('composer-command-list')),
      matching: find.byType(Scrollable),
    );
    final showAll = find.byKey(const ValueKey('composer-command-show-all'));
    await tester.drag(list, const Offset(0, -1000));
    await tester.pumpAndSettle();
    expect(showAll, findsOneWidget);
    expect(find.text('Show all 7'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('composer-command-skills-deploy-5')),
      findsNothing,
    );

    await tester.tap(showAll);
    await tester.pumpAndSettle();

    expect(draft.text, '/deploy');
    expect(showAll, findsNothing);
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('composer-command-skills-deploy-6')),
      40,
      scrollable: list,
    );
    expect(
      find.byKey(const ValueKey('composer-command-skills-deploy-6')),
      findsOneWidget,
    );
    expect(tester.testTextInput.isVisible, isTrue);
  });

  testWidgets('duplicate names do not collide with a naturally numbered name', (
    tester,
  ) async {
    await pump(tester, const [
      ComposerCommand(name: 'deploy', insertText: '/a:deploy '),
      ComposerCommand(name: 'deploy', insertText: '/b:deploy '),
      ComposerCommand(name: 'deploy-2', insertText: '/deploy-2 '),
    ]);
    expect(tester.takeException(), isNull);
    final rowKeys = tester
        .widgetList(
          find.byWidgetPredicate((widget) {
            final key = widget.key;
            return key is ValueKey<String> &&
                key.value.startsWith('composer-command-skills-');
          }),
        )
        .map((widget) => widget.key)
        .toList();
    expect(rowKeys, hasLength(3));
    expect(rowKeys.toSet(), hasLength(3));
  });

  testWidgets('same-name rows keep unique keys across repeated runs', (
    tester,
  ) async {
    await pump(tester, const [
      ComposerCommand(name: 'deploy', insertText: '/a:deploy '),
      ComposerCommand(
        name: 'deploy-later',
        insertText: '/deploy-later ',
        enableRef: {'sourceId': 's', 'skillName': 'deploy-later'},
      ),
      ComposerCommand(name: 'deploy', insertText: '/b:deploy '),
    ]);
    expect(
      find.byKey(const ValueKey('composer-command-skills-deploy')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
}
