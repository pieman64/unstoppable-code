import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';

void main() {
  group('home tab sets', () {
    test('the organization shell shows every tab, menu rows first', () {
      expect(organizationHomeTabs, const [
        HomeTab.cloud,
        // Advisor leads Remote control, as in the desktop and web nav.
        HomeTab.advisor,
        HomeTab.remote,
        HomeTab.account,
        // Opened from Account rather than menu rows (CAN-3558), in the order
        // Account lists them.
        HomeTab.activity,
        HomeTab.usage,
        HomeTab.members,
        // Chat has no menu row; it sits last so order still describes the menu.
        HomeTab.chat,
      ]);
      expect(settingsHomeTabs, const [
        HomeTab.activity,
        HomeTab.usage,
        HomeTab.members,
      ]);
    });

    test(
      'the no-organization shell drops the org-scoped tabs and keeps Members '
      'last as the create-org / invitations home',
      () {
        expect(noOrganizationHomeTabs, const [
          HomeTab.cloud,
          HomeTab.advisor,
          HomeTab.remote,
          HomeTab.account,
          HomeTab.members,
          HomeTab.chat,
        ]);
        expect(noOrganizationHomeTabs, isNot(contains(HomeTab.activity)));
        expect(noOrganizationHomeTabs, isNot(contains(HomeTab.usage)));
      },
    );

    test('without cloud chats it lands on Remote so solo users can connect '
        'their desktop', () {
      // The interim Cloud entry (CAN-3143) sits first in menu order but does
      // not take over the landing destination. With cloud chats available
      // every shell lands on Chat instead (CAN-2930).
      expect(noOrganizationLandingTab, HomeTab.remote);
      expect(noOrganizationHomeTabs, contains(noOrganizationLandingTab));
    });
  });

  group('HomeTabController', () {
    test('starts on the first visible tab by default', () {
      expect(
        HomeTabController(tabs: organizationHomeTabs).value,
        HomeTab.cloud,
      );
      expect(
        HomeTabController(tabs: noOrganizationHomeTabs).value,
        HomeTab.cloud,
      );
    });

    test('an explicit initialTab overrides first-tab-wins, so menu order and '
        'landing destination can differ', () {
      final controller = HomeTabController(
        tabs: noOrganizationHomeTabs,
        initialTab: HomeTab.account,
      );

      expect(controller.value, HomeTab.account);
      expect(controller.initialTab, HomeTab.account);
      expect(controller.selectedIndex, 3);
    });

    test('selectedIndex reports the position within the visible tabs', () {
      final controller = HomeTabController(tabs: noOrganizationHomeTabs);
      expect(controller.selectedIndex, 0);
      controller.select(HomeTab.members);
      expect(controller.selectedIndex, 4);
    });

    test(
      'select is a no-op for a hidden tab, so a feed deep-link cannot land a '
      'no-organization user on whichever tab happens to sit at index 0',
      () {
        final controller = HomeTabController(tabs: noOrganizationHomeTabs);
        var notifications = 0;
        controller.addListener(() => notifications++);

        controller.select(HomeTab.activity);

        expect(controller.value, HomeTab.cloud);
        expect(notifications, 0);
      },
    );

    test('the inherited value setter is guarded too, so no caller can push the '
        'controller out of its tab set and make selectedIndex -1', () {
      final controller = HomeTabController(tabs: noOrganizationHomeTabs);

      controller.value = HomeTab.usage;

      expect(controller.value, HomeTab.cloud);
      expect(controller.selectedIndex, 0);
    });

    test('select moves to a visible tab and notifies', () {
      final controller = HomeTabController(tabs: organizationHomeTabs);
      var notifications = 0;
      controller.addListener(() => notifications++);

      controller.select(HomeTab.account);

      expect(controller.value, HomeTab.account);
      expect(controller.selectedIndex, 3);
      expect(notifications, 1);
    });

    test('select notifies for a visible tab that is already selected', () {
      final controller = HomeTabController(tabs: organizationHomeTabs);
      var notifications = 0;
      controller.addListener(() => notifications++);

      controller.select(HomeTab.cloud);

      expect(controller.value, HomeTab.cloud);
      expect(notifications, 1);
    });
  });
  group('HomeTabControllerProvider', () {
    Widget buildSubject(List<HomeTab> tabs) => MaterialApp(
      home: HomeTabControllerProvider(
        tabs: tabs,
        child: Builder(
          builder: (context) {
            final controller = context.watch<HomeTabController>();
            return Text(
              '${controller.tabs.length}:${controller.value.name}',
              textDirection: TextDirection.ltr,
            );
          },
        ),
      ),
    );

    testWidgets(
      'swaps in a new controller when the user gains an organization, so the '
      'shell actually grows back to the full tab set (CAN-2576)',
      (tester) async {
        await tester.pumpWidget(buildSubject(noOrganizationHomeTabs));
        expect(find.text('6:cloud'), findsOneWidget);

        await tester.pumpWidget(buildSubject(organizationHomeTabs));

        // Eight tabs now, and Cloud carried over because the larger shell
        // still shows it.
        expect(find.text('8:cloud'), findsOneWidget);
      },
    );

    testWidgets(
      'carries a still-visible selection across a tab-set change, so creating '
      'an organization from Members does not bounce the user to Activity',
      (tester) async {
        await tester.pumpWidget(buildSubject(noOrganizationHomeTabs));
        tester
            .element(find.byType(Text))
            .read<HomeTabController>()
            .select(HomeTab.members);
        await tester.pump();
        expect(find.text('6:members'), findsOneWidget);

        await tester.pumpWidget(buildSubject(organizationHomeTabs));

        expect(find.text('8:members'), findsOneWidget);
      },
    );

    testWidgets(
      'falls back to the shell landing tab when the selection is gone',
      (tester) async {
        await tester.pumpWidget(buildSubject(organizationHomeTabs));
        tester
            .element(find.byType(Text))
            .read<HomeTabController>()
            .select(HomeTab.usage);
        await tester.pump();
        expect(find.text('8:usage'), findsOneWidget);

        await tester.pumpWidget(buildSubject(noOrganizationHomeTabs));

        expect(find.text('6:cloud'), findsOneWidget);
      },
    );

    testWidgets(
      'a removed Settings destination falls back to Activity when the new '
      'shell shows it (CAN-3715: Usage to Personal without a team)',
      (tester) async {
        await tester.pumpWidget(buildSubject(organizationHomeTabs));
        tester
            .element(find.byType(Text))
            .read<HomeTabController>()
            .select(HomeTab.usage);
        await tester.pump();
        expect(find.text('8:usage'), findsOneWidget);

        await tester.pumpWidget(buildSubject(personalHomeTabs));

        expect(find.text('7:activity'), findsOneWidget);
      },
    );

    testWidgets('keeps the selection across an unrelated rebuild', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(organizationHomeTabs));
      tester
          .element(find.byType(Text))
          .read<HomeTabController>()
          .select(HomeTab.account);
      await tester.pump();
      expect(find.text('8:account'), findsOneWidget);

      // Same tab set, fresh list instance: the controller must survive.
      await tester.pumpWidget(buildSubject([...organizationHomeTabs]));

      expect(find.text('8:account'), findsOneWidget);
    });
  });
}
