import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/install_beacon_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  InstallBeaconService service({
    required http.Client client,
    InstallBeaconPlatform platform = InstallBeaconPlatform.ios,
    String baseUrl = 'https://code.example.com',
  }) {
    return InstallBeaconService(
      baseUrlProvider: () => baseUrl,
      httpClient: client,
      platformOverride: platform,
    );
  }

  test('reports the first launch once and marks the install', () async {
    final requests = <http.Request>[];
    final client = MockClient((request) async {
      requests.add(request);
      return http.Response('', 204);
    });

    await service(client: client).reportFirstLaunchIfNeeded();

    expect(requests, hasLength(1));
    expect(
      requests.single.url.toString(),
      'https://code.example.com/api/download/track',
    );
    expect(jsonDecode(requests.single.body), {
      'platform': 'ios',
      'source': 'app-first-launch',
    });

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool(InstallBeaconService.preferenceKey), isTrue);
  });

  test('sends no identifier the backend could tie to a person', () async {
    late http.Request captured;
    final client = MockClient((request) async {
      captured = request;
      return http.Response('', 204);
    });

    await service(client: client).reportFirstLaunchIfNeeded();

    final body = jsonDecode(captured.body) as Map<String, dynamic>;
    expect(body.keys, unorderedEquals(['platform', 'source']));
    expect(captured.headers.containsKey('Authorization'), isFalse);
  });

  test(
    'resolves the beacon path when the base URL has a trailing slash',
    () async {
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response('', 204);
      });

      await service(
        client: client,
        baseUrl: 'https://code.example.com/',
      ).reportFirstLaunchIfNeeded();

      expect(
        captured.url.toString(),
        'https://code.example.com/api/download/track',
      );
    },
  );

  test('reports android when that is the host platform', () async {
    late http.Request captured;
    final client = MockClient((request) async {
      captured = request;
      return http.Response('', 204);
    });

    await service(
      client: client,
      platform: InstallBeaconPlatform.android,
    ).reportFirstLaunchIfNeeded();

    expect(jsonDecode(captured.body), containsPair('platform', 'android'));
  });

  test('does not report again once the install is marked', () async {
    var calls = 0;
    final client = MockClient((_) async {
      calls += 1;
      return http.Response('', 204);
    });

    await service(client: client).reportFirstLaunchIfNeeded();
    await service(client: client).reportFirstLaunchIfNeeded();
    await service(client: client).reportFirstLaunchIfNeeded();

    expect(calls, 1);
  });

  test('retries on a later launch when the first attempt fails', () async {
    var calls = 0;
    final failing = MockClient((_) async {
      calls += 1;
      throw const SocketExceptionStub();
    });

    await service(client: failing).reportFirstLaunchIfNeeded();

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool(InstallBeaconService.preferenceKey), isNull);

    final succeeding = MockClient((_) async {
      calls += 1;
      return http.Response('', 204);
    });
    await service(client: succeeding).reportFirstLaunchIfNeeded();

    expect(calls, 2);
    expect(prefs.getBool(InstallBeaconService.preferenceKey), isTrue);
  });

  test(
    'does not mark the install when the server rejects the beacon',
    () async {
      final client = MockClient((_) async => http.Response('nope', 500));

      await service(client: client).reportFirstLaunchIfNeeded();

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getBool(InstallBeaconService.preferenceKey), isNull);
    },
  );

  test('stays silent when no API base URL is configured', () async {
    var calls = 0;
    final client = MockClient((_) async {
      calls += 1;
      return http.Response('', 204);
    });

    await service(client: client, baseUrl: '  ').reportFirstLaunchIfNeeded();

    expect(calls, 0);
  });

  test('never throws out of a failing launch path', () async {
    final client = MockClient((_) async => throw StateError('boom'));

    await expectLater(
      service(client: client).reportFirstLaunchIfNeeded(),
      completes,
    );
  });

  test('android marker delegates to the native no-backup channel', () async {
    const channel = MethodChannel(
      'com.unstoppabledomains.canopy/install_beacon',
    );
    final methods = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          methods.add(call.method);
          return call.method == 'hasReported';
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );

    final store = AndroidNoBackupInstallBeaconMarkerStore();

    expect(await store.hasReported(), isTrue);
    await store.markReported();
    expect(methods, ['hasReported', 'markReported']);
  });
}

/// Stands in for a network failure without importing `dart:io` into the test.
final class SocketExceptionStub implements Exception {
  const SocketExceptionStub();
}
