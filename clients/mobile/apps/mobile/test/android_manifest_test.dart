import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  final manifest = File(
    'android/app/src/main/AndroidManifest.xml',
  ).readAsStringSync();

  test('declares camera hardware as optional', () {
    expect(
      manifest,
      contains(
        '<uses-feature android:name="android.hardware.camera" '
        'android:required="false" />',
      ),
    );
  });

  test('disables PostHog auto-init so main() controls setup', () {
    expect(
      manifest,
      matches(
        RegExp(
          r'<meta-data\s+android:name="com\.posthog\.posthog\.AUTO_INIT"\s+'
          r'android:value="false"\s*/>',
        ),
      ),
    );
  });
}
