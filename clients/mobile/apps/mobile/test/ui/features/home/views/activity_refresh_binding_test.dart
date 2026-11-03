import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/activity_refresh_binding.dart';
import 'package:provider/provider.dart';

void main() {
  testWidgets('an Activity selection calls the current refresh with the '
      "binding's context (CAN-3715)", (tester) async {
    final tabs = HomeTabController(
      tabs: organizationHomeTabs,
      initialTab: HomeTab.remote,
    );
    final first = <BuildContext>[];
    final second = <BuildContext>[];
    Widget subject(void Function(BuildContext context) refresh) =>
        ChangeNotifierProvider<HomeTabController>.value(
          value: tabs,
          child: ActivityRefreshBinding(
            refresh: refresh,
            child: const SizedBox(),
          ),
        );

    await tester.pumpWidget(subject(first.add));
    await tester.pumpWidget(subject(second.add));
    tabs.select(HomeTab.activity);

    expect(first, isEmpty);
    expect(second, [tester.element(find.byType(ActivityRefreshBinding))]);
  });
}
