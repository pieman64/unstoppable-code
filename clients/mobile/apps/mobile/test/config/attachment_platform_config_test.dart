import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/brand/brand.g.dart';

/// Attaching from the composer runs on `image_picker`/`file_picker`, which
/// need both iOS usage descriptions and the Android camera permission plus
/// capture-intent visibility. A missing entry crashes iOS on the first tap
/// and makes the camera source silently unavailable on Android 11+, so the
/// config is pinned here — and the iOS strings must be brand-generated
/// (`scripts/brand/generate-mobile-brand.mjs`), never hard-coded, because the
/// permission prompt is the first place a user reads the app's name.
void main() {
  group('attachment platform config', () {
    test('iOS does not bundle legacy location-capable picker libraries', () {
      for (final workspace in [
        'ios/Runner.xcworkspace',
        'ios/Runner.xcodeproj/project.xcworkspace',
      ]) {
        final resolved =
            jsonDecode(
                  File(
                    '$workspace/xcshareddata/swiftpm/Package.resolved',
                  ).readAsStringSync(),
                )
                as Map<String, dynamic>;
        final identities = (resolved['pins'] as List).map(
          (pin) => pin['identity'] as String,
        );
        for (final library in [
          'dkcamera',
          'dkimagepickercontroller',
          'dkphotogallery',
        ]) {
          expect(
            identities,
            isNot(contains(library)),
            reason:
                '$workspace: $library triggers unnecessary App Store privacy requirements',
          );
        }
      }
    });

    test('iOS declares camera and photo library usage', () {
      final plist = File('ios/Runner/Info.plist').readAsStringSync();
      for (final key in [
        'NSCameraUsageDescription',
        'NSPhotoLibraryUsageDescription',
      ]) {
        final value = RegExp(
          '<key>$key</key>\\s*<string>([^<]*)</string>',
        ).firstMatch(plist)?.group(1);
        expect(value, isNotNull, reason: '$key is missing');
        expect(value!.trim(), isNotEmpty, reason: '$key needs user copy');
        expect(
          value,
          contains(Brand.displayName),
          reason: '$key must come from the brand generator',
        );
      }
    });

    test('Android declares the camera permission and capture intent', () {
      final manifest = File(
        'android/app/src/main/AndroidManifest.xml',
      ).readAsStringSync();
      expect(
        manifest,
        contains(
          '<uses-permission android:name="android.permission.CAMERA" />',
        ),
      );
      final queries = RegExp(
        r'<queries>[\s\S]*?</queries>',
      ).firstMatch(manifest)?.group(0);
      expect(queries, isNotNull);
      expect(
        queries,
        contains('<action android:name="android.media.action.IMAGE_CAPTURE"'),
        reason: 'the camera source is invisible on Android 11+ without it',
      );
      // One merged <queries> block: a second one is a manifest-merger error,
      // and the camera intent must live in the block the recognizer uses.
      expect(RegExp('<queries>').allMatches(manifest), hasLength(1));
    });
  });
}
