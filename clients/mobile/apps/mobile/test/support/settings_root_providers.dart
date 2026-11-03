import 'package:mobile/data/repositories/notification_preferences_repository.dart';
import 'package:mobile/data/services/theme_preference_store.dart';
import 'package:mobile/ui/core/theme_controller.dart';
import 'package:mobile/ui/features/settings/view_models/notifications_view_model.dart';
import 'package:provider/provider.dart';
import 'package:provider/single_child_widget.dart';

/// The root providers Settings' App rows read (CAN-4449). Production mounts
/// them above the auth gate in `main.dart`; shell test hosts mount these
/// in-memory equivalents.
List<SingleChildWidget> settingsRootTestProviders() => [
  ChangeNotifierProvider<ThemeController>(
    create: (_) => ThemeController(store: InMemoryThemePreferenceStore()),
  ),
  ChangeNotifierProvider<NotificationsViewModel>(
    create: (_) => NotificationsViewModel(
      repository: MockNotificationPreferencesRepository(latency: Duration.zero),
      isConfigured: () => true,
    ),
  ),
];
