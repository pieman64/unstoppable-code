import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_control.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/features/remote/view_models/remote_composer_effort.dart';

void main() {
  ModelOption row(
    String id, {
    required String provider,
    String? harness,
    List<String>? supported,
  }) => ModelOption(
    id: id,
    label: id,
    provider: provider,
    harness: harness,
    kind: 'model',
    available: true,
    supportedThinkingLevels: supported,
  );

  RemoteComposerEffort resolve({
    List<ModelOption> catalog = const [],
    String? modelId = 'm',
    String? executionHarness,
    String? providerType,
    String level = 'off',
    bool? pendingFast,
    String? speed,
    bool? fastMode,
  }) => RemoteComposerEffort.resolve(
    catalog: catalog,
    modelId: modelId,
    executionHarness: executionHarness,
    providerType: providerType,
    level: level,
    pendingFast: pendingFast,
    speed: speed,
    fastMode: fastMode,
  );

  group('provider hint', () {
    const codex = ['off', 'medium', 'high', 'xhigh'];
    const claude = ['off', 'medium', 'high', 'xhigh', 'max'];

    test('the chat harness wins over the row', () {
      final effort = resolve(
        catalog: [row('m', provider: 'claude', harness: 'claude')],
        executionHarness: 'codex',
        providerType: 'claude',
      );
      expect(effort.levels, codex);
    });

    test('then the row harness, the row provider and the chat provider', () {
      expect(
        resolve(
          catalog: [row('m', provider: 'claude', harness: 'codex')],
        ).levels,
        codex,
      );
      expect(resolve(catalog: [row('m', provider: 'cursor')]).levels, isEmpty);
      expect(resolve(providerType: 'copilot').levels, isEmpty);
      expect(resolve(providerType: 'claude').levels, claude);
    });
  });

  test('clamps the level to the levels', () {
    final catalog = [
      row('gpt-6-astra', provider: 'codex', supported: ['low', 'high']),
    ];
    expect(
      resolve(catalog: catalog, modelId: 'gpt-6-astra', level: 'medium').level,
      'low',
    );
    expect(
      resolve(catalog: catalog, modelId: 'gpt-6-astra', level: 'off').level,
      'low',
    );
  });

  group('speed', () {
    test('the exact speed wins over the legacy boolean', () {
      expect(
        resolve(speed: 'ultrafast', fastMode: false).speed,
        CanopyEffortSpeed.ultraFast,
      );
      expect(
        resolve(speed: 'standard', fastMode: true).speed,
        CanopyEffortSpeed.regular,
      );
      expect(
        resolve(speed: 'fast', fastMode: false).speed,
        CanopyEffortSpeed.fast,
      );
    });

    test('older hosts use the legacy boolean', () {
      expect(resolve(fastMode: true).speed, CanopyEffortSpeed.fast);
      expect(resolve(fastMode: false).speed, CanopyEffortSpeed.regular);
      expect(resolve().speed, CanopyEffortSpeed.regular);
    });

    test('a pending choice wins until the desktop settles it', () {
      expect(
        resolve(pendingFast: true, speed: 'standard').speed,
        CanopyEffortSpeed.fast,
      );
      expect(
        resolve(pendingFast: false, speed: 'fast').speed,
        CanopyEffortSpeed.regular,
      );
    });

    test('Ultra fast wins over a pending choice at once', () {
      for (final pendingFast in [true, false]) {
        expect(
          resolve(pendingFast: pendingFast, speed: 'ultrafast').speed,
          CanopyEffortSpeed.ultraFast,
          reason: 'pending Fast $pendingFast',
        );
      }
    });
  });
}
