import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/button/canopy_mini_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/search-field/canopy_search_field.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_dispatch.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart'
    show RemoteControlException, RemotePipelineDispatchQueuedException;
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_dispatch_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_picker_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_run_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/activity_sidebar.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';
import 'package:provider/provider.dart';

import '../../../support/fake_remote_control_repository.dart';

Map<String, dynamic> pipelineRow(
  String id,
  String name, {
  List<String> triggers = const ['dispatch'],
  String origin = 'project',
  String? description,
}) => {
  'pipelineId': id,
  'name': name,
  'origin': origin,
  'triggerTypes': triggers,
  'worktreeLocalId': 'wt-1',
  'description': ?description,
};

FakeRemoteControlRepository dispatchRepository({
  List<Map<String, dynamic>> pipelines = const [],
  bool capable = true,
}) {
  final repository = FakeRemoteControlRepository()
    ..supportsPipelineDispatch = capable
    ..snapshotBuilder = () => RemoteSessionSnapshot(
      workspaces: const [],
      worktrees: const [
        RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'main',
        ),
      ],
      standaloneChats: const [],
      chatSummaries: const [
        RemoteChatSummary(
          chatId: 'chat-1',
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Chat A',
          active: true,
        ),
      ],
      chatMessages: const [],
    );
  repository.worktreeStateSlices = {
    'wt-1': {'pipelines': pipelines},
  };
  return repository;
}

void usePhoneViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

Future<RemoteControlViewModel> connect(
  WidgetTester tester,
  FakeRemoteControlRepository repository,
) async {
  final vm = RemoteControlViewModel(
    repository: repository,
    stateRefreshDebounce: Duration.zero,
  );
  await tester.runAsync(() => vm.connect('123456'));
  return vm;
}

Widget chatHost(RemoteControlViewModel vm, {ThemeData? theme}) => MultiProvider(
  providers: [
    ChangeNotifierProvider<RemoteControlViewModel>(create: (_) => vm),
    ChangeNotifierProvider<TurnFeedbackController>(
      create: (_) =>
          TurnFeedbackController(repository: MockTurnFeedbackRepository()),
    ),
  ],
  child: MaterialApp(
    theme: theme ?? AppTheme.light,
    navigatorObservers: [appRouteObserver],
    home: RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
  ),
);

Future<void> openPicker(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('open-activity')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-open')));
  await tester.pumpAndSettle();
}

/// Eight dispatchable rows, so the picker shows its search field; only
/// "Deploy" mentions staging.
List<Map<String, dynamic>> searchablePipelines() => [
  for (var i = 0; i < 7; i++) pipelineRow('p$i', 'Pipeline $i'),
  pipelineRow('deploy', 'Deploy', description: 'Ships to staging'),
];

const pickerSearch = ValueKey('pipeline-picker-search');

Finder glyphIn(Finder parent, CanopyGlyph glyph) => find.descendant(
  of: parent,
  matching: find.byWidgetPredicate(
    (widget) => widget is CanopyIcon && widget.glyph == glyph,
  ),
);

/// The decoration the field actually renders, after theme defaults.
InputDecoration renderedDecoration(WidgetTester tester, Finder field) => tester
    .widget<InputDecorator>(
      find.descendant(of: field, matching: find.byType(InputDecorator)),
    )
    .decoration;

/// Whether each state the decorator can paint resolves to no line at all.
bool isBorderless(InputDecoration decoration) => [
  decoration.enabledBorder ?? decoration.border,
  decoration.focusedBorder ?? decoration.border,
].every((border) => border?.borderSide == BorderSide.none);

Color? paintedTextColor(WidgetTester tester, Finder text) => tester
    .renderObject<RenderParagraph>(
      find.descendant(
        of: text,
        matching: find.byType(RichText),
        matchRoot: true,
      ),
    )
    .text
    .style
    ?.color;

Widget formHost(
  RemoteControlViewModel vm, {
  String id = 'deploy',
  ThemeData? theme,
}) => ChangeNotifierProvider<RemoteControlViewModel>.value(
  value: vm,
  child: MaterialApp(
    theme: theme ?? AppTheme.light,
    home: RemotePipelineDispatchScreen(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      pipeline: RemotePipelineDescriptor(
        pipelineId: id,
        name: 'Deploy',
        description: 'Ships the branch',
      ),
    ),
  ),
);

Widget pickerHost(RemoteControlViewModel vm) =>
    ChangeNotifierProvider<RemoteControlViewModel>.value(
      value: vm,
      child: MaterialApp(
        theme: AppTheme.light,
        home: const RemotePipelinePickerScreen(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ),
      ),
    );

const deployInputs = {
  'dispatchInputs': {
    'environment': {
      'type': 'choice',
      'required': true,
      'options': ['staging', 'production'],
      'description': 'Where to deploy',
    },
    'count': {'type': 'number', 'min': 1, 'max': 5},
    'dry_run': {'type': 'boolean', 'default': true},
    'note': {'type': 'string', 'description': 'Release note'},
    'token': {'type': 'string', 'hint-hide-ui-option': true, 'default': 'x'},
    'secret': {'type': 'string', 'required': true, 'hint-hide-ui-option': true},
  },
};

/// Tears the tree and engine down so an in-flight dispatch's watchdog timer
/// does not outlive the test.
Future<void> unmountAndDispose(
  WidgetTester tester,
  RemoteControlViewModel vm,
) async {
  await tester.pumpWidget(const SizedBox());
  vm.dispose();
}

void main() {
  testWidgets('an older desktop gets no Run action', (tester) async {
    usePhoneViewport(tester);
    final vm = await connect(tester, dispatchRepository(capable: false));
    await tester.pumpWidget(chatHost(vm));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('open-activity')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('pipeline-dispatch-open')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Run opens the picker with only dispatchable pipelines', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final vm = await connect(
      tester,
      dispatchRepository(
        pipelines: [
          pipelineRow('deploy', 'Deploy', description: 'Ships it'),
          pipelineRow('review', 'Review', origin: 'bundled'),
          pipelineRow('plan', 'Plan', triggers: ['plan_ready']),
        ],
      ),
    );
    await tester.pumpWidget(chatHost(vm));
    await tester.pumpAndSettle();
    await openPicker(tester);

    expect(find.byType(RemotePipelinePickerScreen), findsOneWidget);
    expect(
      find.byKey(const ValueKey('pipeline-picker-row:deploy')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('pipeline-picker-row:review')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('pipeline-picker-row:plan')),
      findsNothing,
    );
    expect(find.text('Ships it'), findsOneWidget);
    expect(find.text('Bundled'), findsOneWidget);
    // Search only appears for long lists.
    expect(find.byKey(const ValueKey('pipeline-picker-search')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an empty worktree says so', (tester) async {
    usePhoneViewport(tester);
    final vm = await connect(tester, dispatchRepository());
    await tester.pumpWidget(chatHost(vm));
    await tester.pumpAndSettle();
    await openPicker(tester);

    expect(find.byKey(const ValueKey('pipeline-picker-empty')), findsOneWidget);
    expect(
      find.text('No pipelines can be run in this worktree.'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('search filters by name and description at 8+ pipelines', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final vm = await connect(
      tester,
      dispatchRepository(
        pipelines: [
          for (var i = 0; i < 7; i++) pipelineRow('p$i', 'Pipeline $i'),
          pipelineRow('deploy', 'Deploy', description: 'Ships to staging'),
        ],
      ),
    );
    await tester.pumpWidget(chatHost(vm));
    await tester.pumpAndSettle();
    await openPicker(tester);

    await tester.enterText(
      find.byKey(const ValueKey('pipeline-picker-search')),
      'staging',
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('pipeline-picker-row:deploy')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('pipeline-picker-row:p0')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  for (final dark in [false, true]) {
    final appearance = dark ? 'dark' : 'light';

    testWidgets('the picker search magnifier is a secondary 20px glyph '
        '($appearance)', (tester) async {
      usePhoneViewport(tester);
      final vm = await connect(
        tester,
        dispatchRepository(pipelines: searchablePipelines()),
      );
      await tester.pumpWidget(
        chatHost(vm, theme: dark ? AppTheme.dark : AppTheme.light),
      );
      await tester.pumpAndSettle();
      await openPicker(tester);

      final field = find.byKey(pickerSearch);
      final colors = AppColors.of(tester.element(field));
      final magnifier = glyphIn(field, CanopyGlyph.magnifyingGlass);
      expect(magnifier, findsOneWidget);
      expect(
        tester.widget<CanopyIcon>(magnifier).tint,
        colors.foregroundSecondary,
      );
      expect(tester.getSize(magnifier), const Size.square(20));
      expect(
        paintedTextColor(tester, find.text('Search pipelines')),
        colors.foregroundSecondary,
      );
      expect(isBorderless(renderedDecoration(tester, field)), isTrue);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the Run glyph and label share the accent ($appearance)', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final vm = await connect(tester, dispatchRepository());
      await tester.pumpWidget(
        chatHost(vm, theme: dark ? AppTheme.dark : AppTheme.light),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pumpAndSettle();

      final run = find.byKey(const ValueKey('pipeline-dispatch-open'));
      expect(
        tester.widget(run),
        isA<CanopyMiniButton>()
            .having((b) => b.glyph, 'glyph', CanopyGlyph.play)
            .having((b) => b.label, 'label', 'Run'),
      );
      final accent = AppColors.of(tester.element(run)).accent;
      expect(
        tester.widget<CanopyIcon>(glyphIn(run, CanopyGlyph.play)).tint,
        accent,
      );
      expect(
        paintedTextColor(
          tester,
          find.descendant(of: run, matching: find.text('Run')),
        ),
        accent,
      );
      final label = find.descendant(of: run, matching: find.text('Run'));
      final style = tester
          .widget<RichText>(
            find.descendant(of: label, matching: find.byType(RichText)),
          )
          .text
          .style!;
      expect(style.fontSize, AppTypography.compactLabel.fontSize);
      expect(style.fontFamily, AppTypography.sansFamily);
      expect(style.fontVariations, AppTypography.emphasisVariations);
      final size = tester.getSize(run);
      expect(size.width, greaterThanOrEqualTo(44));
      expect(size.height, greaterThanOrEqualTo(44));
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('clearing the picker search restores every pipeline', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final vm = await connect(
      tester,
      dispatchRepository(pipelines: searchablePipelines()),
    );
    await tester.pumpWidget(chatHost(vm));
    await tester.pumpAndSettle();
    await openPicker(tester);

    final field = find.byKey(pickerSearch);
    expect(tester.widget(field), isA<CanopySearchField>());
    final clear = find.descendant(of: field, matching: find.byTooltip('Clear'));
    expect(clear, findsNothing);

    await tester.enterText(field, 'staging');
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('pipeline-picker-row:p0')), findsNothing);
    expect(clear, findsOneWidget);
    final target = tester.getSize(clear);
    expect(target.width, greaterThanOrEqualTo(48));
    expect(target.height, greaterThanOrEqualTo(48));

    await tester.tap(clear);
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<EditableText>(
            find.descendant(of: field, matching: find.byType(EditableText)),
          )
          .controller
          .text,
      isEmpty,
    );
    for (final id in ['p0', 'p6', 'deploy']) {
      expect(
        find.byKey(ValueKey('pipeline-picker-row:$id')),
        findsOneWidget,
        reason: id,
      );
    }
    expect(clear, findsNothing);
    expect(tester.takeException(), isNull);
  });

  // The chat screen around the drawer has its own large-text limits, so the
  // changed surfaces are pumped directly.
  for (final scale in [1.0, 2.0, 3.0, 3.2]) {
    testWidgets('Run and the picker search fit 390px at ${scale}x text', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      final vm = await connect(
        tester,
        dispatchRepository(pipelines: searchablePipelines()),
      );
      await tester.pumpWidget(
        ChangeNotifierProvider<RemoteControlViewModel>.value(
          value: vm,
          child: MaterialApp(
            theme: AppTheme.light,
            home: Scaffold(
              body: RemoteActivitySidebar(
                worktree: vm.worktreesFor('ws-1').single,
                activity: const RemoteWorktreeActivity(),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final run = find.byKey(const ValueKey('pipeline-dispatch-open'));
      await tester.scrollUntilVisible(
        run,
        200,
        // The vertical list holding the activity cards.
        scrollable: find
            .byWidgetPredicate(
              (widget) =>
                  widget is Scrollable &&
                  widget.axisDirection == AxisDirection.down,
            )
            .first,
      );
      final target = tester.getSize(run);
      expect(target.width, greaterThanOrEqualTo(44));
      expect(target.height, greaterThanOrEqualTo(44));
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(pickerHost(vm));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(pickerSearch), 'staging');
      await tester.pumpAndSettle();
      expect(find.byTooltip('Clear'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('the Run action is announced as an activatable button', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final vm = await connect(tester, dispatchRepository());
    await tester.pumpWidget(chatHost(vm));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('open-activity')));
    await tester.pumpAndSettle();

    final handle = tester.ensureSemantics();
    final semantics = tester.getSemantics(
      find.byKey(const ValueKey('pipeline-dispatch-open')),
    );
    expect(semantics.label, contains('Run a pipeline'));
    expect(
      semantics,
      matchesSemantics(
        label: 'Run a pipeline',
        isButton: true,
        isEnabled: true,
        isFocusable: true,
        hasEnabledState: true,
        hasTapAction: true,
        hasFocusAction: true,
      ),
    );
    handle.dispose();
  });

  testWidgets('tapping a row opens the dispatch screen for that pipeline', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final vm = await connect(
      tester,
      dispatchRepository(pipelines: [pipelineRow('deploy', 'Deploy')]),
    );
    await tester.pumpWidget(chatHost(vm));
    await tester.pumpAndSettle();
    await openPicker(tester);

    await tester.tap(find.byKey(const ValueKey('pipeline-picker-row:deploy')));
    await tester.pumpAndSettle();

    final screen = tester.widget<RemotePipelineDispatchScreen>(
      find.byType(RemotePipelineDispatchScreen),
    );
    expect(screen.pipeline.pipelineId, 'deploy');
    expect(screen.workspaceLocalId, 'ws-1');
    expect(screen.worktreeLocalId, 'wt-1');
    expect(tester.takeException(), isNull);
  });

  testWidgets('the picker re-reads the worktree pipelines when it opens', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository();
    final vm = await connect(tester, repository);
    await tester.pumpWidget(chatHost(vm));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('open-activity')));
    await tester.pumpAndSettle();

    // A pipeline appears on the desktop after the phone last read the slice.
    repository.worktreeStateSlices = {
      'wt-1': {
        'pipelines': [pipelineRow('fresh', 'Fresh')],
      },
    };
    final callsBefore = repository.fetchWorktreeStateSlicesCalls;
    await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-open')));
    await tester.pumpAndSettle();

    expect(repository.fetchWorktreeStateSlicesCalls, greaterThan(callsBefore));
    expect(
      find.byKey(const ValueKey('pipeline-picker-row:fresh')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('renders every visible input type and hides hinted optionals', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository()..pipelineFormResult = deployInputs;
    final vm = await connect(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();

    expect(repository.pipelineFormRequests.single.pipelineId, 'deploy');
    for (final name in ['environment', 'count', 'dry_run', 'note', 'secret']) {
      expect(
        find.byKey(ValueKey('pipeline-dispatch-field:$name')),
        findsOneWidget,
        reason: name,
      );
    }
    expect(
      find.byKey(const ValueKey('pipeline-dispatch-field:token')),
      findsNothing,
    );
    expect(find.text('environment *'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets("a string field's description shows without focus", (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository()..pipelineFormResult = deployInputs;
    final vm = await connect(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();

    // Nothing was tapped, so the field is unfocused and still shows it.
    final editable = tester.widget<EditableText>(
      find.descendant(
        of: find.byKey(const ValueKey('pipeline-dispatch-field:note')),
        matching: find.byType(EditableText),
      ),
    );
    expect(editable.focusNode.hasFocus, isFalse);
    expect(editable.controller.text, isEmpty);
    expect(find.text('Release note'), findsOneWidget);
    // A hint is hidden while the empty field is unfocused; helper text is
    // always shown, like the choice and number fields.
    final decoration = tester
        .widget<TextField>(
          find.descendant(
            of: find.byKey(const ValueKey('pipeline-dispatch-field:note')),
            matching: find.byType(TextField),
          ),
        )
        .decoration;
    expect(decoration?.helperText, 'Release note');
    expect(decoration?.hintText, isNull);
    expect(tester.takeException(), isNull);
  });

  for (final dark in [false, true]) {
    testWidgets(
      'pipeline text inputs use the shared filled field (${dark ? 'dark' : 'light'})',
      (tester) async {
        usePhoneViewport(tester);
        final repository = dispatchRepository()
          ..pipelineFormResult = {
            'dispatchInputs': {
              'base_branch': {
                'type': 'string',
                'description':
                    'Base branch used to compute the workspace merge-base.',
                'default': 'develop',
              },
            },
          };
        final vm = await connect(tester, repository);
        addTearDown(vm.dispose);
        await tester.pumpWidget(
          formHost(vm, theme: dark ? AppTheme.dark : AppTheme.light),
        );
        await tester.pumpAndSettle();
        final field = find.byKey(
          const ValueKey('pipeline-dispatch-field:base_branch'),
        );
        final colors = AppColors.of(tester.element(field));
        final decoration = renderedDecoration(tester, field);
        expect(decoration.filled, isTrue);
        expect(decoration.fillColor, colors.surfaceRaised);
        expect(isBorderless(decoration), isTrue);
        expect(
          find.text('Base branch used to compute the workspace merge-base.'),
          findsOneWidget,
        );
        await tester.enterText(field, 'main');
        await tester.pump();
        expect(
          tester
              .widget<EditableText>(
                find.descendant(of: field, matching: find.byType(EditableText)),
              )
              .controller
              .text,
          'main',
        );
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('the picker shows the degraded banner while the desktop lags', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository(
      pipelines: [pipelineRow('deploy', 'Deploy')],
    )..connectedStatus = RemotePortalConnectionStatus.reconnecting;
    final vm = await connect(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(pickerHost(vm));
    await tester.pumpAndSettle();

    expect(find.byType(RemoteDegradedBanner), findsOneWidget);
    expect(find.text('Desktop is reconnecting…'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('pipeline-picker-row:deploy')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('the picker shows no banner while the desktop is live', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository(
      pipelines: [pipelineRow('deploy', 'Deploy')],
    )..connectedStatus = RemotePortalConnectionStatus.active;
    final vm = await connect(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(pickerHost(vm));
    await tester.pumpAndSettle();

    expect(find.byType(RemoteDegradedBanner), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the form shows the banner and disables Run while degraded', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository()
      ..pipelineFormResult = {'dispatchInputs': <String, dynamic>{}}
      ..connectedStatus = RemotePortalConnectionStatus.inactive;
    final vm = await connect(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();

    expect(find.byType(RemoteDegradedBanner), findsOneWidget);
    expect(
      find.text("Your desktop is reconnecting. Run when it's back."),
      findsOneWidget,
    );
    final run = find.byKey(const ValueKey('pipeline-dispatch-run'));
    expect(run, findsOneWidget);
    await tester.tap(run, warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(repository.pipelineDispatches, isEmpty);
    expect(tester.widget<CanopyButton>(run).onPressed, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Run comes back when the desktop does', (tester) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository()
      ..pipelineFormResult = {'dispatchInputs': <String, dynamic>{}}
      ..connectedStatus = RemotePortalConnectionStatus.reconnecting;
    final vm = await connect(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<CanopyButton>(
            find.byKey(const ValueKey('pipeline-dispatch-run')),
          )
          .onPressed,
      isNull,
    );

    repository.eventsController.add(
      const RemotePortalEventBatch(
        events: [],
        nextCursor: 1,
        connectionStatus: RemotePortalConnectionStatus.active,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(RemoteDegradedBanner), findsNothing);
    expect(find.textContaining('Run when it'), findsNothing);
    expect(
      tester
          .widget<CanopyButton>(
            find.byKey(const ValueKey('pipeline-dispatch-run')),
          )
          .onPressed,
      isNotNull,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('Run validates before sending and keeps values', (tester) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository()..pipelineFormResult = deployInputs;
    final vm = await connect(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('pipeline-dispatch-field:count')),
      '9',
    );
    await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-run')));
    await tester.pumpAndSettle();

    expect(repository.pipelineDispatches, isEmpty);
    expect(find.text('This field is required'), findsNWidgets(2));
    expect(find.text('Must be at most 5'), findsOneWidget);
    expect(find.text('9'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a choice is picked from a sheet with a checkmark', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository()
      ..pipelineFormResult = {
        'dispatchInputs': {
          'environment': {
            'type': 'choice',
            'required': true,
            'options': ['staging', 'production'],
          },
        },
      };
    final vm = await connect(tester, repository);
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();

    await tester.tap(
      find.byKey(const ValueKey('pipeline-dispatch-field:environment')),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(
        const ValueKey('pipeline-dispatch-choice:environment:staging'),
      ),
    );
    await tester.pumpAndSettle();

    // Reopening marks the chosen option with a checkmark, and only that one.
    final handle = tester.ensureSemantics();
    expect(
      tester
          .getSemantics(
            find.byKey(const ValueKey('pipeline-dispatch-field:environment')),
          )
          .getSemanticsData()
          .hasAction(SemanticsAction.tap),
      isTrue,
    );
    handle.dispose();
    await tester.tap(
      find.byKey(const ValueKey('pipeline-dispatch-field:environment')),
    );
    await tester.pumpAndSettle();
    final checkmark = find.byWidgetPredicate(
      (widget) =>
          widget is CanopyIcon && widget.glyph == CanopyGlyph.checkmark1,
    );
    expect(checkmark, findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(
          const ValueKey('pipeline-dispatch-choice:environment:staging'),
        ),
        matching: checkmark,
      ),
      findsOneWidget,
    );
    await tester.tap(
      find.byKey(
        const ValueKey('pipeline-dispatch-choice:environment:staging'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-run')));
    await tester.pump();

    expect(repository.pipelineDispatches.single.inputs, {
      'environment': 'staging',
    });
    // Tear the tree and engine down so the in-flight dispatch's watchdog
    // does not outlive the test.
    await tester.pumpWidget(const SizedBox());
    vm.dispose();
    expect(tester.takeException(), isNull);
  });

  testWidgets('a pipeline with no visible inputs shows only Run', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository()
      ..pipelineFormResult = {'dispatchInputs': <String, dynamic>{}};
    final vm = await connect(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();

    expect(find.text('Ships the branch'), findsOneWidget);
    expect(find.byKey(const ValueKey('pipeline-dispatch-run')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('omitted and unsupported forms explain and offer no Run', (
    tester,
  ) async {
    usePhoneViewport(tester);
    for (final (result, copy) in [
      (
        {'dispatchInputsOmitted': true},
        'This pipeline has too many inputs to show here. Run it from the '
            'desktop app.',
      ),
      (
        {'dispatchUnsupportedReason': 'json_input'},
        "This pipeline needs input the phone can't provide. Run it from the "
            'desktop app.',
      ),
    ]) {
      final repository = dispatchRepository()..pipelineFormResult = result;
      final vm = await connect(tester, repository);
      await tester.pumpWidget(formHost(vm));
      await tester.pumpAndSettle();

      expect(find.text(copy), findsOneWidget);
      expect(find.byKey(const ValueKey('pipeline-dispatch-run')), findsNothing);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('a load failure offers Try again', (tester) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository()
      ..pipelineFormError = const RemoteControlException('Pipeline not found.');
    final vm = await connect(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();

    expect(find.text('Pipeline not found.'), findsOneWidget);
    repository.pipelineFormError = null;
    await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-retry')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('pipeline-dispatch-run')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('reopening a pipeline drops its earlier rejection', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository()
      ..pipelineFormResult = {'dispatchInputs': <String, dynamic>{}}
      ..pipelineDispatchError = const RemoteControlException(
        'Pipeline is split-locked.',
      );
    final vm = await connect(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-run')));
    await tester.pumpAndSettle();
    expect(find.text('Pipeline is split-locked.'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();

    expect(find.text('Pipeline is split-locked.'), findsNothing);
    expect(find.byKey(const ValueKey('pipeline-dispatch-error')), findsNothing);
    expect(find.byKey(const ValueKey('pipeline-dispatch-run')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('back is blocked while a start is in flight', (tester) async {
    usePhoneViewport(tester);
    final gate = Completer<String>();
    final repository = dispatchRepository()
      ..pipelineFormResult = {'dispatchInputs': <String, dynamic>{}}
      ..pipelineDispatchGate = gate;
    final vm = await connect(tester, repository);
    await tester.pumpWidget(
      ChangeNotifierProvider<RemoteControlViewModel>.value(
        value: vm,
        child: MaterialApp(
          theme: AppTheme.light,
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                key: const ValueKey('open-form'),
                onPressed: () => unawaited(
                  Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => const RemotePipelineDispatchScreen(
                        workspaceLocalId: 'ws-1',
                        worktreeLocalId: 'wt-1',
                        pipeline: RemotePipelineDescriptor(
                          pipelineId: 'deploy',
                          name: 'Deploy',
                        ),
                      ),
                    ),
                  ),
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('open-form')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-run')));
    await tester.pump();
    expect(repository.pipelineDispatches, hasLength(1));

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();

    expect(find.byType(RemotePipelineDispatchScreen), findsOneWidget);
    expect(find.byKey(const ValueKey('open-form')), findsNothing);
    await unmountAndDispose(tester, vm);
    gate.complete('pipeline-run-1');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'a queued start allows leaving and keeps Run disabled on return',
    (tester) async {
      usePhoneViewport(tester);
      final repository = dispatchRepository()
        ..pipelineFormResult = {'dispatchInputs': <String, dynamic>{}}
        ..pipelineDispatchError = const RemotePipelineDispatchQueuedException(
          'queued-1',
        );
      final vm = await connect(tester, repository);
      await tester.pumpWidget(
        ChangeNotifierProvider<RemoteControlViewModel>.value(
          value: vm,
          child: MaterialApp(
            theme: AppTheme.light,
            home: Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  key: const ValueKey('open-form'),
                  onPressed: () => unawaited(
                    Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const RemotePipelineDispatchScreen(
                          workspaceLocalId: 'ws-1',
                          worktreeLocalId: 'wt-1',
                          pipeline: RemotePipelineDescriptor(
                            pipelineId: 'deploy',
                            name: 'Deploy',
                          ),
                        ),
                      ),
                    ),
                  ),
                  child: const Text('Open'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(const ValueKey('open-form')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-run')));
      await tester.pump();
      expect(repository.pipelineDispatches, hasLength(1));
      expect(tester.widget<PopScope>(find.byType(PopScope)).canPop, isTrue);

      expect(await tester.binding.handlePopRoute(), isTrue);
      await tester.pumpAndSettle();
      expect(find.byType(RemotePipelineDispatchScreen), findsNothing);

      await tester.tap(find.byKey(const ValueKey('open-form')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      final run = find.byKey(const ValueKey('pipeline-dispatch-run'));
      expect(tester.widget<CanopyButton>(run).onPressed, isNull);
      expect(repository.pipelineDispatches, hasLength(1));
      await unmountAndDispose(tester, vm);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('an optional boolean is a switch that changes the payload', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository()
      ..pipelineFormResult = {
        'dispatchInputs': {
          'dry_run': {'type': 'boolean', 'default': true},
        },
      };
    final vm = await connect(tester, repository);
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();

    expect(
      find.descendant(
        of: find.byKey(const ValueKey('pipeline-dispatch-field:dry_run')),
        matching: find.byType(Switch),
      ),
      findsOneWidget,
    );
    await tester.tap(
      find.byKey(const ValueKey('pipeline-dispatch-field:dry_run')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-run')));
    await tester.pump();

    expect(repository.pipelineDispatches.single.inputs, {'dry_run': 'false'});
    await unmountAndDispose(tester, vm);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a required boolean without a default is picked, not toggled', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository()
      ..pipelineFormResult = {
        'dispatchInputs': {
          'confirm': {'type': 'boolean', 'required': true},
        },
      };
    final vm = await connect(tester, repository);
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();

    expect(find.byType(Switch), findsNothing);
    expect(find.text('Select…'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey('pipeline-dispatch-field:confirm')),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('pipeline-dispatch-choice:confirm:true')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-run')));
    await tester.pump();

    expect(repository.pipelineDispatches.single.inputs, {'confirm': 'true'});
    await unmountAndDispose(tester, vm);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a field error clears when that field is edited', (tester) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository()..pipelineFormResult = deployInputs;
    final vm = await connect(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('pipeline-dispatch-field:count')),
      '9',
    );
    await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-run')));
    await tester.pumpAndSettle();
    expect(find.text('Must be at most 5'), findsOneWidget);

    await tester.enterText(
      find.byKey(const ValueKey('pipeline-dispatch-field:count')),
      '3',
    );
    await tester.pumpAndSettle();

    expect(find.text('Must be at most 5'), findsNothing);
    // Other fields keep their own errors until edited.
    expect(find.text('This field is required'), findsNWidgets(2));
    expect(tester.takeException(), isNull);
  });

  var cursor = 0;

  void completeCommand(
    FakeRemoteControlRepository repository,
    String id, [
    Map<String, dynamic> result = const {},
  ]) => repository.eventsController.add(
    RemotePortalEventBatch.fromJson({
      'events': [
        {
          'type': 'portal.command.completed',
          'payload': {'commandId': id, 'result': result},
        },
      ],
      'nextCursor': ++cursor,
    }),
  );

  void failCommand(
    FakeRemoteControlRepository repository,
    String id,
    String message,
  ) => repository.eventsController.add(
    RemotePortalEventBatch.fromJson({
      'events': [
        {
          'type': 'portal.command.failed',
          'payload': {
            'commandId': id,
            'error': {'code': 'execution_failed', 'message': message},
          },
        },
      ],
      'nextCursor': ++cursor,
    }),
  );

  setUp(() => cursor = 0);

  testWidgets('pending blocks duplicates, then success opens the run and Back '
      'returns to the chat', (tester) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository(
      pipelines: [pipelineRow('deploy', 'Deploy')],
    )..pipelineFormResult = {'dispatchInputs': <String, dynamic>{}};
    final gate = Completer<String>();
    repository.pipelineDispatchGate = gate;
    final vm = await connect(tester, repository);
    await tester.pumpWidget(chatHost(vm));
    await tester.pumpAndSettle();
    await openPicker(tester);
    await tester.tap(find.byKey(const ValueKey('pipeline-picker-row:deploy')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-run')));
    await tester.pump();
    expect(find.text('Starting…'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey('pipeline-dispatch-run')),
      warnIfMissed: false,
    );
    await tester.pump();
    expect(repository.pipelineDispatches, hasLength(1));

    gate.complete('pipeline-run-1');
    await tester.pump();
    completeCommand(repository, 'pipeline-run-1', {'executionId': 'exec-7'});
    await tester.pumpAndSettle();

    expect(find.byType(RemotePipelineRunScreen), findsOneWidget);
    expect(repository.pipelineExecutionRequests.single.executionId, 'exec-7');

    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byType(RemotePipelineRunScreen), findsNothing);
    expect(find.byType(RemotePipelinePickerScreen), findsNothing);
    expect(find.byType(RemoteChatScreen), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a desktop rejection keeps the form and its values', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository()
      ..pipelineFormResult = {
        'dispatchInputs': {
          'note': {'type': 'string'},
        },
      };
    final vm = await connect(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('pipeline-dispatch-field:note')),
      'ship it',
    );
    await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-run')));
    await tester.pump();
    failCommand(repository, 'pipeline-run-1', 'Pipeline is split-locked.');
    await tester.pumpAndSettle();

    expect(find.text('Pipeline is split-locked.'), findsOneWidget);
    expect(find.text('ship it'), findsOneWidget);
    expect(find.byKey(const ValueKey('pipeline-dispatch-run')), findsOneWidget);
    expect(find.text('Run'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('disconnecting shows a not-connected notice that can retry', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final repository = dispatchRepository()
      ..pipelineFormResult = {'dispatchInputs': <String, dynamic>{}};
    final vm = await connect(tester, repository);
    addTearDown(vm.dispose);
    await tester.pumpWidget(formHost(vm));
    await tester.pumpAndSettle();
    await tester.runAsync(vm.disconnect);
    await tester.pumpAndSettle();

    expect(find.text('Not connected to a desktop.'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('pipeline-dispatch-retry')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('pipeline-dispatch-run')), findsNothing);
    expect(tester.takeException(), isNull);

    await tester.runAsync(() => vm.connect('123456'));
    await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-retry')));
    await tester.pumpAndSettle();

    expect(find.text('Not connected to a desktop.'), findsNothing);
    expect(find.byKey(const ValueKey('pipeline-dispatch-run')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
