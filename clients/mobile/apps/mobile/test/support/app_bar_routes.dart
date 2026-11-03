import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/feedback_report_repository.dart';
import 'package:mobile/data/repositories/notification_preferences_repository.dart';
import 'package:mobile/data/repositories/org_settings_repository.dart';
import 'package:mobile/data/repositories/sub_teams_repository.dart';
import 'package:mobile/data/repositories/member_detail_repository.dart';
import 'package:mobile/data/services/theme_preference_store.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/theme_controller.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/settings/view_models/notifications_view_model.dart';
import 'package:mobile/ui/features/organizations/view_models/org_settings_view_model.dart';
import 'package:mobile/ui/features/sub_teams/view_models/sub_teams_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/data/repositories/auth_sources_repository.dart';
import 'package:mobile/data/repositories/two_factor_repository.dart';
import 'package:mobile/ui/features/account/view_models/api_keys_view_model.dart';
import 'package:mobile/ui/features/account/view_models/auth_sources_view_model.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';
import 'package:mobile/ui/features/account/views/api_keys_screen.dart';
import 'package:mobile/ui/features/account/views/login_methods_screen.dart';
import 'package:mobile/ui/features/account/views/two_factor_settings_screen.dart';
import 'package:mobile/ui/features/developer_options/views/settings_list_screen.dart';
import 'package:mobile/ui/features/organizations/views/org_settings_screen.dart';
import 'package:mobile/ui/features/sub_teams/views/sub_teams_screen.dart';
import 'package:mobile/ui/features/members/views/member_detail_screen.dart';
import 'package:mobile/ui/features/remote/views/chat_search_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/developer_options/views/developer_options_screen.dart';
import 'package:mobile/ui/features/developer_options/views/design_system_screen.dart';
import 'package:mobile/ui/features/developer_options/views/icons_screen.dart';
import 'package:mobile/ui/features/developer_options/views/icon_buttons_screen.dart';
import 'package:mobile/ui/features/developer_options/views/foundations_screen.dart';
import 'package:mobile/ui/features/developer_options/views/fonts_screen.dart';
import 'package:mobile/ui/features/developer_options/views/typography_screen.dart';
import 'package:mobile/ui/features/developer_options/views/code_markdown_screen.dart';

Map<String, Widget> appBarRoutes(RemoteControlViewModel remote) => {
  'login-methods': const LoginMethodsScreen(),
  'two-factor': const TwoFactorSettingsScreen(),
  'api-keys': const ApiKeysScreen(),
  'organization-settings': const OrgSettingsScreen(),
  'sub-teams': const SubTeamsScreen(),
  'member-details': MemberDetailScreen(
    repository: MockMemberDetailRepository(latency: Duration.zero),
    member: const OrganizationMember(
      id: 'member-1',
      name: 'Sam Chen',
      email: 'sam@acme.dev',
      role: OrganizationRole.member,
      subTeamIds: [],
    ),
    canViewStats: true,
  ),
  'search-chats': const ChatSearchScreen(),
  'remote-chat': RemoteChatScreen.worktree(
    worktree: remote.worktreesFor('ws-app').first,
  ),
  'developer-options': const DeveloperOptionsScreen(),
  'design-system': const DesignSystemScreen(),
  'icons': const IconsScreen(),
  'icon-buttons': const IconButtonsScreen(),
  'colors': const ColorsScreen(),
  'corner-radii': const RadiiScreen(),
  'fonts': const FontsScreen(),
  'typography': const TypographyScreen(),
  'code-markdown': const CodeMarkdownScreen(),
  'settings-list': const SettingsListScreen(),
};

Widget appBarRouteHost({
  required RemoteControlViewModel remote,
  required Widget screen,
  required bool dark,
}) => MultiProvider(
  providers: [
    ChangeNotifierProvider(
      create: (_) =>
          TurnFeedbackController(repository: MockTurnFeedbackRepository()),
    ),
    ChangeNotifierProvider.value(value: remote),
    ChangeNotifierProvider(
      create: (_) =>
          AuthViewModel(repository: MockAuthRepository(latency: Duration.zero)),
    ),
    ChangeNotifierProvider(
      create: (_) => ThemeController(store: InMemoryThemePreferenceStore()),
    ),
    Provider<FeedbackReportRepository>(
      create: (_) => MockFeedbackReportRepository(latency: Duration.zero),
    ),
    ChangeNotifierProvider(
      create: (_) => NotificationsViewModel(
        repository: MockNotificationPreferencesRepository(
          latency: Duration.zero,
        ),
        isConfigured: () => true,
      )..load(),
    ),
    ChangeNotifierProvider(
      create: (_) => ApiKeysViewModel(
        repository: MockApiKeysRepository(latency: Duration.zero),
      )..load(),
    ),
    ChangeNotifierProvider(
      create: (_) => AuthSourcesViewModel(
        repository: MockAuthSourcesRepository(latency: Duration.zero),
      )..load(),
    ),
    ChangeNotifierProvider(
      create: (_) => TwoFactorViewModel(
        repository: MockTwoFactorRepository(latency: Duration.zero),
        issuer: 'Test',
      )..load(),
    ),
    ChangeNotifierProvider(
      create: (_) => OrgSettingsViewModel(
        repository: MockOrgSettingsRepository(latency: Duration.zero),
      ),
    ),
    ChangeNotifierProvider(
      create: (_) => SubTeamsViewModel(
        repository: MockSubTeamsRepository(latency: Duration.zero),
      ),
    ),
  ],
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: dark ? AppTheme.dark : AppTheme.light,
    home: Scaffold(
      body: Builder(
        builder: (context) => Center(
          child: TextButton(
            onPressed: () => Navigator.of(
              context,
            ).push(MaterialPageRoute<void>(builder: (_) => screen)),
            child: const Text('Open screen'),
          ),
        ),
      ),
    ),
  ),
);
