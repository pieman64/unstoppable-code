import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/members_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';
import 'package:mobile/ui/features/members/views/members_screen.dart';

void main() {
  group('MembersScreen', () {
    Widget buildSubject() {
      return ChangeNotifierProvider<AuthViewModel>(
        create: (_) => AuthViewModel(repository: MockAuthRepository()),
        child: ChangeNotifierProvider<MembersViewModel>(
          create: (_) =>
              MembersViewModel(repository: MockMembersRepository())..load(),
          child: MaterialApp(
            theme: AppTheme.light,
            home: const MembersScreen(),
          ),
        ),
      );
    }

    testWidgets('shows the app bar title', (tester) async {
      await tester.pumpWidget(buildSubject());
      expect(find.text('Members'), findsOneWidget);
      await tester.pumpAndSettle();
    });

    testWidgets('rebuilds the body out of the loading state after data loads', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      // First frame: the body renders the loading spinner.
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      await tester.pumpAndSettle();

      // The body must rebuild off the loading state once the VM notifies —
      // this is the behavior the `Builder` (driven by the load-bearing
      // `context.watch`) has to preserve.
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.text('Members'), findsOneWidget);
    });
  });
}
