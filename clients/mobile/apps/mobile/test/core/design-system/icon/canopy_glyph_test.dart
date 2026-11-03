import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('exposes every app icon manifest glyph as a unique SVG asset', () async {
    expect(CanopyGlyph.values, hasLength(266));
    expect(
      CanopyGlyph.values.map((glyph) => glyph.assetPath).toSet(),
      hasLength(CanopyGlyph.values.length),
    );

    for (final glyph in CanopyGlyph.values) {
      expect(glyph.assetPath, startsWith('assets/icons/canopy/'));
      expect(glyph.assetPath, endsWith('.svg'));

      final data = await rootBundle.load(glyph.assetPath);
      final svg = utf8.decode(data.buffer.asUint8List());
      expect(svg, contains('<svg'));
      expect(svg, contains('width="24" height="24"'));
      expect(svg, contains('viewBox="'));
      expect(svg, isNot(contains('currentColor')));
      // Only the root's size is normalised; inner shapes must keep theirs.
      for (final rect in RegExp(r'<rect\b[^>]*>').allMatches(svg)) {
        expect(rect.group(0), contains('width="'), reason: glyph.assetPath);
        expect(rect.group(0), contains('height="'), reason: glyph.assetPath);
      }
    }
  });

  test('keeps representative desktop glyph names stable', () {
    expect(CanopyGlyph.agent.assetPath, endsWith('/agent.svg'));
    expect(CanopyGlyph.pullRequest.assetPath, endsWith('/pull-request.svg'));
    expect(
      CanopyGlyph.settingsGear2.assetPath,
      endsWith('/settings-gear-2.svg'),
    );
    expect(CanopyGlyph.apple.assetPath, endsWith('/apple.svg'));
    expect(CanopyGlyph.orbit.assetPath, endsWith('/orbit.svg'));
  });

  test('keeps every glyph name the app references', () {
    // Renaming or removing one of these breaks a mobile call site; the
    // manifest keys behind them must stay stable.
    const referenced = <String>{
      'agent',
      'apple',
      'apps',
      'archive',
      'arrowInbox',
      'arrowLeft',
      'arrowRotateClockwise',
      'arrowUp',
      'barsThree',
      'bell',
      'brain2',
      'bubblePlus',
      'buildings',
      'camera1',
      'chart4',
      'checkmark1',
      'chevronDownMedium',
      'chevronDownSmall',
      'chevronRightMedium',
      'chevronRightSmall',
      'chevronTopMedium',
      'circleQuestionmark',
      'claudeai',
      'clock',
      'cloud',
      'crossMedium',
      'crossSmall',
      'cursorClick',
      'dotGrid1x3Horizontal',
      'editBig',
      'electrocardiogram',
      'exclamationTriangle',
      'filter1',
      'folder1',
      'folderFilled',
      'globe2',
      'images1',
      'listBullets',
      'lock',
      'macbook',
      'magnifyingGlass',
      'map',
      'mergedSimple',
      'microphone',
      'minusSmall',
      'ollama',
      'openai',
      'orbit',
      'pageAttachment',
      'pencil',
      'play',
      'plusMedium',
      'plusSmall',
      'pullRequest',
      'pullRequestSimple',
      'replay',
      'settingsGear2',
      'sidebar',
      'sparkle',
      'squareChecklist',
      'stackedBarChart',
      'stop',
      'stopwatch',
      'trashCan',
      'user',
      'userAdd',
      'userGroup',
      'warningSign',
      'zap',
    };
    final names = CanopyGlyph.values.map((glyph) => glyph.name).toSet();
    expect(
      names.containsAll(referenced),
      isTrue,
      reason: 'missing: ${referenced.difference(names)}',
    );
  });

  testWidgets('flutter_svg can render every manifest glyph', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: SingleChildScrollView(
          child: Wrap(
            children: CanopyGlyph.values
                .map(
                  (glyph) =>
                      SvgPicture.asset(glyph.assetPath, width: 24, height: 24),
                )
                .toList(),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(SvgPicture), findsNWidgets(CanopyGlyph.values.length));
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'paints Lucide outline and filled states with the approved stroke',
    (tester) async {
      Future<Uint8List> paint(CanopyGlyph glyph) async {
        final svg = utf8.decode(
          (await rootBundle.load(glyph.assetPath)).buffer.asUint8List(),
        );
        expect(svg, contains('viewBox="0 0 24 24"'));
        expect(svg, contains('stroke-width="2"'));

        final key = GlobalKey();
        await tester.pumpWidget(
          Center(
            child: RepaintBoundary(
              key: key,
              child: SvgPicture.string(svg, width: 24, height: 24),
            ),
          ),
        );
        await tester.pumpAndSettle();

        final boundary =
            key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final bytes = await tester.runAsync(() async {
          final image = await boundary.toImage();
          final data = await image.toByteData();
          image.dispose();
          return data!.buffer.asUint8List();
        });
        return bytes!;
      }

      int paintedPixels(Uint8List rgba) {
        var count = 0;
        for (var alpha = 3; alpha < rgba.length; alpha += 4) {
          if (rgba[alpha] > 0) count++;
        }
        return count;
      }

      final outline = await paint(CanopyGlyph.zap);
      final filled = await paint(CanopyGlyph.zapFilled);

      expect(paintedPixels(outline), greaterThan(0));
      expect(paintedPixels(filled), greaterThan(paintedPixels(outline)));
    },
  );
}
