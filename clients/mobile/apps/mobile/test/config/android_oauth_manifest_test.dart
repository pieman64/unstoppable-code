import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

String extractOAuthCallbackActivity(String manifest) {
  final callbackActivity = RegExp(
    r'<activity\b'
    r'(?=[^>]*android:name="com\.linusu\.flutter_web_auth_2\.CallbackActivity")'
    r'[^>]*>[\s\S]*?<\/activity>',
  ).firstMatch(manifest)?.group(0);

  expect(callbackActivity, isNotNull);
  return callbackActivity!;
}

Set<String> extractHttpsOAuthHosts(String callbackActivity) {
  return RegExp(r'<data\b[^>]*>')
      .allMatches(callbackActivity)
      .map((match) => match.group(0)!)
      .where((element) => element.contains('android:scheme="https"'))
      .map(
        (element) =>
            RegExp(r'android:host="([^"]+)"').firstMatch(element)?.group(1),
      )
      .whereType<String>()
      .toSet();
}

Set<String> extractAppConfigOAuthHosts(String appConfigSource) {
  final hostSet = RegExp(
    r'_mobileOAuthAppLinkHosts\s*=\s*\{([\s\S]*?)\};',
  ).firstMatch(appConfigSource)?.group(1);

  expect(hostSet, isNotNull);
  return RegExp(
    r"'([^']+)'",
  ).allMatches(hostSet!).map((match) => match.group(1)!).toSet();
}

/// Every intent filter a browser can resolve must present the brand name.
///
/// Android's `ResolveInfo.loadLabel()` prefers the **intent-filter** label over
/// the activity and application labels, so a filter-level label is what a
/// browser shows in its `wants to open the external app <name>` prompt. A
/// missing or library-named label leaks an implementation detail into that
/// prompt.
void expectBrandedBrowsableLabels(String manifest) {
  final filters = RegExp(
    r'<intent-filter[\s\S]*?</intent-filter>',
  ).allMatches(manifest).map((match) => match.group(0)!);

  final browsable = filters.where(
    (filter) => filter.contains('android.intent.category.BROWSABLE'),
  );

  expect(
    browsable,
    isNotEmpty,
    reason: 'no browser-resolvable intent filter found to check',
  );

  for (final filter in browsable) {
    final label = RegExp(
      r'<intent-filter[^>]*android:label="([^"]*)"',
    ).firstMatch(filter)?.group(1);

    expect(
      label,
      '@string/app_name',
      reason:
          'a browser-resolvable intent filter must be labelled with the '
          'brand string, not "$label"',
    );
  }
}

void main() {
  test('OAuth callback activity uses branded, isolated Android metadata', () {
    final manifest = File(
      'android/app/src/main/AndroidManifest.xml',
    ).readAsStringSync();
    final callbackActivity = extractOAuthCallbackActivity(manifest);

    expect(callbackActivity, contains('android:label="@string/app_name"'));
    expect(callbackActivity, contains('android:taskAffinity=""'));
    expect(
      callbackActivity,
      contains('<intent-filter android:label="@string/app_name">'),
    );
    expect(
      callbackActivity,
      isNot(contains('android:label="flutter_web_auth_2"')),
    );
    expect(
      callbackActivity,
      contains(r'android:scheme="${oauthCallbackScheme}"'),
    );
    expect(
      RegExp(r'android:autoVerify="true"').allMatches(callbackActivity).length,
      2,
    );
    for (final host in ['app.unstoppable.ai', 'code.ud-staging.com']) {
      expect(callbackActivity, contains('android:host="$host"'));
    }
    const retiredProductionHost = 'code.unstoppabledomains.com';
    expect(
      callbackActivity,
      isNot(contains('android:host="$retiredProductionHost"')),
      reason:
          'the retired production host must not stay claimed as an App Link; '
          'server-side App Link compatibility remains only for already-installed '
          'releases while new builds migrate to app.unstoppable.ai',
    );
    expect(
      RegExp(
        r'android:path="/api/mobile/oauth-app-callback"',
      ).allMatches(callbackActivity).length,
      2,
    );
  });

  test('AppConfig OAuth hosts exactly match the Android manifest', () {
    final callbackActivity = extractOAuthCallbackActivity(
      File('android/app/src/main/AndroidManifest.xml').readAsStringSync(),
    );
    final appConfigSource = File(
      'lib/config/app_config.dart',
    ).readAsStringSync();

    expect(
      extractAppConfigOAuthHosts(appConfigSource),
      extractHttpsOAuthHosts(callbackActivity),
      reason:
          'AppConfig must only mint HTTPS callbacks that the Android manifest '
          'can intercept, and every claimed manifest host must be selectable',
    );
  });

  test('every browser-resolvable intent filter presents the brand name', () {
    expectBrandedBrowsableLabels(
      File('android/app/src/main/AndroidManifest.xml').readAsStringSync(),
    );
  });

  test('the brand-label check rejects the label a browser once showed', () {
    // Verbatim from the manifest as it stood before d460760c4 (2026-07-02).
    // Chrome rendered this filter label as the external app name, so its
    // consent prompt read "wants to open the external app flutter_web_auth_2".
    // Without this case the check above could pass vacuously.
    const regressedManifest = '''
<activity
    android:name="com.linusu.flutter_web_auth_2.CallbackActivity"
    android:exported="true">
    <intent-filter android:label="flutter_web_auth_2">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="canopy" />
    </intent-filter>
</activity>
''';

    expect(
      () => expectBrandedBrowsableLabels(regressedManifest),
      throwsA(isA<TestFailure>()),
    );
  });
}
