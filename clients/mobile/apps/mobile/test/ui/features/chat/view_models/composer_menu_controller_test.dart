import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/ui/core/chat/view_models/composer_command_menu.dart';
import 'package:mobile/ui/core/chat/view_models/composer_menu_controller.dart';

const _review = ComposerCommand(
  name: 'review',
  description: 'Review changes',
  insertText: '/review ',
);
const _available = ComposerCommand(
  name: 'notes',
  description: 'Release notes',
  insertText: '/notes ',
  enableRef: {'sourceId': 'src', 'skillName': 'notes'},
);

/// A Portal "Available to enable" row (CAN-3925).
const _portalAvailable = ComposerCommand(
  name: 'notes',
  description: 'Release notes',
  entryId: 'entry:skill/notes',
  requiresResolution: true,
  availableToEnable: true,
);

/// A host whose loads and enables the test completes by hand.
final class _Host {
  final loads = <Completer<List<ComposerCommand>>>[];
  final enables = <(ComposerCommand, Completer<bool>)>[];
  final resolves = <(ComposerCommand, Completer<String?>)>[];

  ComposerCommandSource source(
    Object scope, {
    bool withEnable = true,
    bool withResolve = true,
    Object? Function()? revision,
    bool Function()? unsettled,
  }) => ComposerCommandSource(
    scope: scope,
    revision: revision,
    unsettled: unsettled,
    load: () {
      final load = Completer<List<ComposerCommand>>();
      loads.add(load);
      return load.future;
    },
    enable: withEnable
        ? (command) {
            final enable = Completer<bool>();
            enables.add((command, enable));
            return enable.future;
          }
        : null,
    resolve: withResolve
        ? (command) {
            final resolve = Completer<String?>();
            resolves.add((command, resolve));
            return resolve.future;
          }
        : null,
  );
}

void main() {
  late TextEditingController draft;
  late ComposerMenuController menu;
  late _Host host;
  var modelRuns = 0;
  var fastRuns = 0;

  List<ComposerAction> actions() => [
    ComposerAction(
      name: 'model',
      description: 'Choose the model',
      onRun: () => modelRuns++,
    ),
    ComposerAction(
      name: 'fast',
      description: 'Toggle Fast mode',
      onRun: () => fastRuns++,
      disabledReason: 'Speed options are available for Codex models.',
    ),
  ];

  void configure({
    Object scope = 'chat-1',
    bool enabled = true,
    bool dollar = false,
    ComposerCommandSource? source,
  }) => menu.configure(
    source: source ?? host.source(scope),
    actions: actions(),
    enabled: enabled,
    dollar: dollar,
  );

  void type(String text, [int? caret]) => draft.value = TextEditingValue(
    text: text,
    selection: TextSelection.collapsed(offset: caret ?? text.length),
  );

  List<String> visible() => [
    for (final section in menu.sections)
      for (final entry in section.entries)
        switch (entry) {
          ComposerActionEntry(:final action) => action.name,
          ComposerCommandEntry(:final command) => command.name,
          ComposerShowAllEntry(:final count) => 'show-all:$count',
        },
  ];

  ComposerMenuEntry entry(String name) => menu.sections
      .expand((section) => section.entries)
      .firstWhere(
        (entry) => switch (entry) {
          ComposerActionEntry(:final action) => action.name == name,
          ComposerCommandEntry(:final command) => command.name == name,
          ComposerShowAllEntry(:final count) => 'show-all:$count' == name,
        },
      );

  setUp(() {
    draft = TextEditingController();
    menu = ComposerMenuController(draft);
    host = _Host();
    modelRuns = 0;
    fastRuns = 0;
  });

  tearDown(() {
    menu.dispose();
    draft.dispose();
  });

  test('opens on a focused trigger and shows built-ins at once', () {
    configure();
    type('/');
    expect(menu.isOpen, isFalse, reason: 'not focused yet');
    expect(host.loads, isEmpty, reason: 'loads lazily on open');
    menu.setFocused(true);
    expect(menu.isOpen, isTrue);
    expect(visible(), ['model', 'fast']);
    expect(menu.status, ComposerCommandsStatus.loading);
    expect(host.loads, hasLength(1));
    menu.setFocused(false);
    expect(menu.isOpen, isFalse);
  });

  test('a disabled composer or a missing source never opens', () {
    menu.setFocused(true);
    configure(enabled: false);
    type('/');
    expect(menu.isOpen, isFalse);
    menu.configure(
      source: null,
      actions: actions(),
      enabled: true,
      dollar: false,
    );
    expect(menu.isOpen, isFalse);
  });

  test('host rows appear when loaded and stay cached for the scope', () async {
    configure();
    menu.setFocused(true);
    type('/');
    host.loads.single.complete([_review, _available]);
    await pumpEventQueue();
    expect(menu.status, ComposerCommandsStatus.loaded);
    expect(visible(), ['model', 'fast', 'review', 'notes']);
    type('/rev');
    expect(visible(), ['review']);
    type('');
    type('/');
    configure();
    expect(host.loads, hasLength(1));
  });

  test(
    'Show all expands in place and resets on query, close and scope',
    () async {
      final rows = [
        for (var index = 0; index < 7; index++)
          ComposerCommand(name: 'deploy-$index', insertText: '/deploy-$index '),
      ];
      configure();
      menu.setFocused(true);
      type('/deploy');
      host.loads.single.complete(rows);
      await pumpEventQueue();
      expect(visible().last, 'show-all:7');
      expect(visible(), hasLength(6));

      await menu.select(entry('show-all:7'));
      expect(draft.text, '/deploy', reason: 'expansion never edits the draft');
      expect(menu.isOpen, isTrue);
      expect(visible(), hasLength(7));
      expect(visible(), isNot(contains('show-all:7')));

      type('/deploy-');
      expect(visible().last, 'show-all:7', reason: 'a new query collapses');
      type('/deploy');
      expect(
        visible().last,
        'show-all:7',
        reason: 'returning to an old query stays collapsed',
      );
      await menu.select(entry('show-all:7'));
      menu.setFocused(false);
      menu.setFocused(true);
      expect(visible().last, 'show-all:7', reason: 'closing collapses');
      await menu.select(entry('show-all:7'));
      configure(scope: 'chat-2');
      host.loads.last.complete(rows);
      await pumpEventQueue();
      expect(visible().last, 'show-all:7', reason: 'a chat change collapses');
    },
  );

  test('a failed load keeps built-ins and Retry loads again', () async {
    configure();
    menu.setFocused(true);
    type('/');
    host.loads.single.completeError(StateError('older desktop'));
    await pumpEventQueue();
    expect(menu.status, ComposerCommandsStatus.failed);
    expect(visible(), ['model', 'fast']);
    menu.retry();
    expect(menu.status, ComposerCommandsStatus.loading);
    host.loads.last.complete([_review]);
    await pumpEventQueue();
    expect(host.loads, hasLength(2));
    expect(visible(), ['model', 'fast', 'review']);
  });

  test('a load for an earlier scope is discarded', () async {
    configure(scope: 'model-a');
    menu.setFocused(true);
    type('/');
    configure(scope: 'model-b');
    expect(host.loads, hasLength(2));
    host.loads.first.complete([_review]);
    await pumpEventQueue();
    expect(menu.status, ComposerCommandsStatus.loading);
    expect(visible(), ['model', 'fast']);
    host.loads.last.complete(const []);
    await pumpEventQueue();
    expect(menu.status, ComposerCommandsStatus.loaded);
  });

  test('a built-in action consumes only its token and runs', () async {
    configure();
    menu.setFocused(true);
    type('keep /mo tail', 8);
    await menu.select(entry('model'));
    expect(modelRuns, 1);
    expect(draft.text, 'keep  tail');
    expect(draft.selection, const TextSelection.collapsed(offset: 5));
    expect(menu.isOpen, isFalse);
  });

  test('a disabled action does nothing', () async {
    configure();
    menu.setFocused(true);
    type('/fa');
    await menu.select(entry('fast'));
    expect(fastRuns, 0);
    expect(draft.text, '/fa');
  });

  test('a host row replaces its token and keeps the rest', () async {
    configure();
    menu.setFocused(true);
    type('Please /re now', 10);
    host.loads.single.complete([_review]);
    await pumpEventQueue();
    await menu.select(entry('review'));
    expect(draft.text, 'Please /review  now');
    expect(draft.selection, const TextSelection.collapsed(offset: 15));
    expect(menu.isOpen, isFalse);
  });

  test('stays closed after a selection until the draft changes', () async {
    configure();
    menu.setFocused(true);
    type('/');
    host.loads.single.complete(const [
      ComposerCommand(name: 'bare', insertText: '/bare'),
    ]);
    await pumpEventQueue();
    await menu.select(entry('bare'));
    expect(draft.text, '/bare');
    expect(menu.isOpen, isFalse);
    type('/bar');
    expect(menu.isOpen, isTrue);
  });

  test('an unavailable host row cannot be inserted', () async {
    configure();
    menu.setFocused(true);
    type('/');
    host.loads.single.complete(const [
      ComposerCommand(name: 'locked', unavailableReason: 'Sign in first'),
    ]);
    await pumpEventQueue();
    await menu.select(entry('locked'));
    expect(draft.text, '/');
  });

  test('an available row is inserted only after it is enabled', () async {
    configure();
    menu.setFocused(true);
    type('Hi /no');
    host.loads.single.complete([_available]);
    await pumpEventQueue();
    final selection = menu.select(entry('notes'));
    expect(menu.enabling, same(_available));
    expect(draft.text, 'Hi /no');
    // A second tap while enabling is ignored.
    await menu.select(entry('notes'));
    expect(host.enables, hasLength(1));
    host.enables.single.$2.complete(true);
    await selection;
    expect(draft.text, 'Hi /notes ');
    expect(menu.enabling, isNull);
    // The enabled row moves groups, so the next open loads again.
    type('Hi /notes x /');
    expect(host.loads, hasLength(2));
  });

  test('a failed enable shows the error and keeps the draft', () async {
    configure();
    menu.setFocused(true);
    type('Hi /no');
    host.loads.single.complete([_available]);
    await pumpEventQueue();
    final selection = menu.select(entry('notes'));
    host.enables.single.$2.completeError(StateError('denied'));
    await selection;
    expect(draft.text, 'Hi /no');
    expect(menu.enableError, kComposerEnableFailedMessage);
    expect(menu.isOpen, isTrue);
    type('Hi /not');
    expect(menu.enableError, isNull);
  });

  test(
    'rows load again as the list opens after the revision changed',
    () async {
      var revision = 'selected';
      configure(source: host.source('draft', revision: () => revision));
      menu.setFocused(true);
      type('/');
      host.loads.single.complete([_review]);
      await pumpEventQueue();
      type('');
      type('/');
      expect(host.loads, hasLength(1));
      expect(visible(), contains('review'));

      revision = 'cleared';
      type('');
      expect(host.loads, hasLength(1));
      type('/');
      expect(host.loads, hasLength(2));
      expect(visible(), isNot(contains('review')));
      host.loads.last.complete([_available]);
      await pumpEventQueue();
      expect(visible(), contains('notes'));
    },
  );

  test(
    'a revision change loads the rows again while the list is open',
    () async {
      var revision = 0;
      ComposerCommandSource source() =>
          host.source('chat', revision: () => revision);
      configure(source: source());
      menu.setFocused(true);
      type('/');
      host.loads.single.complete([_review]);
      await pumpEventQueue();
      expect(visible(), contains('review'));
      // A Plugins change while the list is open, applied at the next build.
      revision++;
      configure(source: source());
      expect(host.loads, hasLength(2));
      expect(visible(), isNot(contains('review')));
      host.loads.last.complete([_available]);
      await pumpEventQueue();
      expect(visible(), contains('notes'));
      configure(source: source());
      expect(host.loads, hasLength(2), reason: 'an unchanged revision');
    },
  );

  test('an unsettled answer loads again only as the list opens', () async {
    var unsettled = true;
    ComposerCommandSource source() =>
        host.source('chat', unsettled: () => unsettled);
    configure(source: source());
    menu.setFocused(true);
    type('/');
    host.loads.single.complete([_review]);
    await pumpEventQueue();
    // Builds and typing while the list stays open do not load again.
    for (final text in ['/r', '/re', '/']) {
      configure(source: source());
      type(text);
      await pumpEventQueue();
    }
    expect(host.loads, hasLength(1));

    type('');
    type('/');
    expect(host.loads, hasLength(2));
    expect(visible(), contains('review'), reason: 'its rows stay shown');
    expect(menu.status, ComposerCommandsStatus.loading);
    unsettled = false;
    host.loads.last.complete([_review, _available]);
    await pumpEventQueue();
    expect(visible(), containsAll(['review', 'notes']));

    type('');
    type('/');
    expect(host.loads, hasLength(2), reason: 'a settled answer is kept');
  });

  test('a revision change during a load drops its answer', () async {
    var revision = 0;
    ComposerCommandSource source() =>
        host.source('chat', revision: () => revision);
    configure(source: source());
    menu.setFocused(true);
    type('/');
    revision++;
    configure(source: source());
    expect(host.loads, hasLength(2));
    host.loads.first.complete([_review]);
    await pumpEventQueue();
    expect(visible(), isNot(contains('review')));
    expect(menu.status, ComposerCommandsStatus.loading);
    host.loads.last.complete([_available]);
    await pumpEventQueue();
    expect(visible(), contains('notes'));
  });

  test('a superseded enable inserts nothing and shows no error', () async {
    configure();
    menu.setFocused(true);
    type('Hi /no');
    host.loads.single.complete([_available]);
    await pumpEventQueue();
    final selection = menu.select(entry('notes'));
    host.enables.single.$2.complete(false);
    await selection;
    expect(draft.text, 'Hi /no');
    expect(menu.enabling, isNull);
    expect(menu.enableError, isNull);
    expect(menu.isOpen, isTrue);
  });

  test('a late enable does not overwrite an edited draft', () async {
    configure();
    menu.setFocused(true);
    type('/no');
    host.loads.single.complete([_available]);
    await pumpEventQueue();
    final selection = menu.select(entry('notes'));
    type('/no and more typing');
    host.enables.single.$2.complete(true);
    await selection;
    expect(draft.text, '/no and more typing');
  });

  test('a late enable does not insert into another chat', () async {
    configure(scope: 'chat-1');
    menu.setFocused(true);
    type('/no');
    host.loads.single.complete([_available]);
    await pumpEventQueue();
    final selection = menu.select(entry('notes'));
    configure(scope: 'chat-2');
    host.enables.single.$2.completeError(StateError('late'));
    await selection;
    expect(draft.text, '/no');
    expect(menu.enableError, isNull);
  });

  test('a disposed composer ignores late results', () async {
    final draft = TextEditingController();
    final menu = ComposerMenuController(draft);
    menu.configure(
      source: host.source('chat-1'),
      actions: actions(),
      enabled: true,
      dollar: false,
    );
    menu.setFocused(true);
    draft.value = const TextEditingValue(
      text: '/',
      selection: TextSelection.collapsed(offset: 1),
    );
    menu.dispose();
    host.loads.single.complete([_review]);
    await pumpEventQueue();
    draft.dispose();
  });

  test(r'$ opens only when the host enables it', () {
    configure();
    menu.setFocused(true);
    type(r'$');
    expect(menu.isOpen, isFalse);
    configure(dollar: true);
    expect(menu.isOpen, isTrue);
    expect(menu.trigger?.character, r'$');
  });
  group('CAN-3925 resolve before insertion', () {
    Future<void> listNotes(String text) async {
      menu.setFocused(true);
      type(text);
      host.loads.single.complete([_portalAvailable]);
      await pumpEventQueue();
    }

    test('inserts the text the host returns, not the listed text', () async {
      configure();
      await listNotes('Hi /no');
      final selection = menu.select(entry('notes'));
      expect(menu.enabling, same(_portalAvailable));
      expect(host.enables, isEmpty);
      expect(host.resolves.single.$1, same(_portalAvailable));
      host.resolves.single.$2.complete('/release-kit:notes ');
      await selection;
      expect(draft.text, 'Hi /release-kit:notes ');
      expect(draft.selection, const TextSelection.collapsed(offset: 22));
      expect(menu.enabling, isNull);
      // The resolved row changes the chat's inventory: load again.
      type('Hi /release-kit:notes /');
      expect(host.loads, hasLength(2));
    });

    test('a discovered row that requires resolution resolves too', () async {
      configure();
      menu.setFocused(true);
      type('/re');
      host.loads.single.complete([
        const ComposerCommand(
          name: 'review',
          insertText: '/review ',
          entryId: 'entry:command/review',
          requiresResolution: true,
        ),
      ]);
      await pumpEventQueue();
      final selection = menu.select(entry('review'));
      host.resolves.single.$2.complete('/codex-review ');
      await selection;
      expect(draft.text, '/codex-review ');
    });

    test('a failed resolve shows the error and keeps the draft', () async {
      configure();
      await listNotes('Keep /no');
      final selection = menu.select(entry('notes'));
      final before = draft.value;
      host.resolves.single.$2.completeError(StateError('denied'));
      await selection;
      expect(draft.value, before);
      expect(menu.enableError, kComposerEnableFailedMessage);
    });

    test('a superseded resolve inserts nothing and shows no error', () async {
      configure();
      await listNotes('Hi /no');
      final selection = menu.select(entry('notes'));
      host.resolves.single.$2.complete(null);
      await selection;
      expect(draft.text, 'Hi /no');
      expect(menu.enableError, isNull);
    });

    test('a late resolve does not overwrite an edited draft', () async {
      configure();
      await listNotes('/no');
      final selection = menu.select(entry('notes'));
      type('/no and more');
      host.resolves.single.$2.complete('/notes ');
      await selection;
      expect(draft.text, '/no and more');
    });

    test('a late resolve stays stale after editing away and back', () async {
      configure();
      await listNotes('/no');
      final selection = menu.select(entry('notes'));
      type('/new');
      type('/no');
      host.resolves.single.$2.complete('/notes ');
      await selection;
      expect(draft.text, '/no');
    });

    test('a late resolve does not insert into another chat', () async {
      configure(scope: 'chat-1');
      await listNotes('/no');
      final selection = menu.select(entry('notes'));
      configure(scope: 'chat-2');
      host.resolves.single.$2.complete('/notes ');
      await selection;
      expect(draft.text, '/no');
    });

    test('a source without resolve never inserts the row', () async {
      configure(source: host.source('chat-1', withResolve: false));
      await listNotes('/no');
      final selection = menu.select(entry('notes'));
      await selection;
      expect(draft.text, '/no');
      expect(menu.enabling, isNull);
    });
  });
}
