import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/ui/core/chat/view_models/composer_command_menu.dart';

TextEditingValue _at(String text, [int? caret]) => TextEditingValue(
  text: text,
  selection: TextSelection.collapsed(offset: caret ?? text.length),
);

ComposerAction _action(String name, [String description = '']) =>
    ComposerAction(name: name, description: description, onRun: () {});

List<String> _names(List<ComposerMenuSection> sections) => [
  for (final section in sections)
    for (final entry in section.entries)
      switch (entry) {
        ComposerActionEntry(:final action) => action.name,
        ComposerCommandEntry(:final command) => command.name,
        ComposerShowAllEntry(:final count) => 'show-all:$count',
      },
];

void main() {
  group('findComposerTrigger', () {
    test('opens at the draft start and after whitespace or brackets', () {
      for (final text in ['/', '/rev', 'fix this /rev', 'a\n/rev']) {
        final trigger = findComposerTrigger(_at(text), dollar: false);
        expect(trigger, isNotNull, reason: text);
        expect(trigger!.character, '/');
        expect(trigger.end, text.length);
        expect(text.substring(trigger.start, trigger.end), startsWith('/'));
      }
      for (final open in ['(', '[', '{']) {
        final trigger = findComposerTrigger(_at('see $open/te'), dollar: false);
        expect(trigger?.query, 'te', reason: open);
      }
    });

    test('ignores a slash inside a word, path, or URL', () {
      for (final text in ['a/b', 'src/lib', 'https://x', 'say)/x']) {
        expect(findComposerTrigger(_at(text), dollar: false), isNull);
      }
    });

    test('whitespace after the token closes it', () {
      expect(findComposerTrigger(_at('/review '), dollar: false), isNull);
      expect(findComposerTrigger(_at('/review\n'), dollar: false), isNull);
    });

    test('reads only up to a collapsed caret', () {
      final value = _at('/review rest', 4);
      final trigger = findComposerTrigger(value, dollar: false);
      expect(trigger?.query, 'rev');
      expect(trigger?.start, 0);
      expect(trigger?.end, 4);
      expect(
        findComposerTrigger(
          const TextEditingValue(
            text: '/rev',
            selection: TextSelection(baseOffset: 0, extentOffset: 4),
          ),
          dollar: false,
        ),
        isNull,
      );
      expect(
        findComposerTrigger(
          const TextEditingValue(text: '/rev'),
          dollar: false,
        ),
        isNull,
      );
    });

    test(r'treats $ as a trigger only when enabled', () {
      expect(findComposerTrigger(_at(r'$sk'), dollar: false), isNull);
      final trigger = findComposerTrigger(_at(r'use $sk'), dollar: true);
      expect(trigger?.character, r'$');
      expect(trigger?.query, 'sk');
      expect(findComposerTrigger(_at(r'cost 5$'), dollar: true), isNull);
    });

    test('stops scanning after the desktop bound', () {
      final long = '/${'a' * (kComposerTriggerScanLimit - 1)}';
      expect(findComposerTrigger(_at(long), dollar: false), isNotNull);
      expect(findComposerTrigger(_at('${long}a'), dollar: false), isNull);
    });
  });

  group('searchComposerItems', () {
    ComposerSearchFields fields(ComposerCommand command) => (
      name: command.name,
      displayName: command.displayName,
      description: command.description,
      category: command.category,
      namespace: command.pluginName,
      memberName: command.memberName,
      available: command.availableToEnable,
    );

    test(
      'ranks exact, prefix and contains without single-token subsequences',
      () {
        const commands = [
          ComposerCommand(name: 'r-e-v'),
          ComposerCommand(name: 'prereview'),
          ComposerCommand(name: 'review-pr'),
          ComposerCommand(name: 'rev'),
          ComposerCommand(name: 'unrelated'),
        ];
        expect(
          searchComposerItems(commands, 'rev', fields).map((c) => c.name),
          ['rev', 'review-pr', 'prereview'],
        );
      },
    );

    test('excludes single-token subsequences', () {
      const commands = [ComposerCommand(name: 'abc')];
      expect(searchComposerItems(commands, 'ac', fields), isEmpty);
      expect(searchComposerItems(commands, 'ca', fields), isEmpty);
      expect(searchComposerItems(commands, 'd', fields), isEmpty);
    });

    test(
      'excludes categories and uses single-word descriptions as fallback',
      () {
        const commands = [
          ComposerCommand(name: 'alpha', description: 'test the app'),
          ComposerCommand(name: 'beta', category: 'test'),
          ComposerCommand(name: 'tester'),
        ];
        expect(
          searchComposerItems(commands, 'test', fields).map((c) => c.name),
          ['tester'],
        );
        expect(
          searchComposerItems(commands, 'the app', fields).map((c) => c.name),
          ['alpha'],
        );
      },
    );

    test('keeps input order for ties and an empty query', () {
      const commands = [
        ComposerCommand(name: 'deploy-b'),
        ComposerCommand(name: 'deploy-a'),
      ];
      expect(
        searchComposerItems(commands, 'deploy', fields).map((c) => c.name),
        ['deploy-b', 'deploy-a'],
      );
      expect(searchComposerItems(commands, '  ', fields), commands);
    });

    test(r'ignores a leading / or $ on the field', () {
      const commands = [ComposerCommand(name: r'$skill')];
      expect(searchComposerItems(commands, 'skill', fields), commands);
    });
  });

  group('buildComposerMenu', () {
    List<ComposerCommand> many(
      int count,
      String prefix, {
      bool available = false,
    }) => [
      for (var index = 0; index < count; index++)
        ComposerCommand(
          name: '$prefix-$index',
          insertText: '/$prefix-$index ',
          availableToEnable: available,
        ),
    ];

    test('ranks a typed search globally in contiguous runs', () {
      final sections = buildComposerMenu(
        actions: [_action('deploy-helper', 'Ship it')],
        commands: const [
          ComposerCommand(name: 'notes', description: 'Mentions ecom-debugger'),
          ComposerCommand(
            name: 'ecom-debugger',
            pluginName: 'ud-ecom-debugger',
            availableToEnable: true,
          ),
        ],
        query: 'ecom-debugger',
      );
      // The Available exact match outranks an enabled description match.
      expect(sections.map((s) => s.group), [
        ComposerMenuGroup.available,
        ComposerMenuGroup.skills,
      ]);
      expect(_names(sections), ['ecom-debugger', 'notes']);
    });

    test('finds flattened plugin members by plugin name', () {
      final sections = buildComposerMenu(
        actions: const [],
        commands: const [
          ComposerCommand(
            name: 'writing-docs',
            pluginName: 'docs-plugin',
            memberName: 'writing-docs',
            insertText: r'$writing-docs ',
          ),
          ComposerCommand(name: 'other', insertText: '/other '),
        ],
        query: 'docs-plugin',
      );
      expect(_names(sections), ['writing-docs']);
    });

    test('caps a typed search and ends with Show all', () {
      final sections = buildComposerMenu(
        actions: const [],
        commands: [
          ...many(6, 'deploy'),
          ...many(6, 'deploy-later', available: true),
        ],
        query: 'deploy',
      );
      expect(sections.map((s) => s.group), [
        ComposerMenuGroup.skills,
        ComposerMenuGroup.available,
      ]);
      expect(sections.first.entries, hasLength(5));
      expect(_names(sections).last, 'show-all:12');
      expect(_names(sections), hasLength(9));
      final expanded = buildComposerMenu(
        actions: const [],
        commands: [
          ...many(6, 'deploy'),
          ...many(6, 'deploy-later', available: true),
        ],
        query: 'deploy',
        expanded: true,
      );
      expect(_names(expanded), hasLength(12));
      expect(_names(expanded), isNot(contains('show-all:12')));
    });

    test(
      'shows five plus Show all for one group of six and none at the cap',
      () {
        expect(
          _names(
            buildComposerMenu(
              actions: const [],
              commands: many(6, 'deploy'),
              query: 'deploy',
            ),
          ),
          [
            for (var index = 0; index < 5; index++) 'deploy-$index',
            'show-all:6',
          ],
        );
        expect(
          _names(
            buildComposerMenu(
              actions: const [],
              commands: many(5, 'deploy'),
              query: 'deploy',
            ),
          ),
          [for (var index = 0; index < 5; index++) 'deploy-$index'],
        );
      },
    );

    test('keeps empty browsing uncapped', () {
      expect(
        _names(
          buildComposerMenu(
            actions: const [],
            commands: many(12, 'deploy'),
            query: '',
          ),
        ),
        hasLength(12),
      );
    });

    test('groups built-ins, host rows, and available rows in order', () {
      final sections = buildComposerMenu(
        actions: [_action('model'), _action('plan')],
        commands: const [
          ComposerCommand(name: 'enable-me', enableRef: {'sourceId': 's'}),
          ComposerCommand(name: 'review'),
        ],
        query: '',
      );
      expect(sections.map((s) => s.group), ComposerMenuGroup.values);
      expect(_names(sections), ['model', 'plan', 'review', 'enable-me']);
    });

    test('hides host rows named like a built-in and repeated rows', () {
      final sections = buildComposerMenu(
        actions: [_action('model')],
        commands: const [
          ComposerCommand(name: '/Model'),
          ComposerCommand(name: 'review'),
          ComposerCommand(name: 'review'),
        ],
        query: '',
      );
      expect(_names(sections), ['model', 'review']);
    });

    test('keeps same-name rows that insert or enable something else', () {
      const first = ComposerCommand(
        name: 'review',
        insertText: '/a:review ',
        enableRef: {'marketplaceId': 'mk', 'pluginName': 'a'},
      );
      const otherPlugin = ComposerCommand(
        name: 'review',
        insertText: '/a:review ',
        enableRef: {'marketplaceId': 'mk', 'pluginName': 'b'},
      );
      const otherText = ComposerCommand(
        name: 'review',
        displayName: '/b:review',
        insertText: '/b:review ',
        enableRef: {'marketplaceId': 'mk', 'pluginName': 'a'},
      );
      const repeated = ComposerCommand(
        name: 'Review',
        insertText: '/a:review ',
        enableRef: {'pluginName': 'a', 'marketplaceId': 'mk'},
      );
      final sections = buildComposerMenu(
        actions: const [],
        commands: const [first, otherPlugin, otherText, repeated],
        query: '',
      );
      expect(
        [
          for (final entry in sections.single.entries)
            (entry as ComposerCommandEntry).command,
        ],
        [first, otherPlugin, otherText],
      );
      // A qualified search still reaches the second plugin's row.
      final searched = buildComposerMenu(
        actions: const [],
        commands: const [first, otherText],
        query: 'b:rev',
      );
      expect(
        (searched.single.entries.single as ComposerCommandEntry).command,
        otherText,
      );
    });

    test(
      'CAN-3925 groups Portal rows by section and keeps distinct entries',
      () {
        const discovered = ComposerCommand(
          name: 'review',
          entryId: 'entry:command/review',
          requiresResolution: true,
        );
        const notesA = ComposerCommand(
          name: 'notes',
          entryId: 'entry:a/notes',
          requiresResolution: true,
          availableToEnable: true,
        );
        const notesB = ComposerCommand(
          name: 'notes',
          entryId: 'entry:b/notes',
          requiresResolution: true,
          availableToEnable: true,
        );
        final sections = buildComposerMenu(
          actions: [_action('model')],
          commands: const [notesA, discovered, notesB, notesA],
          query: '',
        );
        expect(sections.map((s) => s.group), [
          ComposerMenuGroup.commands,
          ComposerMenuGroup.skills,
          ComposerMenuGroup.available,
        ]);
        expect(
          [
            for (final entry in sections.last.entries)
              (entry as ComposerCommandEntry).command,
          ],
          [notesA, notesB],
        );
        expect(
          (sections[1].entries.single as ComposerCommandEntry).command,
          discovered,
        );
      },
    );

    test('filters every group and drops empty ones', () {
      final sections = buildComposerMenu(
        actions: [_action('model'), _action('thinking')],
        commands: const [
          ComposerCommand(name: 'review'),
          ComposerCommand(name: 'release'),
        ],
        query: 'rev',
      );
      expect(sections.map((s) => s.group), [ComposerMenuGroup.skills]);
      expect(_names(sections), ['review']);
    });
  });

  test('replaceComposerTrigger keeps the rest of the draft', () {
    const text = 'Привет 👋 /rev and more';
    final value = _at(text, text.indexOf(' and'));
    final trigger = findComposerTrigger(value, dollar: false)!;
    final next = replaceComposerTrigger(value, trigger, '/review ');
    expect(next.text, 'Привет 👋 /review  and more');
    expect(
      next.selection,
      TextSelection.collapsed(offset: text.indexOf('/') + 8),
    );
  });

  test('a host row inserts its text or the desktop fallback', () {
    const command = ComposerCommand(name: 'review');
    expect(command.insertion('/'), '/review ');
    expect(command.insertion(r'$'), r'$review ');
    expect(
      const ComposerCommand(name: 'r', insertText: '/r --fast ').insertion('/'),
      '/r --fast ',
    );
  });
}
