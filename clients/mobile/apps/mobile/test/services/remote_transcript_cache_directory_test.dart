// CAN-3373: the transcript cache lives in app-private application support
// storage; on iOS it is used only once Complete data protection is applied.
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/services/remote_transcript_cache_directory.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel(kRemoteTranscriptProtectionChannel);
  late Directory support;
  final calls = <MethodCall>[];

  setUp(() {
    support = Directory.systemTemp.createTempSync('can3373-support');
    calls.clear();
  });
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    support.deleteSync(recursive: true);
  });

  void answer(Object? Function(MethodCall call) reply) =>
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add(call);
            return reply(call);
          });

  Future<Directory> resolve() =>
      remoteTranscriptCacheDirectory(applicationSupport: () async => support);

  test('Android uses a directory inside application support', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    answer((_) => true);
    final directory = await resolve();
    expect(directory.path, '${support.path}/remote-transcripts');
    expect(directory.existsSync(), isTrue);
    expect(calls, isEmpty);
  });

  test(
    'iOS asks the native side to create and protect the directory',
    () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      answer((_) => true);
      final directory = await resolve();
      expect(directory.path, '${support.path}/remote-transcripts');
      expect(calls.single.method, 'protectDirectory');
      expect(calls.single.arguments, {'path': directory.path});
    },
  );

  test('iOS without verified protection gets no directory', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    answer((_) => false);
    await expectLater(resolve(), throwsA(isA<FileSystemException>()));

    answer((_) => throw PlatformException(code: 'LOCKED'));
    await expectLater(resolve(), throwsA(isA<PlatformException>()));

    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    await expectLater(resolve(), throwsA(isA<MissingPluginException>()));
    expect(Directory('${support.path}/remote-transcripts').existsSync(), false);
  });
}
