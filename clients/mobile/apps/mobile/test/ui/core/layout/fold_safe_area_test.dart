import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/layout/fold_safe_area.dart';

void main() {
  testWidgets(
    'fold changes preserve focused draft and avoid the curved region',
    (tester) async {
      tester.view.physicalSize = const Size(951, 669);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final metrics = ValueNotifier(const MediaQueryData(size: Size(951, 669)));
      final controller = TextEditingController();
      final focus = FocusNode();
      addTearDown(metrics.dispose);
      addTearDown(controller.dispose);
      addTearDown(focus.dispose);
      final screen = Scaffold(
        body: TextField(controller: controller, focusNode: focus),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: ValueListenableBuilder(
            valueListenable: metrics,
            builder: (_, media, child) => MediaQuery(
              data: media,
              child: FoldSafeArea(child: child!),
            ),
            child: screen,
          ),
        ),
      );
      await tester.enterText(find.byType(TextField), 'Keep this draft');
      final state = tester.state(find.byType(Scaffold));
      metrics.value = const MediaQueryData(
        size: Size(951, 669),
        padding: EdgeInsets.only(right: 84),
        viewPadding: EdgeInsets.only(right: 84, bottom: 34),
        viewInsets: EdgeInsets.only(bottom: 264),
        displayFeatures: [
          DisplayFeature(
            bounds: Rect.fromLTWH(455, 0, 41, 669),
            type: DisplayFeatureType.fold,
            state: DisplayFeatureState.postureHalfOpened,
          ),
        ],
      );
      await tester.pump();
      expect(tester.getRect(find.byType(Scaffold)).right, 455);
      final folded = MediaQuery.of(tester.element(find.byType(Scaffold)));
      expect(folded.size, const Size(455, 669));
      expect(folded.viewPadding.right, 0);
      expect(folded.viewInsets.bottom, 264);
      expect(folded.displayFeatures, isEmpty);
      expect(tester.state(find.byType(Scaffold)), same(state));
      expect(focus.hasFocus, isTrue);
      expect(controller.text, 'Keep this draft');

      metrics.value = const MediaQueryData(
        size: Size(951, 669),
        displayFeatures: [
          DisplayFeature(
            bounds: Rect.fromLTWH(475.5, 0, 0, 669),
            type: DisplayFeatureType.fold,
            state: DisplayFeatureState.postureFlat,
          ),
        ],
      );
      await tester.pump();
      expect(tester.getSize(find.byType(Scaffold)).width, 951);
      expect(tester.state(find.byType(Scaffold)), same(state));
      expect(controller.text, 'Keep this draft');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('horizontal fold subtracts keyboard space outside the pane', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(669, 951);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      const MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(
            size: Size(669, 951),
            viewPadding: EdgeInsets.only(top: 82, bottom: 34),
            viewInsets: EdgeInsets.only(bottom: 495.5),
            displayFeatures: [
              DisplayFeature(
                bounds: Rect.fromLTWH(0, 455, 669, 41),
                type: DisplayFeatureType.fold,
                state: DisplayFeatureState.postureHalfOpened,
              ),
            ],
          ),
          child: FoldSafeArea(child: Scaffold(body: Text('Conversation'))),
        ),
      ),
    );
    final media = MediaQuery.of(tester.element(find.byType(Scaffold)));
    expect(media.size, const Size(669, 455));
    expect(media.viewPadding.top, 82);
    expect(media.viewInsets.bottom, 0);
    expect(tester.getRect(find.byType(Scaffold)).bottom, 455);
    expect(tester.takeException(), isNull);
  });
}
