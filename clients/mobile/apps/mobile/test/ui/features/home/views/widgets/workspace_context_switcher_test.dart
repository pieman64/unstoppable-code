import 'dart:async';
import 'dart:convert';
import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/services/account_api_service.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/workspace_context_store.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/views/widgets/home_navigation_drawer.dart';
import 'package:mobile/ui/features/home/views/widgets/workspace_context_switcher.dart';
import '../../../../../support/account_organizations_fixture.dart';

OrganizationSummary _org(String id, {String? name, String? logoUrl}) =>
    OrganizationSummary(
      id: id,
      name: name ?? 'Org $id',
      logoUrl: logoUrl,
      role: OrganizationRole.member,
      memberCount: 1,
      subTeamCount: 0,
    );

/// Fails every write, like a device that cannot save preferences.
final class _FailingStore implements WorkspaceContextStore {
  @override
  Future<WorkspaceContext?> read(String accountId) async => null;

  @override
  Future<void> write(String accountId, WorkspaceContext context) async =>
      throw StateError('disk full');
}

Future<AuthViewModel> _signIn(
  WidgetTester tester,
  List<OrganizationSummary> orgs, {
  WorkspaceContextStore? store,
}) async {
  final vm = AuthViewModel(
    repository: MockAuthRepository(latency: Duration.zero),
    loadOrganizations: teamsOnly(() async => orgs),
    workspaceContextStore: store,
  );
  addTearDown(vm.dispose);
  // The mock repository's Future.delayed must run outside FakeAsync.
  await tester.runAsync(
    () => vm.signIn(email: 'a@b.dev', password: 'password'),
  );
  return vm;
}

Widget _host(AuthViewModel vm, {ThemeMode mode = ThemeMode.light}) =>
    ChangeNotifierProvider<AuthViewModel>.value(
      value: vm,
      child: MaterialApp(
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: mode,
        home: const Scaffold(
          body: SafeArea(child: Column(children: [WorkspaceContextRow()])),
        ),
      ),
    );

void _usePhone(WidgetTester tester) {
  tester.view.physicalSize = const Size(1170, 2532); // 390 logical
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

Finder get _row => find.byKey(const ValueKey('home-workspace-context-row'));

Finder _option(String id) => find.byKey(ValueKey('workspace-context-org-$id'));

/// Fails unless [text] is painted in full inside [option]: in one paragraph
/// that is not ellipsized, within the option and within the screen.
void _expectFullyVisible(WidgetTester tester, Finder option, String text) {
  final paragraphs = tester
      .renderObjectList<RenderParagraph>(
        find.descendant(of: option, matching: find.byType(RichText)),
      )
      .where((paragraph) => paragraph.text.toPlainText().contains(text))
      .toList();
  expect(paragraphs, hasLength(1), reason: '"$text" is not rendered once');
  final paragraph = paragraphs.single;
  expect(
    paragraph.didExceedMaxLines,
    isFalse,
    reason: '"$text" is in truncated text',
  );
  final start = paragraph.text.toPlainText().indexOf(text);
  final boxes = paragraph.getBoxesForSelection(
    TextSelection(baseOffset: start, extentOffset: start + text.length),
  );
  expect(boxes, isNotEmpty, reason: '"$text" has no painted glyphs');
  final screen =
      Offset.zero & tester.view.physicalSize / tester.view.devicePixelRatio;
  final bounds = tester.getRect(option).intersect(screen).inflate(0.5);
  for (final box in boxes) {
    final rect = MatrixUtils.transformRect(
      paragraph.getTransformTo(null),
      box.toRect(),
    );
    expect(
      bounds.contains(rect.topLeft) && bounds.contains(rect.bottomRight),
      isTrue,
      reason: '"$text" at $rect is outside $bounds',
    );
  }
}

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await (FontLoader(
      'Inter',
    )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
  });

  group('CAN-3715 Personal organization', () {
    const personalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    /// Signs in from a real `GET /api/account/organizations` body that lists
    /// one team and the account's Personal organization.
    Future<AuthViewModel> signInWithPersonal(WidgetTester tester) async {
      final service = AccountApiService(
        apiClient: ApiClient(
          baseUrl: 'https://api.test',
          httpClient: MockClient(
            (request) async => http.Response(
              jsonEncode({
                'organizations': [
                  {
                    'id': 'org-1',
                    'name': 'Org org-1',
                    'role': 'MEMBER',
                    'memberCount': 1,
                    'subTeamCount': 0,
                  },
                ],
                'personalOrganizationId': personalId,
              }),
              200,
            ),
          ),
        ),
      );
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: service.listOrganizations,
      );
      addTearDown(vm.dispose);
      await tester.runAsync(
        () => vm.signIn(email: 'a@b.dev', password: 'password'),
      );
      return vm;
    }

    testWidgets('the picker moves between Personal Activity and a team and '
        'announces the selection', (tester) async {
      _usePhone(tester);
      final vm = await signInWithPersonal(tester);
      await tester.pumpWidget(_host(vm));
      // Personal is a context, not a team row.
      expect(vm.isPersonalActive, isTrue);
      expect(vm.organizations.map((org) => org.id), ['org-1']);

      Future<(Tristate, Tristate)> openPickerStates() async {
        await tester.tap(_row);
        await tester.pumpAndSettle();
        Tristate selected(Finder option, String name) {
          final node = tester.getSemantics(option);
          expect(node.getSemanticsData().label, contains(name));
          return node.flagsCollection.isSelected;
        }

        return (
          selected(
            find.byKey(const ValueKey('workspace-context-personal')),
            'Personal',
          ),
          selected(_option('org-1'), 'Org org-1'),
        );
      }

      expect(await openPickerStates(), (Tristate.isTrue, Tristate.isFalse));
      await tester.tap(_option('org-1'));
      await tester.pumpAndSettle();
      expect(vm.activeOrgId, 'org-1');
      expect(vm.isPersonalActive, isFalse);

      expect(await openPickerStates(), (Tristate.isFalse, Tristate.isTrue));
      await tester.tap(
        find.byKey(const ValueKey('workspace-context-personal')),
      );
      await tester.pumpAndSettle();
      expect(vm.activeOrgId, isNull);
      expect(vm.personalOrganizationId, personalId);
      expect(vm.isPersonalActive, isTrue);
      expect(tester.takeException(), isNull);
    });
  });

  group('CAN-4429 WorkspaceContextRow', () {
    for (final mode in [ThemeMode.light, ThemeMode.dark]) {
      for (final organizationSelected in [false, true]) {
        for (final scale in [1.0, 2.0]) {
          testWidgets('matches navigation row geometry (${mode.name}, '
              'organization: $organizationSelected, ${scale}x text)', (
            tester,
          ) async {
            _usePhone(tester);
            tester.platformDispatcher.textScaleFactorTestValue = scale;
            addTearDown(
              tester.platformDispatcher.clearTextScaleFactorTestValue,
            );
            final vm = await _signIn(tester, [_org('a')]);
            if (organizationSelected) vm.switchOrg('a');
            final label = organizationSelected ? 'Org a' : 'Personal';
            await tester.pumpWidget(
              ChangeNotifierProvider<AuthViewModel>.value(
                value: vm,
                child: MaterialApp(
                  theme: AppTheme.light,
                  darkTheme: AppTheme.dark,
                  themeMode: mode,
                  home: Scaffold(
                    body: Align(
                      alignment: Alignment.centerLeft,
                      child: SizedBox(
                        width: 326,
                        child: HomeNavigationDrawer(
                          tabs: const [HomeTab.remote, HomeTab.cloud],
                          contextRow: const WorkspaceContextRow(),
                          selectedTab: HomeTab.remote,
                          onSelected: (_) {},
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            );
            await tester.pumpAndSettle();

            Map<String, Object?> metrics(Finder row, String title) {
              final bounds = tester.getRect(row);
              final icon = find
                  .descendant(of: row, matching: find.byType(CanopyIcon))
                  .first;
              final text = find.descendant(of: row, matching: find.text(title));
              final iconBounds = tester.getRect(icon);
              final textBounds = tester.getRect(text);
              final paragraph = tester.renderObject<RenderParagraph>(
                find.descendant(of: text, matching: find.byType(RichText)),
              );
              final style = paragraph.text.style!;
              return {
                'row size': bounds.size,
                'row left': bounds.left,
                'icon size': iconBounds.size,
                'icon inset': iconBounds.left - bounds.left,
                'text inset': textBounds.left - bounds.left,
                'icon to text': textBounds.left - iconBounds.right,
                'icon center': iconBounds.center.dy - bounds.center.dy,
                'text center': textBounds.center.dy - bounds.center.dy,
                'font size': style.fontSize,
                'font family': style.fontFamily,
                'font weight': style.fontWeight,
                'font variations': style.fontVariations,
                'line height': style.height,
              };
            }

            final remote = find.byKey(const ValueKey('home-nav-remote'));
            final cloud = find.byKey(const ValueKey('home-nav-cloud'));
            // Compare single-line rows; longer destination labels may wrap
            // when system text is enlarged.
            expect(metrics(_row, label), metrics(cloud, 'Cloud chats'));
            expect(
              tester.getRect(remote).top - tester.getRect(_row).bottom,
              tester.getRect(cloud).top - tester.getRect(remote).bottom,
            );
            expect(tester.getSize(_row).height, greaterThanOrEqualTo(44));
            expect(tester.takeException(), isNull);

            await tester.tap(_row);
            await tester.pumpAndSettle();
            expect(find.text('Switch context'), findsNothing);
            expect(
              find.byKey(const ValueKey('workspace-context-picker')),
              findsOneWidget,
            );
            final choice = organizationSelected
                ? find.byKey(const ValueKey('workspace-context-personal'))
                : _option('a');
            await tester.tap(choice);
            await tester.pumpAndSettle();
            expect(vm.workspaceContext.isPersonal, organizationSelected);
            expect(tester.takeException(), isNull);
          });
        }
      }
    }

    testWidgets('shows the organization logo in the row and picker', (
      tester,
    ) async {
      _usePhone(tester);
      const logoUrl = 'https://images.test/organization-logo.png';
      final image = await tester.runAsync(
        () => createTestImage(width: 24, height: 24),
      );
      final loaded = Completer<ImageInfo>();
      PaintingBinding.instance.imageCache.putIfAbsent(
        const NetworkImage(logoUrl),
        () => OneFrameImageStreamCompleter(loaded.future),
      );
      addTearDown(() {
        PaintingBinding.instance.imageCache.clear();
        PaintingBinding.instance.imageCache.clearLiveImages();
      });
      final vm = await _signIn(tester, [
        _org('a', logoUrl: logoUrl),
        _org('b'),
      ]);
      vm.switchOrg('a');
      await tester.pumpWidget(_host(vm));
      final imageFinder = find.descendant(
        of: _row,
        matching: find.byType(Image),
      );
      expect(imageFinder, findsOneWidget);
      expect(
        tester.widget<Image>(imageFinder).image,
        const NetworkImage(logoUrl),
      );
      final before = tester.getRect(_row);
      expect(
        find.descendant(
          of: _row,
          matching: find.byWidgetPredicate(
            (widget) =>
                widget is CanopyIcon && widget.glyph == CanopyGlyph.buildings,
          ),
        ),
        findsOneWidget,
      );

      loaded.complete(ImageInfo(image: image!));
      await tester.pumpAndSettle();
      expect(tester.getSize(imageFinder), const Size(24, 24));
      expect(tester.getRect(_row), before);
      expect(
        find.descendant(of: _row, matching: find.byType(RawImage)),
        findsOneWidget,
      );

      await tester.tap(_row);
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: _option('a'), matching: find.byType(Image)),
        findsOneWidget,
      );
      expect(
        find.descendant(of: _option('b'), matching: find.byType(Image)),
        findsNothing,
      );
      await tester.tap(
        find.byKey(const ValueKey('workspace-context-personal')),
      );
      await tester.pumpAndSettle();
      expect(vm.workspaceContext.isPersonal, isTrue);
      expect(
        find.descendant(of: _row, matching: find.byType(Image)),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('a failed logo uses the building fallback without throwing', (
      tester,
    ) async {
      _usePhone(tester);
      final vm = await _signIn(tester, [
        _org('a', logoUrl: 'https://images.test/missing-logo.png'),
      ]);
      vm.switchOrg('a');
      await tester.pumpWidget(_host(vm));
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: _row, matching: find.byType(Image)),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: _row,
          matching: find.byWidgetPredicate(
            (widget) =>
                widget is CanopyIcon && widget.glyph == CanopyGlyph.buildings,
          ),
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('is hidden for an account with no organizations', (
      tester,
    ) async {
      final vm = await _signIn(tester, const []);
      await tester.pumpWidget(_host(vm));

      expect(_row, findsNothing);
      expect(vm.workspaceContext, const WorkspaceContext.personal());
    });

    testWidgets('shows Personal for a single organization and switches', (
      tester,
    ) async {
      _usePhone(tester);
      final vm = await _signIn(tester, [_org('solo')]);
      await tester.pumpWidget(_host(vm));

      expect(
        find.descendant(of: _row, matching: find.text('Personal')),
        findsOneWidget,
      );
      expect(
        find.bySemanticsLabel('Workspace context: Personal'),
        findsOneWidget,
      );
      expect(tester.getSize(_row).height, greaterThanOrEqualTo(44));

      await tester.tap(_row);
      await tester.pumpAndSettle();
      expect(find.text('Switch context'), findsNothing);
      expect(
        find.byKey(const ValueKey('workspace-context-picker')),
        findsOneWidget,
      );
      final personal = find.byKey(const ValueKey('workspace-context-personal'));
      expect(
        find.descendant(of: personal, matching: find.byType(ListTile)),
        findsOneWidget,
      );
      expect(tester.getSemantics(personal), isSemantics(isSelected: true));

      await tester.tap(find.text('Org solo'));
      await tester.pumpAndSettle();

      expect(vm.workspaceContext, const WorkspaceContext.organization('solo'));
      expect(
        find.descendant(of: _row, matching: find.text('Org solo')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    for (final (label, mode) in const [
      ('light', ThemeMode.light),
      ('dark', ThemeMode.dark),
    ]) {
      testWidgets('long names and many organizations fit a phone ($label)', (
        tester,
      ) async {
        _usePhone(tester);
        final vm = await _signIn(tester, [
          for (var i = 0; i < 20; i++)
            _org(
              'org-$i',
              name: 'A very long organization name number $i for testing',
            ),
        ]);
        vm.switchOrg('org-3');
        await tester.pumpWidget(_host(vm, mode: mode));
        expect(tester.takeException(), isNull);

        await tester.tap(_row);
        await tester.pumpAndSettle();
        // The list scrolls; the last organization is reachable.
        await tester.scrollUntilVisible(
          find.byKey(const ValueKey('workspace-context-org-org-19')),
          200,
          scrollable: find.descendant(
            of: find.byKey(const ValueKey('workspace-context-picker')),
            matching: find.byType(Scrollable),
          ),
        );
        expect(tester.takeException(), isNull);
      });
    }

    group('duplicate organization names', () {
      const acme = '0f0e0d0c-0000-4000-8000-000000111111';
      const acmeTwin = '0f0e0d0c-0000-4000-8000-000000222222';
      const zen = '0f0e0d0c-0000-4000-8000-000000333333';
      final orgs = [
        _org(acme, name: 'Acme'),
        _org(acmeTwin, name: ' acme'),
        _org(zen, name: 'Zen'),
      ];

      Widget organizationPickerHost(
        AuthViewModel vm, {
        ThemeMode mode = ThemeMode.light,
      }) => ChangeNotifierProvider<AuthViewModel>.value(
        value: vm,
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          themeMode: mode,
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showOrganizationPicker(context),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );

      Future<void> expectDistinctOptions(WidgetTester tester) async {
        // Names that match ignoring case and surrounding spaces get the last
        // six ID characters; the name itself stays verbatim.
        _expectFullyVisible(tester, _option(acme), 'Acme');
        _expectFullyVisible(tester, _option(acme), '111111');
        _expectFullyVisible(tester, _option(acmeTwin), ' acme');
        _expectFullyVisible(tester, _option(acmeTwin), '222222');
        expect(
          find.descendant(of: _option(zen), matching: find.text('Zen')),
          findsOneWidget,
        );
        expect(find.textContaining('333333'), findsNothing);
        expect(find.bySemanticsLabel(RegExp('^Acme 111111')), findsOneWidget);
        expect(find.bySemanticsLabel(RegExp('^ acme 222222')), findsOneWidget);
      }

      testWidgets('get an ID suffix in the workspace context picker', (
        tester,
      ) async {
        _usePhone(tester);
        final vm = await _signIn(tester, orgs);
        await tester.pumpWidget(_host(vm));

        await tester.tap(_row);
        await tester.pumpAndSettle();
        await expectDistinctOptions(tester);

        await tester.tap(_option(acmeTwin));
        await tester.pumpAndSettle();
        expect(
          vm.workspaceContext,
          const WorkspaceContext.organization(acmeTwin),
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets('get an ID suffix in the organization picker', (
        tester,
      ) async {
        _usePhone(tester);
        final vm = await _signIn(tester, orgs);
        await tester.pumpWidget(organizationPickerHost(vm));

        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        expect(find.text('Choose an organization'), findsOneWidget);
        expect(find.text('Personal'), findsNothing);
        await expectDistinctOptions(tester);

        await tester.tap(_option(acme));
        await tester.pumpAndSettle();
        expect(vm.workspaceContext, const WorkspaceContext.organization(acme));
        expect(tester.takeException(), isNull);
      });

      const longName = 'Northwind Research and Development Collective';
      const northwind = '0f0e0d0c-0000-4000-8000-000000444444';
      const northwindTwin = '0f0e0d0c-0000-4000-8000-000000555555';
      for (final (picker, contextPicker) in const [
        ('workspace context picker', true),
        ('organization picker', false),
      ]) {
        for (final (theme, mode, scale) in const [
          ('light', ThemeMode.light, 1.0),
          ('dark', ThemeMode.dark, 1.0),
          ('light', ThemeMode.light, 2.0),
          ('dark', ThemeMode.dark, 2.0),
        ]) {
          testWidgets(
            'keep the ID suffix visible for long names in the $picker '
            '($theme, ${scale}x text)',
            (tester) async {
              _usePhone(tester);
              tester.platformDispatcher.textScaleFactorTestValue = scale;
              addTearDown(
                tester.platformDispatcher.clearTextScaleFactorTestValue,
              );
              final vm = await _signIn(tester, [
                _org(northwind, name: longName),
                _org(northwindTwin, name: longName),
              ]);
              // The selected row's checkmark leaves the least title width.
              vm.switchOrg(northwindTwin);
              await tester.pumpWidget(
                contextPicker
                    ? _host(vm, mode: mode)
                    : organizationPickerHost(vm, mode: mode),
              );

              await tester.tap(contextPicker ? _row : find.text('Open'));
              await tester.pumpAndSettle();
              expect(tester.takeException(), isNull);
              for (final (id, suffix) in const [
                (northwind, '444444'),
                (northwindTwin, '555555'),
              ]) {
                _expectFullyVisible(tester, _option(id), suffix);
                _expectFullyVisible(tester, _option(id), 'Member');
                expect(
                  find.descendant(
                    of: _option(id),
                    matching: find.textContaining('Northwind'),
                  ),
                  findsOneWidget,
                );
                expect(
                  find.bySemanticsLabel(RegExp('^$longName $suffix')),
                  findsOneWidget,
                );
              }
            },
          );
        }
      }
    });

    testWidgets('a failed save keeps the selection and offers Retry', (
      tester,
    ) async {
      _usePhone(tester);
      final vm = await _signIn(tester, [_org('a')], store: _FailingStore());
      await tester.pumpWidget(_host(vm));

      await tester.tap(_row);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Org a'));
      await tester.pumpAndSettle();

      expect(vm.workspaceContext, const WorkspaceContext.organization('a'));
      expect(
        find.text(
          'Could not save this choice. It applies until you restart the app.',
        ),
        findsOneWidget,
      );
      expect(find.text('Retry'), findsOneWidget);
    });

    testWidgets('a refused choice keeps the context and offers Retry', (
      tester,
    ) async {
      _usePhone(tester);
      var loadFails = false;
      final vm = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(() async {
          if (loadFails) throw StateError('offline');
          return [_org('a')];
        }),
      );
      addTearDown(vm.dispose);
      await tester.runAsync(
        () => vm.signIn(email: 'a@b.dev', password: 'password'),
      );
      await tester.pumpWidget(_host(vm));

      await tester.tap(_row);
      await tester.pumpAndSettle();
      // Memberships fail to reload while the sheet is open, so the account
      // lists no organizations and refuses the choice.
      loadFails = true;
      await tester.runAsync(vm.reloadOrganizations);
      await tester.tap(find.text('Org a'));
      await tester.pumpAndSettle();

      expect(vm.workspaceContext, const WorkspaceContext.personal());
      expect(find.text("Couldn't switch context. Try again."), findsOneWidget);
      expect(find.textContaining('Could not save'), findsNothing);

      loadFails = false;
      await tester.runAsync(vm.reloadOrganizations);
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(vm.workspaceContext, const WorkspaceContext.organization('a'));
      expect(tester.takeException(), isNull);
    });
  });
}
