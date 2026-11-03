// Deterministic Android Material typography specimens, with real fonts.
// From apps/mobile, before editing production code and again after:
// flutter test tool/typography/capture_test.dart --update-goldens \
//   --dart-define=TYPOGRAPHY_STAGE=before
// Default stage is after. Produces light/dark images at 1x and 2x text scale.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/message_markdown.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const stage = String.fromEnvironment(
    'TYPOGRAPHY_STAGE',
    defaultValue: 'after',
  );
  const focusedOnly = bool.fromEnvironment('TYPOGRAPHY_FOCUSED_ONLY');
  setUpAll(() async {
    final manifest = File('build/unit_test_assets/FontManifest.json');
    // Font loading is explicit because widget tests otherwise use Ahem.
    for (final family in ['Inter', 'JetBrainsMono']) {
      final loader = FontLoader(family);
      final folder = family == 'Inter' ? 'inter' : 'jetbrains-mono';
      for (final suffix in ['', '-Italic']) {
        loader.addFont(
          rootBundle.load('assets/fonts/$folder/${family}Variable$suffix.ttf'),
        );
      }
      await loader.load();
    }
    expect(manifest.existsSync(), isTrue);
  });
  for (final dark in [false, true]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('typography ${dark ? 'dark' : 'light'} $scale', (
        tester,
      ) async {
        tester.view.physicalSize = const Size(390, 1000);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: Builder(
              builder: (context) => MediaQuery(
                data: MediaQuery.of(
                  context,
                ).copyWith(textScaler: TextScaler.linear(scale)),
                child: RepaintBoundary(
                  key: const Key('specimen'),
                  child: Scaffold(
                    appBar: AppBar(title: const Text('Workspace')),
                    body: ListView(
                      padding: const EdgeInsets.all(16),
                      children: [
                        RepaintBoundary(
                          key: const Key('changed-specimen'),
                          child: ColoredBox(
                            color: Theme.of(context).colorScheme.surface,
                            child: Padding(
                              padding: const EdgeInsets.all(8),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    'Sheet heading',
                                    style: stage == 'before'
                                        ? AppTypography.emphasis.copyWith(
                                            fontSize: 18,
                                            height: 28 / 18,
                                          )
                                        : AppTypography.heading,
                                  ),
                                  Text(
                                    'Compact metadata · 42 files',
                                    style: stage == 'before'
                                        ? AppTypography.emphasis.copyWith(
                                            fontSize: 11,
                                            height: 12 / 11,
                                          )
                                        : AppTypography.compactLabel,
                                  ),
                                  Text(
                                    'Small body supporting text',
                                    style: AppTypography.bodySmall,
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 16),
                        Text(
                          'Your projects',
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                        const SizedBox(height: 16),
                        Text(
                          'Recent activity',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        Text(
                          'Updated a few minutes ago',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                        const SizedBox(height: 16),
                        const MessageMarkdown(
                          text:
                              '## Ready for review\nUpdated **text styles** with *italic emphasis*.\nRun `flutter test` to verify.\n```dart\nfinal ready = true;\n```',
                        ),
                        const SizedBox(height: 16),
                        const TextField(
                          decoration: InputDecoration(
                            labelText: 'Message',
                            hintText: 'Describe your task',
                          ),
                        ),
                        const SizedBox(height: 16),
                        FilledButton(
                          onPressed: () {},
                          child: const Text('Continue'),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        if (!focusedOnly) {
          await expectLater(
            find.byKey(const Key('specimen')),
            matchesGoldenFile(
              '../../../../.playwright/mobile-typography/specimen-$stage-${dark ? 'dark' : 'light'}-${scale.toInt()}x.png',
            ),
          );
        }
        await expectLater(
          find.byKey(const Key('changed-specimen')),
          matchesGoldenFile(
            '../../../../.playwright/mobile-typography/changed-specimen-$stage-${dark ? 'dark' : 'light'}-${scale.toInt()}x.png',
          ),
        );
        expect(tester.takeException(), isNull);
      });
    }
  }
}
