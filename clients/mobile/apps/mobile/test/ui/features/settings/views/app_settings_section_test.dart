import 'dart:ui' show Tristate;

// Settings' App and Help sections (CAN-4449), which replaced the separate
// Settings screen: the Appearance menu, the push toggle with its error and
// Retry, the server environment while staging is active, Send feedback and
// the offline licenses.

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/config/demo_mode.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/notification_preferences.dart';
import 'package:mobile/data/repositories/feedback_report_repository.dart';
import 'package:mobile/data/repositories/notification_preferences_repository.dart';
import 'package:mobile/data/services/theme_preference_store.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/theme_controller.dart';
import 'package:mobile/ui/features/settings/view_models/notifications_view_model.dart';
import 'package:mobile/ui/features/settings/views/app_settings_section.dart';
import 'package:mobile/ui/features/settings/views/help_settings_section.dart';
import 'package:provider/provider.dart';

Widget _host(
  ThemeController controller, {
  NotificationsViewModel? notifications,
}) => MultiProvider(
  providers: [
    Provider<FeedbackReportRepository>.value(
      value: MockFeedbackReportRepository(latency: Duration.zero),
    ),
    ChangeNotifierProvider<ThemeController>.value(value: controller),
    ChangeNotifierProvider<NotificationsViewModel>.value(
      value:
          notifications ??
          NotificationsViewModel(
            repository: MockNotificationPreferencesRepository(
              latency: Duration.zero,
            ),
            isConfigured: () => true,
          ),
    ),
  ],
  child: MaterialApp(
    theme: AppTheme.light,
    home: Scaffold(
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: const [
          AppSettingsSection(),
          SizedBox(height: 32),
          HelpSettingsSection(),
        ],
      ),
    ),
  ),
);

Finder _checkmark() => find.byWidgetPredicate(
  (widget) => widget is CanopyIcon && widget.glyph == CanopyGlyph.checkmark1,
);

/// The menu option labelled [label]; the row also shows the current label.
Finder _option(String label) =>
    find.widgetWithText(PopupMenuItem<ThemeMode>, label);

/// Points [AppConfig] at a controller with the given fixed origins, restoring
/// the unconfigured default after the test.
void _configureEnvironments({
  required String production,
  required String staging,
  ApiEnvironment selected = ApiEnvironment.production,
}) {
  ApiEnvironmentController controller(String production, String staging) =>
      ApiEnvironmentController(
        productionBaseUrl: production,
        stagingBaseUrl: staging,
        initialEnvironment: selected,
        preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
      );
  AppConfig.configureEnvironmentController(controller(production, staging));
  addTearDown(
    () => AppConfig.configureEnvironmentController(controller('', '')),
  );
}

void main() {
  testWidgets('Appearance shows the current mode and opens a checked menu', (
    tester,
  ) async {
    final controller = ThemeController(store: InMemoryThemePreferenceStore());
    await tester.pumpWidget(_host(controller));
    await tester.pumpAndSettle();

    expect(find.text('Appearance'), findsOneWidget);
    expect(find.text('System'), findsOneWidget);
    expect(_checkmark(), findsNothing);

    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();

    expect(_option('System'), findsOneWidget);
    expect(_option('Light'), findsOneWidget);
    expect(_option('Dark'), findsOneWidget);
    expect(_checkmark(), findsOneWidget);
    expect(
      find.descendant(of: _option('System'), matching: _checkmark()),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('choosing a mode applies and persists it', (tester) async {
    final store = InMemoryThemePreferenceStore();
    final controller = ThemeController(store: store);
    await tester.pumpWidget(_host(controller));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();
    await tester.tap(_option('Dark'));
    await tester.pumpAndSettle();

    expect(controller.mode, ThemeMode.dark);
    expect(await store.read(), ThemeMode.dark);
    expect(_option('Dark'), findsNothing, reason: 'the menu closed');
    expect(find.text('Dark'), findsOneWidget, reason: 'the row value');

    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();
    expect(
      find.descendant(of: _option('Dark'), matching: _checkmark()),
      findsOneWidget,
    );
  });

  testWidgets('dismissing or re-choosing the current mode changes nothing', (
    tester,
  ) async {
    final controller = ThemeController(
      store: InMemoryThemePreferenceStore(),
      initialMode: ThemeMode.light,
    );
    var notifications = 0;
    controller.addListener(() => notifications++);
    await tester.pumpWidget(_host(controller));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();
    await tester.tapAt(const Offset(400, 590));
    await tester.pumpAndSettle();
    expect(_option('Light'), findsNothing);

    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();
    await tester.tap(_option('Light'));
    await tester.pumpAndSettle();

    expect(controller.mode, ThemeMode.light);
    expect(notifications, 0);
  });

  testWidgets('Appearance announces its current value', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      _host(
        ThemeController(
          store: InMemoryThemePreferenceStore(),
          initialMode: ThemeMode.dark,
        ),
      ),
    );
    await tester.pumpAndSettle();

    final node = tester.getSemantics(find.text('Appearance'));
    expect(node.label, 'Appearance\nDark');
    expect(node.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
    semantics.dispose();
  });

  testWidgets('the push row reflects the loaded preference', (tester) async {
    final repository = MockNotificationPreferencesRepository(
      latency: Duration.zero,
    );
    final notifications = NotificationsViewModel(
      repository: repository,
      isConfigured: () => true,
    );
    await tester.runAsync(() async {
      await repository.update(pushEnabled: false);
      await notifications.load();
    });

    await tester.pumpWidget(
      _host(
        ThemeController(store: InMemoryThemePreferenceStore()),
        notifications: notifications,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Push notifications'), findsOneWidget);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
  });

  testWidgets('tapping anywhere on the push row toggles it once', (
    tester,
  ) async {
    final repository = MockNotificationPreferencesRepository(
      latency: Duration.zero,
    );
    final notifications = NotificationsViewModel(
      repository: repository,
      isConfigured: () => true,
    );
    await tester.pumpWidget(
      _host(
        ThemeController(store: InMemoryThemePreferenceStore()),
        notifications: notifications,
      ),
    );
    await tester.pumpAndSettle();
    expect(notifications.pushEnabled, isTrue);

    await tester.tap(find.text('Push notifications'));
    await tester.pumpAndSettle();
    expect(notifications.pushEnabled, isFalse);
    expect(repository.updateCount, 1);

    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(notifications.pushEnabled, isTrue);
    expect(repository.updateCount, 2);
  });

  testWidgets('the push row is one toggle for screen readers', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      _host(ThemeController(store: InMemoryThemePreferenceStore())),
    );
    await tester.pumpAndSettle();

    final node = tester.getSemantics(find.text('Push notifications'));
    expect(node.label, 'Push notifications');
    expect(node.getSemanticsData().flagsCollection.isToggled, Tristate.isTrue);
    expect(
      tester.getSemantics(find.byType(Switch)),
      same(node),
      reason: 'the switch merges into the row',
    );
    semantics.dispose();
  });

  testWidgets('an outstanding push update keeps one disabled toggle, then '
      'restores it', (tester) async {
    final semantics = tester.ensureSemantics();
    final repository = MockNotificationPreferencesRepository(
      latency: const Duration(seconds: 1),
    );
    final notifications = NotificationsViewModel(
      repository: repository,
      isConfigured: () => true,
    );
    await tester.pumpWidget(
      _host(
        ThemeController(store: InMemoryThemePreferenceStore()),
        notifications: notifications,
      ),
    );
    await tester.pumpAndSettle();

    SemanticsData pushToggle() {
      final node = tester.getSemantics(find.text('Push notifications'));
      expect(
        tester.getSemantics(find.byType(Switch)),
        same(node),
        reason: 'the switch merges into the row',
      );
      final data = node.getSemanticsData();
      expect(data.label, 'Push notifications');
      return data;
    }

    await tester.tap(find.text('Push notifications'));
    await tester.pump();
    expect(notifications.isMutating, isTrue);
    final pending = pushToggle();
    expect(pending.flagsCollection.isToggled, Tristate.isFalse);
    expect(pending.flagsCollection.isEnabled, Tristate.isFalse);
    expect(pending.hasAction(SemanticsAction.tap), isFalse);

    await tester.tap(find.text('Push notifications'), warnIfMissed: false);
    await tester.pump();
    expect(repository.updateCount, 1, reason: 'a pending row ignores taps');

    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(notifications.isMutating, isFalse);
    final restored = pushToggle();
    expect(restored.flagsCollection.isToggled, Tristate.isFalse);
    expect(restored.flagsCollection.isEnabled, Tristate.isTrue);
    expect(restored.hasAction(SemanticsAction.tap), isTrue);
    semantics.dispose();
  });

  testWidgets('a failed load shows the error and Retry on the push row', (
    tester,
  ) async {
    final repository = _FailingOnceRepository();
    final notifications = NotificationsViewModel(
      repository: repository,
      isConfigured: () => true,
    );
    await tester.runAsync(notifications.load);
    await tester.pumpWidget(
      _host(
        ThemeController(store: InMemoryThemePreferenceStore()),
        notifications: notifications,
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.text('Could not update notification settings.'),
      findsOneWidget,
    );
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();

    expect(repository.loads, 2);
    expect(find.text('Could not update notification settings.'), findsNothing);
    expect(find.text('Retry'), findsNothing);
  });

  testWidgets('a loading push preference keeps its row with a placeholder', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    final notifications = NotificationsViewModel(
      repository: MockNotificationPreferencesRepository(
        latency: const Duration(seconds: 1),
      ),
      isConfigured: () => true,
    );
    await tester.pumpWidget(
      _host(
        ThemeController(store: InMemoryThemePreferenceStore()),
        notifications: notifications,
      ),
    );
    notifications.load();
    await tester.pump();

    expect(find.text('Push notifications'), findsOneWidget);
    expect(find.byType(Switch), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.bySemanticsLabel(RegExp('Loading')), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.byType(Switch), findsOneWidget);
    semantics.dispose();
  });

  group('server environment', () {
    tearDown(() => DemoMode.enabled.value = false);

    testWidgets('shows Staging while staging is active', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      _configureEnvironments(
        production: 'https://production.test',
        staging: 'https://staging.test',
        selected: ApiEnvironment.staging,
      );
      final controller = ThemeController(store: InMemoryThemePreferenceStore());
      await tester.pumpWidget(_host(controller));
      await tester.pumpAndSettle();

      final row = find.byKey(const ValueKey('server-environment'));
      expect(row, findsOneWidget);
      expect(
        find.descendant(of: row, matching: find.text('Server environment')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.text('Staging')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('is hidden while production is active', (tester) async {
      _configureEnvironments(
        production: 'https://production.test',
        staging: 'https://staging.test',
      );
      final controller = ThemeController(store: InMemoryThemePreferenceStore());
      await tester.pumpWidget(_host(controller));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('server-environment')), findsNothing);
    });

    testWidgets('is hidden in reviewer demo mode', (tester) async {
      _configureEnvironments(
        production: 'https://production.test',
        staging: 'https://staging.test',
        selected: ApiEnvironment.staging,
      );
      DemoMode.enabled.value = true;
      final controller = ThemeController(store: InMemoryThemePreferenceStore());
      await tester.pumpWidget(_host(controller));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('server-environment')), findsNothing);
    });
  });

  testWidgets('Help opens feedback and the offline licenses', (tester) async {
    await tester.pumpWidget(
      _host(ThemeController(store: InMemoryThemePreferenceStore())),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('send-feedback-tile')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('send-feedback-tile')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('feedback-report-sheet')), findsOneWidget);
    await tester.tapAt(const Offset(5, 5));
    await tester.pumpAndSettle();

    await tester.ensureVisible(
      find.byKey(const ValueKey('open-source-licenses')),
    );
    await tester.tap(find.byKey(const ValueKey('open-source-licenses')));
    await tester.pumpAndSettle();
    expect(find.byType(LicensePage), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

/// Fails the first load, then serves push enabled.
final class _FailingOnceRepository
    implements NotificationPreferencesRepository {
  int loads = 0;

  @override
  Future<NotificationPreferences> load() async {
    loads++;
    if (loads == 1) throw StateError('offline');
    return const NotificationPreferences(pushEnabled: true);
  }

  @override
  Future<NotificationPreferences> update({required bool pushEnabled}) async =>
      NotificationPreferences(pushEnabled: pushEnabled);
}
