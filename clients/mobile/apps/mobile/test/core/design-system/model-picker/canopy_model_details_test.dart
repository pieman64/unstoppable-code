// Model details facts at phone widths and text scale 2, measured with the real
// Inter font. The default test font has different glyph widths, so a label
// that breaks mid-word on a device only reproduces with the shipped font.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/model-picker/canopy_model_details.dart';
import 'package:mobile/ui/core/theme.dart';

Future<void> _loadInter() async {
  final bytes = ByteData.sublistView(
    await File('assets/fonts/inter/InterVariable.ttf').readAsBytes(),
  );
  await (FontLoader('Inter')..addFont(Future.value(bytes))).load();
}

const _facts = [
  ('Provider', 'Anthropic'),
  ('Harness', 'Claude Code'),
  ('Reasoning', 'Allows reasoning'),
  ('Context', '1M'),
];

void main() {
  setUpAll(_loadInter);

  // The long-press sheet is full width; the Design system screen adds 16.
  for (final (width, inset) in [(360.0, 0.0), (411.0, 16.0)]) {
    testWidgets('fact labels stay on one line at ${width.toInt()} px and '
        'text scale 2', (tester) async {
      tester.view.physicalSize = Size(width, 844);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: SingleChildScrollView(
              padding: EdgeInsets.symmetric(horizontal: inset),
              child: const CanopyModelDetails(
                title: 'Claude Opus',
                facts: _facts,
                description: 'Deep reasoning for long tasks.',
              ),
            ),
          ),
        ),
      );

      // One body line is 20 px tall, so 40 px at text scale 2.
      for (final (label, value) in _facts) {
        expect(tester.getSize(find.text(label)).height, 40, reason: label);
        expect(find.text(value), findsOneWidget);
      }
      expect(tester.takeException(), isNull);
    });
  }
}
