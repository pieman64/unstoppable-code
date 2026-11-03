// Native lifecycle driver for remote_keyboard_recovery_test.dart.
// KEYBOARD_TEST_ADB=/path/to/adb KEYBOARD_TEST_DEVICE=emulator-5554 \
// flutter drive --driver=test_driver/keyboard_recovery.dart \
//   --target=integration_test/remote_keyboard_recovery_test.dart \
//   --dart-define=INTERRUPT_KEYBOARD=true -d emulator-5554
import 'dart:async';
import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

Future<void> main() async {
  final adb = Platform.environment['KEYBOARD_TEST_ADB'] ?? 'adb';
  final device = Platform.environment['KEYBOARD_TEST_DEVICE'];
  if (device == null) throw StateError('Set KEYBOARD_TEST_DEVICE explicitly');
  Future<void> runAdb(List<String> args) async {
    final result = await Process.run(adb, ['-s', device, ...args]);
    if (result.exitCode != 0) throw StateError('${result.stderr}');
  }

  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 18765);
  await runAdb(['reverse', 'tcp:18765', 'tcp:18765']);
  final subscription = server.listen((request) async {
    try {
      if (request.method != 'POST' || request.uri.path != '/cycle') {
        request.response.statusCode = 404;
        return;
      }
      final delay = int.parse(request.uri.queryParameters['delayMs']!);
      if (delay < 0 || delay > 500) throw ArgumentError('Invalid delay');
      await Future<void>.delayed(Duration(milliseconds: delay));
      await runAdb([
        'shell',
        'am',
        'start',
        '-a',
        'android.intent.action.MAIN',
        '-c',
        'android.intent.category.HOME',
      ]);
      await Future<void>.delayed(const Duration(seconds: 2));
      await runAdb([
        'shell',
        'am',
        'start',
        '--activity-single-top',
        '--activity-reorder-to-front',
        '-n',
        'com.unstoppabledomains.canopy/.MainActivity',
      ]);
      request.response.write('resumed');
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
    await runAdb(['reverse', '--remove', 'tcp:18765']);
  }

  try {
    await integrationDriver(
      writeResponseOnFailure: true,
      responseDataCallback: (data) async {
        await writeResponseData(
          data,
          testOutputFilename: 'keyboard-lifecycle-$device',
        );
        if (data?['cycleCount'] == null) {
          final directory = Directory('build/keyboard-recovery');
          await directory.create(recursive: true);
          final capture = await Process.run('android', [
            'screen',
            'capture',
            '--device',
            device,
            '-o',
            '${directory.path}/failure-$device.png',
          ]);
          if (capture.exitCode != 0) stderr.writeln(capture.stderr);
          final ime = await Process.run(adb, [
            '-s',
            device,
            'shell',
            'dumpsys',
            'input_method',
          ]);
          await File(
            '${directory.path}/ime-$device.txt',
          ).writeAsString('${ime.stdout}');
        }
        // integrationDriver exits the process after this callback.
        await cleanup();
      },
      onScreenshot: (name, bytes, [args]) async {
        final file = File('build/keyboard-recovery/$name.png');
        await file.parent.create(recursive: true);
        await file.writeAsBytes(bytes);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
}
