import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Info.plist disables PostHog auto-init', () {
    final plist = File('ios/Runner/Info.plist').readAsStringSync();
    expect(
      plist,
      matches(
        RegExp(r'<key>com\.posthog\.posthog\.AUTO_INIT</key>\s*<false/>'),
      ),
    );
  });

  test('privacy manifest declares anonymous product-interaction analytics', () {
    final manifest = File(
      'ios/Runner/PrivacyInfo.xcprivacy',
    ).readAsStringSync();
    expect(manifest, contains('<key>NSPrivacyTracking</key>\n\t<false/>'));
    expect(manifest, contains('NSPrivacyCollectedDataTypeProductInteraction'));
    expect(
      manifest,
      contains('<key>NSPrivacyCollectedDataTypeLinked</key>\n\t\t\t<false/>'),
    );
    expect(manifest, contains('NSPrivacyCollectedDataTypePurposeAnalytics'));
  });

  test('privacy manifest is bundled as a Runner resource', () {
    final project = File(
      'ios/Runner.xcodeproj/project.pbxproj',
    ).readAsStringSync();
    expect(project, contains('/* PrivacyInfo.xcprivacy in Resources */'));
    expect(
      project,
      contains('path = PrivacyInfo.xcprivacy; sourceTree = "<group>";'),
    );
  });
}
