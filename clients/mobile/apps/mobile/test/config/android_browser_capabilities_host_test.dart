import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/browser_capabilities.dart';

/// The Android host answers [PlatformBrowserCapabilities]. There is no Kotlin
/// test harness in this workspace, so these assertions guard the wiring the
/// Dart side depends on: a matching channel name, a matching method name, and
/// the capability query itself.
void main() {
  final mainActivity = File(
    'android/app/src/main/kotlin/com/unstoppabledomains/canopy/MainActivity.kt',
  ).readAsStringSync();

  test('registers the browser-capabilities channel the Dart client calls', () {
    expect(
      mainActivity,
      contains('"${PlatformBrowserCapabilities.channelName}"'),
    );
    expect(mainActivity, contains('"supportsHttpsAuthTabRedirect"'));
  });

  test('answers from the Custom Tabs provider, not a browser version', () {
    // A version-number heuristic goes stale every time a browser ships Auth
    // Tab support; androidx asks the resolved provider directly.
    expect(mainActivity, contains('CustomTabsClient.isAuthTabSupported'));
    expect(mainActivity, contains('CustomTabsClient.getPackageName'));
  });

  test('declares androidx.browser so the capability query resolves', () {
    final buildGradle = File('android/app/build.gradle.kts').readAsStringSync();

    expect(buildGradle, contains('androidx.browser:browser'));
  });
}
