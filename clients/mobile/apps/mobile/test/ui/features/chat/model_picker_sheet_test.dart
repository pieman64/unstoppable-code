import 'dart:async';
import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_control.dart';
import 'package:mobile/core/design-system/composer/canopy_model_icon.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/model_picker_tab_store.dart';
import 'package:mobile/data/models/model_routing_availability.dart';
import 'package:mobile/data/services/model_picker_tab_preference_store.dart';
import 'package:provider/provider.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/view_models/model_routing_availability_controller.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';

/// Desktop-shaped catalog rows, as a current Remote host sends them.
final _catalog = ModelOption.listFromJson(const [
  {
    'id': 'claude-opus',
    'label': 'Claude Opus 4.6',
    'description': 'Most capable Claude model.',
    'provider': 'claude',
    'source': 'claude',
    'vendor': 'anthropic',
    'sortOrder': 10,
    'contextWindow': 1000000,
    'thinkingLevels': ['off', 'medium', 'high'],
  },
  {
    'id': 'claude-sonnet',
    'label': 'Claude Sonnet 4.5',
    'provider': 'claude',
    'source': 'claude',
    'vendor': 'anthropic',
    'sortOrder': 20,
  },
  {
    'id': 'claude-legacy',
    'label': 'Claude 3 Opus',
    'provider': 'claude',
    'source': 'claude',
    'vendor': 'anthropic',
    'sortOrder': 90,
    'showMoreOnly': true,
  },
  {
    'id': 'gpt-5-codex',
    'label': 'GPT-5 Codex',
    'provider': 'codex',
    'source': 'codex',
    'vendor': 'openai',
    'sortOrder': 30,
    'thinkingLevels': ['off'],
  },
  {
    'id': 'deepseek-v3',
    'label': 'DeepSeek V3',
    'provider': 'codex',
    'source': 'ai-gateway',
    'harness': 'codex',
    'vendor': 'deepseek',
    'sortOrder': 40,
    'contextWindow': 128000,
  },
  {
    'id': 'cursor-default',
    'label': 'Cursor Auto',
    'provider': 'cursor',
    'source': 'cursor',
    'sortOrder': 50,
  },
]);

ComposerControlsData _data({
  String? selectedModelId = 'claude-opus',
  String? modelLabel = 'Claude Opus 4.6',
  List<ModelOption>? models,
  ProviderAvailability? availability = const ProviderAvailability(
    claude: true,
    codex: true,
  ),
  ValueChanged<String>? onSelect,
  ModelCatalogStatus status = ModelCatalogStatus.loaded,
  VoidCallback? onRetry,
  String? lockedHarness,
  ModelAutoControl? auto,
}) => ComposerControlsData(
  providerType: 'claude',
  modelLabel: modelLabel,
  selectedModelId: selectedModelId,
  availableModels: models ?? _catalog,
  providerAvailability: availability,
  effort: null,
  speed: CanopyEffortSpeed.regular,
  supportsFastMode: false,
  isRunning: false,
  onSelectModel: onSelect ?? (_) {},
  onToggleFast: () {},
  onStop: () {},
  catalogStatus: status,
  onRetryCatalog: onRetry,
  emptyCatalogHint: 'Check model settings in the desktop app.',
  lockedHarness: lockedHarness,
  auto: auto,
);

Future<void> _pump(
  WidgetTester tester,
  ComposerControlsData data, {
  ThemeData? theme,
  double textScale = 1,
  ModelPickerTabStore? store,
  ModelRoutingAvailabilityController? routing,
  Size size = const Size(390, 844),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MultiProvider(
      providers: [
        Provider<ModelPickerTabStore?>.value(value: store),
        if (routing != null)
          ChangeNotifierProvider<ModelRoutingAvailabilityController>.value(
            value: routing,
          ),
      ],
      child: MaterialApp(
        theme: theme ?? AppTheme.light,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomLeft,
            child: ComposerToolbar(data: data),
          ),
        ),
      ),
    ),
  );
}

Future<void> _open(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('composer-model')));
  await tester.pumpAndSettle();
}

Finder _row(String id) => find.byKey(ValueKey('model-option-$id'));

final _autoRow = find.byKey(const ValueKey('model-picker-auto'));

ModelRoutingAvailabilityController _routing(ModelRoutingAvailability state) =>
    ModelRoutingAvailabilityController(
      load: () async => state,
      accountScope: () => null,
    );

void main() {
  testWidgets('All models groups rows by vendor in sortOrder', (tester) async {
    await _pump(tester, _data());
    await _open(tester);

    expect(find.byKey(const ValueKey('model-picker-tab-all')), findsOneWidget);
    final claude = tester.getTopLeft(find.text('Claude').last).dy;
    final openAi = tester.getTopLeft(find.text('OpenAI')).dy;
    final deepSeek = tester.getTopLeft(find.text('DeepSeek')).dy;
    expect(claude, lessThan(openAi));
    expect(openAi, lessThan(deepSeek));
    expect(
      tester.getTopLeft(_row('claude-opus')).dy,
      lessThan(tester.getTopLeft(_row('claude-sonnet')).dy),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('Legacy models stay collapsed until opened', (tester) async {
    await _pump(tester, _data());
    await _open(tester);

    Finder chevron(CanopyGlyph glyph) => find.descendant(
      of: find.ancestor(
        of: find.text('Legacy models'),
        matching: find.byType(InkWell),
      ),
      matching: find.byWidgetPredicate(
        (widget) =>
            widget is CanopyIcon && widget.glyph == glyph && widget.size == 20,
      ),
    );

    expect(find.text('Legacy models'), findsOneWidget);
    expect(_row('claude-legacy'), findsNothing);
    expect(chevron(CanopyGlyph.chevronDownMedium), findsOneWidget);
    await tester.tap(find.text('Legacy models'));
    await tester.pumpAndSettle();
    expect(_row('claude-legacy'), findsOneWidget);
    expect(chevron(CanopyGlyph.chevronTopMedium), findsOneWidget);
  });

  testWidgets('a harness tab lists its own vendors before other models', (
    tester,
  ) async {
    await _pump(tester, _data());
    await _open(tester);

    await tester.tap(find.byKey(const ValueKey('model-picker-tab-codex')));
    await tester.pumpAndSettle();
    expect(_row('claude-opus'), findsNothing);
    expect(find.text('Other supported models'), findsOneWidget);
    expect(
      tester.getTopLeft(_row('gpt-5-codex')).dy,
      lessThan(tester.getTopLeft(_row('deepseek-v3')).dy),
    );
  });

  testWidgets('search matches label, id and vendor and hides the tabs', (
    tester,
  ) async {
    await _pump(tester, _data());
    await _open(tester);

    await tester.enterText(find.byType(TextField), 'deepsk');
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('model-picker-tab-all')), findsNothing);
    expect(_row('deepseek-v3'), findsOneWidget);
    expect(_row('claude-opus'), findsNothing);

    await tester.enterText(find.byType(TextField), 'zzzz');
    await tester.pumpAndSettle();
    expect(find.text('No models match'), findsOneWidget);
  });

  testWidgets('compact rows mark the selection without a checkmark', (
    tester,
  ) async {
    await _pump(tester, _data());
    await _open(tester);

    expect(find.text('Most capable Claude model.'), findsNothing);
    final checkmarks = find.byWidgetPredicate(
      (widget) =>
          widget is CanopyIcon && widget.glyph == CanopyGlyph.checkmark1,
    );
    expect(checkmarks, findsNothing);
    expect(
      tester.getSemantics(_row('claude-opus')).flagsCollection.isSelected,
      Tristate.isTrue,
    );
    expect(
      find.descendant(
        of: _row('deepseek-v3'),
        matching: find.text('AI credits'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('long-press shows the desktop detail rows', (tester) async {
    await _pump(tester, _data());
    await _open(tester);

    await tester.longPress(_row('claude-opus'));
    await tester.pumpAndSettle();
    expect(find.text('Provider'), findsOneWidget);
    expect(find.text('Reasoning'), findsOneWidget);
    expect(find.text('Allows reasoning'), findsOneWidget);
    expect(find.text('Context'), findsOneWidget);
    expect(find.text('1M'), findsOneWidget);
    expect(find.text('Most capable Claude model.'), findsOneWidget);
  });

  testWidgets('a disabled row explains why when tapped', (tester) async {
    String? picked;
    await _pump(tester, _data(onSelect: (id) => picked = id));
    await _open(tester);

    final cursorTab = find.byKey(const ValueKey('model-picker-tab-cursor'));
    await tester.ensureVisible(cursorTab);
    await tester.pumpAndSettle();
    await tester.tap(cursorTab);
    await tester.pumpAndSettle();
    await tester.tap(_row('cursor-default'));
    await tester.pumpAndSettle();
    expect(picked, isNull);
    expect(
      find.text('Connect Cursor in the desktop app to use it here.'),
      findsWidgets,
    );
  });

  // CAN-2872: a guest sees the hosted models it cannot run yet, locked.
  testWidgets('a guest-locked hosted row explains sign-in and is not picked', (
    tester,
  ) async {
    String? picked;
    const luna = ModelOption(
      id: 'gpt-6-luna',
      label: 'GPT 6 Luna',
      provider: 'codex',
      source: 'ai-gateway',
      harness: 'codex',
      vendor: 'openai',
      kind: 'model',
      available: true,
    );
    const opus = ModelOption(
      id: 'claude-opus-5',
      label: 'Claude Opus 5',
      provider: 'claude',
      source: 'ai-gateway',
      harness: 'claude',
      vendor: 'anthropic',
      kind: 'model',
      available: false,
      unavailableReason: 'needs_sign_in',
    );
    await _pump(
      tester,
      _data(
        selectedModelId: 'gpt-6-luna',
        modelLabel: 'GPT 6 Luna',
        models: const [luna, opus],
        onSelect: (id) => picked = id,
      ),
    );
    await _open(tester);
    // The locked row names its remedy in place of the credits tag.
    expect(
      find.descendant(
        of: _row('claude-opus-5'),
        matching: find.text('Sign in'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: _row('gpt-6-luna'),
        matching: find.text('AI credits'),
      ),
      findsOneWidget,
    );

    await tester.tap(_row('claude-opus-5'));
    await tester.pumpAndSettle();
    expect(picked, isNull);
    expect(find.text('Unlock with sign-in'), findsWidgets);

    await tester.tap(_row('gpt-6-luna'));
    await tester.pumpAndSettle();
    expect(picked, 'gpt-6-luna');
    expect(tester.takeException(), isNull);
  });

  testWidgets('a retired selection reads Model no longer available', (
    tester,
  ) async {
    await _pump(
      tester,
      _data(selectedModelId: 'retired-model', modelLabel: 'Retired Model'),
    );
    expect(find.text('Model no longer available'), findsOneWidget);
  });

  testWidgets('an older host catalog still lists every row', (tester) async {
    final older = ModelOption.listFromJson(const [
      {'id': 'claude-sonnet', 'label': 'Claude Sonnet', 'provider': 'claude'},
      {'id': 'gpt-5-codex', 'label': 'GPT-5 Codex', 'provider': 'codex'},
    ]);
    String? picked;
    await _pump(
      tester,
      _data(
        models: older,
        selectedModelId: 'claude-sonnet',
        onSelect: (id) => picked = id,
      ),
    );
    await _open(tester);

    expect(find.byKey(const ValueKey('model-picker-tab-all')), findsOneWidget);
    expect(_row('claude-sonnet'), findsOneWidget);
    await tester.tap(_row('gpt-5-codex'));
    await tester.pumpAndSettle();
    expect(picked, 'gpt-5-codex');
  });

  testWidgets('the last tab is remembered; a lock only changes the opening '
      'tab', (tester) async {
    final store = InMemoryModelPickerTabStore();
    await _pump(tester, _data(), store: store);
    await _open(tester);
    await tester.tap(find.byKey(const ValueKey('model-picker-tab-codex')));
    await tester.pumpAndSettle();
    expect(await store.read(), 'codex');

    await tester.tapAt(const Offset(195, 20));
    await tester.pumpAndSettle();
    await _open(tester);
    expect(_row('gpt-5-codex'), findsOneWidget);
    expect(_row('claude-opus'), findsNothing);

    await _pump(tester, _data(lockedHarness: 'claude'), store: store);
    await tester.tapAt(const Offset(195, 20));
    await tester.pumpAndSettle();
    await _open(tester);
    expect(_row('claude-opus'), findsOneWidget);
    expect(_row('gpt-5-codex'), findsNothing);
    expect(await store.read(), 'codex');
  });

  testWidgets('a stale stored tab opens All models', (tester) async {
    await _pump(tester, _data(), store: InMemoryModelPickerTabStore('ollama'));
    await _open(tester);
    expect(_row('claude-opus'), findsOneWidget);
    expect(_row('gpt-5-codex'), findsOneWidget);
  });

  testWidgets('a loading hosted catalog shows placeholder rows', (
    tester,
  ) async {
    await _pump(
      tester,
      _data(models: const [], status: ModelCatalogStatus.loading),
    );
    await _open(tester);
    expect(find.byKey(const ValueKey('model-picker-loading')), findsOneWidget);
    expect(find.text('No models available yet.'), findsNothing);
  });

  testWidgets('a failed hosted catalog retries without closing the sheet', (
    tester,
  ) async {
    var retries = 0;
    await _pump(
      tester,
      _data(
        models: const [],
        status: ModelCatalogStatus.failed,
        onRetry: () => retries++,
      ),
    );
    await _open(tester);
    expect(find.text('Couldn’t load'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('model-picker-retry')));
    await tester.pumpAndSettle();
    expect(retries, 1);

    // The host's next projection reaches the open sheet.
    await _pump(tester, _data());
    await tester.pumpAndSettle();
    expect(_row('claude-opus'), findsOneWidget);
  });

  testWidgets('a catalog with only disabled rows keeps their reasons', (
    tester,
  ) async {
    await _pump(
      tester,
      _data(
        models: [_catalog.last],
        selectedModelId: null,
        availability: const ProviderAvailability(cursor: false),
      ),
    );
    await _open(tester);
    expect(find.text('No models available'), findsOneWidget);
    expect(find.textContaining('organization'), findsNothing);
    await tester.tap(_row('cursor-default'));
    await tester.pumpAndSettle();
    expect(
      find.text('Connect Cursor in the desktop app to use it here.'),
      findsWidgets,
    );
  });

  testWidgets('an empty catalog keeps reported connection tabs and their '
      'guidance', (tester) async {
    await _pump(
      tester,
      _data(
        models: const [],
        selectedModelId: null,
        availability: const ProviderAvailability(cursor: false),
      ),
    );
    await _open(tester);
    expect(find.text('No models available'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('model-picker-tab-cursor')));
    await tester.pumpAndSettle();
    expect(find.text('No models available'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('model-picker-connect-cursor')),
      findsOneWidget,
    );
    expect(find.textContaining('organization'), findsNothing);
  });

  testWidgets('a harness tab shows only its own Agents', (tester) async {
    final agents = ModelOption.listFromJson(const [
      {
        'id': 'claude-agent',
        'label': 'Claude Reviewer',
        'provider': 'claude',
        'source': 'claude',
        'kind': 'agent',
      },
      {
        'id': 'codex-agent',
        'label': 'Codex Builder',
        'provider': 'codex',
        'source': 'codex',
        'kind': 'agent',
      },
    ]);
    await _pump(tester, _data(models: [...agents, ..._catalog]));
    await _open(tester);
    expect(_row('claude-agent'), findsOneWidget);
    expect(_row('codex-agent'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('model-picker-tab-codex')));
    await tester.pumpAndSettle();
    expect(_row('codex-agent'), findsOneWidget);
    expect(_row('claude-agent'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('model-picker-tab-claude')));
    await tester.pumpAndSettle();
    expect(_row('claude-agent'), findsOneWidget);
    expect(_row('codex-agent'), findsNothing);
  });

  testWidgets('a row shows only its vendor icon, with no harness icon', (
    tester,
  ) async {
    final ollama = ModelOption.fromJson(const {
      'id': 'qwen',
      'label': 'Qwen 3',
      'provider': 'ollama',
      'source': 'ollama',
      'harness': 'codex',
    });
    Iterable<String> icons(String id) => tester
        .widgetList<CanopyModelIcon>(
          find.descendant(of: _row(id), matching: find.byType(CanopyModelIcon)),
        )
        .map((icon) => icon.vendor);

    await _pump(
      tester,
      _data(
        models: [ollama, ..._catalog],
        availability: const ProviderAvailability(
          claude: true,
          codex: true,
          ollama: true,
        ),
      ),
    );
    await _open(tester);
    expect(icons('claude-opus'), ['anthropic']);
    expect(icons('qwen'), ['ollama']);
    expect(icons('deepseek-v3'), ['deepseek']);

    await tester.tap(find.byKey(const ValueKey('model-picker-tab-codex')));
    await tester.pumpAndSettle();
    expect(icons('deepseek-v3'), ['deepseek']);
  });

  testWidgets('details name the harness that runs a borrowed native row', (
    tester,
  ) async {
    final ollama = ModelOption.fromJson(const {
      'id': 'qwen',
      'label': 'Qwen 3',
      'provider': 'ollama',
      'source': 'ollama',
      'harness': 'codex',
    });
    final claude = ModelOption.fromJson(const {
      'id': 'opus-native',
      'label': 'Opus Native',
      'provider': 'claude',
      'source': 'claude',
      'harness': 'claude',
    });
    Finder fact(String id, String text) => find.descendant(
      of: find.byKey(ValueKey('model-details-$id')),
      matching: find.text(text),
    );
    Future<void> showDetails(String id) async {
      await tester.longPress(_row(id));
      await tester.pumpAndSettle();
    }

    Future<void> closeDetails() async {
      await tester.tapAt(const Offset(195, 40));
      await tester.pumpAndSettle();
    }

    await _pump(tester, _data(models: [ollama, claude, ..._catalog]));
    await _open(tester);

    await showDetails('qwen');
    expect(fact('qwen', 'Harness'), findsOneWidget);
    expect(fact('qwen', 'Codex'), findsOneWidget);
    await closeDetails();

    await showDetails('opus-native');
    expect(fact('opus-native', 'Harness'), findsNothing);
    await closeDetails();

    await showDetails('deepseek-v3');
    expect(fact('deepseek-v3', 'Harness'), findsOneWidget);
    expect(fact('deepseek-v3', 'Codex'), findsOneWidget);
  });

  group('Auto', () {
    ModelAutoControl auto({bool selected = false, VoidCallback? onSelect}) =>
        ModelAutoControl(selected: selected, onSelect: onSelect ?? () {});

    testWidgets('is hidden when the host or the account cannot route', (
      tester,
    ) async {
      await _pump(
        tester,
        _data(),
        routing: _routing(ModelRoutingAvailability.available),
      );
      await _open(tester);
      expect(_autoRow, findsNothing);
      Navigator.of(tester.element(_row('claude-opus'))).pop();
      await tester.pumpAndSettle();

      await _pump(
        tester,
        _data(auto: auto()),
        routing: _routing(ModelRoutingAvailability.hidden),
      );
      await _open(tester);
      expect(_autoRow, findsNothing);
    });

    testWidgets('a chat already in Auto keeps its row when routing is hidden', (
      tester,
    ) async {
      await _pump(
        tester,
        _data(auto: auto(selected: true)),
        routing: _routing(ModelRoutingAvailability.hidden),
      );
      await _open(tester);
      expect(_autoRow, findsOneWidget);
      expect(find.text('Picks the best model for you'), findsOneWidget);
    });

    for (final (state, reason) in [
      (ModelRoutingAvailability.loading, 'Checking AI Credits…'),
      (ModelRoutingAvailability.noCredits, 'Add AI Credits to use this'),
    ]) {
      testWidgets('shows "$reason" and does not switch to Auto', (
        tester,
      ) async {
        var picked = false;
        final routing = state == ModelRoutingAvailability.loading
            ? ModelRoutingAvailabilityController(
                load: () => Completer<ModelRoutingAvailability>().future,
                accountScope: () => null,
              )
            : _routing(state);
        await _pump(
          tester,
          _data(auto: auto(onSelect: () => picked = true)),
          routing: routing,
        );
        await _open(tester);
        expect(find.text(reason), findsOneWidget);
        await tester.tap(_autoRow);
        await tester.pumpAndSettle();
        expect(picked, isFalse);
        expect(_autoRow, findsOneWidget, reason: 'the sheet stays open');
      });
    }

    testWidgets('needs two or more pickable models', (tester) async {
      await _pump(
        tester,
        _data(
          auto: auto(),
          // Only Claude rows can run; the lock disables the others.
          models: _catalog
              .where(
                (row) => !{'claude-sonnet', 'claude-legacy'}.contains(row.id),
              )
              .toList(),
          lockedHarness: 'claude',
        ),
        routing: _routing(ModelRoutingAvailability.available),
      );
      await _open(tester);
      expect(find.text('Needs two or more models'), findsOneWidget);
    });

    testWidgets('picking Auto selects the mode and never a model id', (
      tester,
    ) async {
      var auto0 = 0;
      final models = <String>[];
      await _pump(
        tester,
        _data(
          auto: auto(onSelect: () => auto0++),
          onSelect: models.add,
        ),
        routing: _routing(ModelRoutingAvailability.available),
      );
      await _open(tester);
      expect(find.text('Picks the best model for you'), findsOneWidget);
      await tester.tap(_autoRow);
      await tester.pumpAndSettle();
      expect(auto0, 1);
      expect(models, isEmpty);
      expect(_autoRow, findsNothing, reason: 'the sheet closed');
    });

    testWidgets('in Auto the chip reads Auto and no model row is selected', (
      tester,
    ) async {
      await _pump(
        tester,
        _data(auto: auto(selected: true), selectedModelId: 'retired-model'),
        routing: _routing(ModelRoutingAvailability.available),
      );
      expect(find.text('Auto'), findsOneWidget);
      expect(find.text('Model no longer available'), findsNothing);
      await _open(tester);
      expect(
        tester.getSemantics(_autoRow).flagsCollection.isSelected,
        Tristate.isTrue,
      );
      expect(
        tester.getSemantics(_row('claude-opus')).flagsCollection.isSelected,
        isNot(Tristate.isTrue),
      );
    });

    testWidgets('hides while searching', (tester) async {
      await _pump(
        tester,
        _data(auto: auto()),
        routing: _routing(ModelRoutingAvailability.available),
      );
      await _open(tester);
      expect(_autoRow, findsOneWidget);
      await tester.enterText(
        find.byKey(const ValueKey('model-picker-search')),
        'opus',
      );
      await tester.pumpAndSettle();
      expect(_autoRow, findsNothing);
    });
  });

  testWidgets('the sheet top stays in place when the keyboard closes', (
    tester,
  ) async {
    await _pump(tester, _data());
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    await _open(tester);
    final search = find.byKey(const ValueKey('model-picker-search'));
    final top = tester.getTopLeft(search).dy;
    expect(tester.getBottomLeft(search).dy, lessThan(844 - 300));

    tester.view.viewInsets = FakeViewPadding.zero;
    await tester.pump();
    expect(tester.getTopLeft(search).dy, top);
    expect(tester.takeException(), isNull);
  });

  for (final (name, theme) in [
    ('light', AppTheme.light),
    ('dark', AppTheme.dark),
  ]) {
    testWidgets('the sheet fits a phone at 2x text in $name', (tester) async {
      await _pump(
        tester,
        _data(auto: ModelAutoControl(selected: false, onSelect: () {})),
        theme: theme,
        textScale: 2,
        routing: _routing(ModelRoutingAvailability.noCredits),
      );
      await _open(tester);
      expect(
        find.byKey(const ValueKey('model-picker-tab-all')),
        findsOneWidget,
      );
      expect(find.text('Add AI Credits to use this'), findsOneWidget);
      expect(tester.takeException(), isNull);

      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });
  }

  for (final inset in [250.0, 300.0]) {
    for (final textScale in [1.0, 2.0]) {
      testWidgets(
        'a ${inset.toInt()} px landscape keyboard at ${textScale}x text keeps '
        'search and rows reachable',
        (tester) async {
          await _pump(
            tester,
            _data(auto: ModelAutoControl(selected: false, onSelect: () {})),
            size: const Size(844, 390),
            textScale: textScale,
            routing: _routing(ModelRoutingAvailability.available),
          );
          await _open(tester);
          tester.view.viewInsets = FakeViewPadding(bottom: inset);
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);

          final search = find.byKey(const ValueKey('model-picker-search'));
          expect(tester.getTopLeft(search).dy, lessThan(390 - inset));
          await tester.enterText(search, 'opus');
          await tester.pumpAndSettle();
          await tester.ensureVisible(_row('claude-opus'));
          await tester.pumpAndSettle();
          expect(
            tester.getTopLeft(_row('claude-opus')).dy,
            lessThan(390 - inset),
          );
          expect(tester.takeException(), isNull);
        },
      );
    }
  }
}
