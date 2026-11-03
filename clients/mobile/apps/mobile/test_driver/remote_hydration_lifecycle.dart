// Native lifecycle driver for can_3631_hydration_lifecycle_test.dart. It
// sends the app to the background on request, waits on the host, then
// brings the same app process back to the foreground.
//
// Android:
//   HYDRATION_TEST_PLATFORM=android HYDRATION_TEST_DEVICE=emulator-5554 \
//   HYDRATION_TEST_ADB=/path/to/adb \
//   flutter drive --driver=test_driver/remote_hydration_lifecycle.dart \
//     --target=integration_test/can_3631_hydration_lifecycle_test.dart \
//     --dart-define=CAN3631_SCENARIO=ac1-standalone -d emulator-5554
//
// iOS simulator (loopback reaches the host without a reverse):
//   HYDRATION_TEST_PLATFORM=ios HYDRATION_TEST_DEVICE=<simulator UDID> \
//   flutter drive ... -d <simulator UDID>
import 'dart:async';
import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

const _port = 18766;
const _appId = 'com.unstoppabledomains.canopy';

Future<void> main() async {
  final platform = Platform.environment['HYDRATION_TEST_PLATFORM'];
  final device = Platform.environment['HYDRATION_TEST_DEVICE'];
  final adb = Platform.environment['HYDRATION_TEST_ADB'] ?? 'adb';
  if (platform != 'android' && platform != 'ios') {
    throw StateError('Set HYDRATION_TEST_PLATFORM to android or ios');
  }
  if (device == null || !RegExp(r'^[A-Za-z0-9._:-]+$').hasMatch(device)) {
    throw StateError('Set HYDRATION_TEST_DEVICE to an explicit device id');
  }
  final android = platform == 'android';

  Future<void> run(String executable, List<String> args) async {
    final result = await Process.run(executable, args);
    if (result.exitCode != 0) {
      throw StateError('$executable ${args.join(' ')}: ${result.stderr}');
    }
  }

  Future<void> runAdb(List<String> args) => run(adb, ['-s', device, ...args]);

  Future<void> background() => android
      ? runAdb([
          'shell',
          'am',
          'start',
          '-a',
          'android.intent.action.MAIN',
          '-c',
          'android.intent.category.HOME',
        ])
      : run('xcrun', ['simctl', 'launch', device, 'com.apple.Preferences']);

  // Brings the running app forward without restarting it.
  Future<void> foreground() => android
      ? runAdb([
          'shell',
          'am',
          'start',
          '--activity-single-top',
          '--activity-reorder-to-front',
          '-n',
          '$_appId/.MainActivity',
        ])
      : run('xcrun', ['simctl', 'launch', device, _appId]);

  final cycles = <Map<String, Object?>>[];
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, _port);
  if (android) await runAdb(['reverse', 'tcp:$_port', 'tcp:$_port']);
  final subscription = server.listen((request) async {
    try {
      if (request.method != 'POST' || request.uri.path != '/background') {
        request.response.statusCode = 404;
        return;
      }
      final seconds = int.parse(request.uri.queryParameters['seconds']!);
      if (seconds < 1 || seconds > 300) throw ArgumentError('Invalid wait');
      // Answer first: the app cannot read a reply while it is suspended.
      request.response.write('scheduled');
      unawaited(() async {
        final cycle = <String, Object?>{'awaySeconds': seconds};
        cycles.add(cycle);
        try {
          await Future<void>.delayed(const Duration(milliseconds: 500));
          await background();
          cycle['backgroundedAt'] = DateTime.now().toUtc().toIso8601String();
          await Future<void>.delayed(Duration(seconds: seconds));
          await foreground();
          cycle['foregroundedAt'] = DateTime.now().toUtc().toIso8601String();
        } catch (error) {
          cycle['error'] = '$error';
        }
      }());
    } catch (error) {
      request.response.statusCode = 500;
      request.response.write(error);
    } finally {
      await request.response.close();
    }
  });
  var cleanedUp = false;
  Future<void> cleanup() async {
    if (cleanedUp) return;
    cleanedUp = true;
    await subscription.cancel();
    await server.close(force: true);
    if (android) await runAdb(['reverse', '--remove', 'tcp:$_port']);
  }

  try {
    await integrationDriver(
      writeResponseOnFailure: true,
      responseDataCallback: (data) async {
        await writeResponseData({
          ...?data,
          'hostCycles': cycles,
          'platform': platform,
        }, testOutputFilename: 'can3631-lifecycle-$platform-$device');
        // integrationDriver exits the process after this callback.
        await cleanup();
      },
      onScreenshot: (name, bytes, [args]) async {
        final file = File('build/promo_screenshots/$name.png');
        await file.parent.create(recursive: true);
        await file.writeAsBytes(bytes);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
}
