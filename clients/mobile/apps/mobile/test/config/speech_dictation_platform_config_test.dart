import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/brand/brand.g.dart';

/// The composer mic runs on `speech_to_text`, which needs both iOS usage
/// descriptions and the Android microphone permission plus recognizer
/// visibility. A missing entry crashes iOS on the first tap and silently
/// returns "unavailable" on Android 11+, so the config is pinned here.
void main() {
  group('speech dictation platform config', () {
    test('iOS declares microphone and speech recognition usage', () {
      final plist = File('ios/Runner/Info.plist').readAsStringSync();
      for (final key in [
        'NSMicrophoneUsageDescription',
        'NSSpeechRecognitionUsageDescription',
      ]) {
        final value = RegExp(
          '<key>$key</key>\\s*<string>([^<]*)</string>',
        ).firstMatch(plist)?.group(1);
        expect(value, isNotNull, reason: '$key is missing');
        expect(value!.trim(), isNotEmpty, reason: '$key needs user copy');
        expect(value, contains(Brand.displayName));
      }
    });

    test('Android declares audio permissions and can see the recognizer', () {
      final manifest = File(
        'android/app/src/main/AndroidManifest.xml',
      ).readAsStringSync();
      expect(
        manifest,
        contains(
          '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
        ),
      );
      for (final permission in [
        'android.permission.BLUETOOTH',
        'android.permission.BLUETOOTH_ADMIN',
        'android.permission.BLUETOOTH_CONNECT',
      ]) {
        expect(
          manifest,
          contains('android:name="$permission"'),
          reason: '$permission is required for Bluetooth headset dictation',
        );
      }
      final queries = RegExp(
        r'<queries>[\s\S]*?</queries>',
      ).firstMatch(manifest)?.group(0);
      expect(queries, isNotNull);
      expect(
        queries,
        contains('<action android:name="android.speech.RecognitionService"'),
      );
    });
  });
}
