// CAN-2847 pull-to-refresh indicator capture. Seeded mocks, bundled fonts,
// reduced motion, and no network keep the evidence deterministic.
// From apps/mobile: REFRESH_INDICATOR_STAGE=before (or after) flutter test
// tool/design_system/refresh_indicator_capture_test.dart --update-goldens
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/feed_repository.dart';
import 'package:mobile/data/repositories/members_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/feed/view_models/feed_view_model.dart';
import 'package:mobile/ui/features/feed/views/feed_screen.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';
import 'package:provider/provider.dart';

import '../../test/support/reduced_motion.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  useReducedMotion();
  final stage = Platform.environment['REFRESH_INDICATOR_STAGE'] ?? 'after';

  setUpAll(() async {
    final loader = FontLoader('Inter')
      ..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'));
    await loader.load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });

  for (final dark in [false, true]) {
    testWidgets('activity refresh indicator ${dark ? 'dark' : 'light'}', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider(
              create: (_) => AuthViewModel(
                repository: MockAuthRepository(latency: Duration.zero),
              ),
            ),
            ChangeNotifierProvider(
              create: (_) =>
                  FeedViewModel(repository: MockFeedRepository())..loadFeed(),
            ),
            ChangeNotifierProvider(
              create: (_) => MembersViewModel(
                repository: MockMembersRepository(latency: Duration.zero),
              )..load(),
            ),
          ],
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: const FeedScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.drag(find.byType(ListView), const Offset(0, 180));
      await tester.pump();

      await expectLater(
        find.byType(FeedScreen),
        matchesGoldenFile(
          '../../../../.playwright/mobile-refresh-indicator/'
          'activity-$stage-${dark ? 'dark' : 'light'}.png',
        ),
      );
    });
  }
}
