import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/model-picker/canopy_model_tabs.dart';
import 'package:mobile/ui/core/theme.dart';

const _all = ValueKey('tab-all');
const _claude = ValueKey('tab-claude');

Future<List<int>> _pump(WidgetTester tester) async {
  final selected = <int>[];
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(
        body: Column(
          children: [
            CanopyModelTabs(
              tabs: const [
                CanopyModelTab(key: _all, label: 'All models'),
                CanopyModelTab(key: _claude, label: 'Claude'),
              ],
              selectedIndex: 0,
              onSelected: selected.add,
            ),
          ],
        ),
      ),
    ),
  );
  return selected;
}

void main() {
  testWidgets('the ripple covers the pill, not the whole touch target', (
    tester,
  ) async {
    await _pump(tester);

    for (final (key, label) in [(_all, 'All models'), (_claude, 'Claude')]) {
      final ink = find.descendant(
        of: find.byKey(key),
        matching: find.byType(InkWell),
      );
      // The pill pads its label by 12 horizontally and 6 vertically.
      final text = tester.getRect(find.text(label));
      final pill = Rect.fromLTRB(
        text.left - 12,
        text.top - 6,
        text.right + 12,
        text.bottom + 6,
      );
      expect(tester.getRect(ink), pill, reason: label);
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('a tap beside the pill still selects the tab', (tester) async {
    final selected = await _pump(tester);

    final target = tester.getRect(find.byKey(_claude));
    expect(target.height, greaterThanOrEqualTo(44));
    await tester.tapAt(Offset(target.center.dx, target.top + 2));
    expect(selected, [1]);
  });
}
