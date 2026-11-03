import 'dart:async';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/services/ios_fold_regions.dart';
import 'package:mobile/ui/core/layout/ios_fold_region_scope.dart';

void main() {
  testWidgets('native geometry follows its view and clears on unfolding', (
    tester,
  ) async {
    final events = StreamController<IosFoldRegions>();
    addTearDown(events.close);
    const size = Size(951, 669);
    const fold = Rect.fromLTWH(455, 0, 41, 669);
    late MediaQueryData observed;
    await tester.pumpWidget(
      MaterialApp(
        home: MediaQuery(
          data: const MediaQueryData(size: size),
          child: IosFoldRegionScope(
            regions: events.stream,
            child: Builder(
              builder: (context) {
                observed = MediaQuery.of(context);
                return const SizedBox();
              },
            ),
          ),
        ),
      ),
    );
    events.add(
      IosFoldRegions.decode({
        'width': 951.0,
        'height': 669.0,
        'regions': [
          {'x': 455.0, 'y': 0.0, 'width': 41.0, 'height': 669.0},
        ],
      }),
    );
    await tester.pumpAndSettle();
    expect(observed.displayFeatures.single.bounds, fold);
    expect(observed.displayFeatures.single.type, DisplayFeatureType.fold);
    expect(
      observed.displayFeatures.single.state,
      DisplayFeatureState.postureHalfOpened,
    );

    events.add(const IosFoldRegions(size: Size(669, 951), regions: [fold]));
    await tester.pumpAndSettle();
    expect(
      observed.displayFeatures,
      isEmpty,
      reason: 'Ignore stale orientation',
    );
    events.add(const IosFoldRegions(size: size, regions: [fold]));
    await tester.pumpAndSettle();
    expect(observed.displayFeatures, hasLength(1));
    events.add(const IosFoldRegions(size: size, regions: []));
    await tester.pumpAndSettle();
    expect(observed.displayFeatures, isEmpty);
  });

  testWidgets(
    'engine fold data takes precedence over the compatibility bridge',
    (tester) async {
      final events = StreamController<IosFoldRegions>();
      addTearDown(events.close);
      const size = Size(951, 669);
      const feature = DisplayFeature(
        bounds: Rect.fromLTWH(450, 0, 51, 669),
        type: DisplayFeatureType.fold,
        state: DisplayFeatureState.postureHalfOpened,
      );
      late MediaQueryData observed;
      await tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: const MediaQueryData(size: size, displayFeatures: [feature]),
            child: IosFoldRegionScope(
              regions: events.stream,
              child: Builder(
                builder: (context) {
                  observed = MediaQuery.of(context);
                  return const SizedBox();
                },
              ),
            ),
          ),
        ),
      );
      events.add(
        const IosFoldRegions(
          size: size,
          regions: [Rect.fromLTWH(455, 0, 41, 669)],
        ),
      );
      await tester.pumpAndSettle();
      expect(observed.displayFeatures, [feature]);
    },
  );
}
