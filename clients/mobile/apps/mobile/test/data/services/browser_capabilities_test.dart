import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/browser_capabilities.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel(PlatformBrowserCapabilities.channelName);
  const capabilities = PlatformBrowserCapabilities();

  void answerWith(Future<Object?> Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, handler);
  }

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('reports support when the host browser advertises Auth Tab', () async {
    answerWith((call) async {
      expect(call.method, 'supportsHttpsAuthTabRedirect');
      return true;
    });

    expect(await capabilities.supportsHttpsAuthTabRedirect(), isTrue);
  });

  test('reports no support when the host browser lacks Auth Tab', () async {
    answerWith((_) async => false);

    expect(await capabilities.supportsHttpsAuthTabRedirect(), isFalse);
  });

  test('reports no support when the host platform has no channel', () async {
    // iOS and any future platform without the handler: the safe answer is the
    // custom scheme, which every browser can hand back to the app.
    answerWith((_) async => throw MissingPluginException('no handler'));

    expect(await capabilities.supportsHttpsAuthTabRedirect(), isFalse);
  });

  test('reports no support when the capability probe fails', () async {
    answerWith(
      (_) async => throw PlatformException(code: 'ERROR', message: 'boom'),
    );

    expect(await capabilities.supportsHttpsAuthTabRedirect(), isFalse);
  });

  test('reports no support when the channel returns a non-boolean', () async {
    answerWith((_) async => 'unexpected');

    expect(await capabilities.supportsHttpsAuthTabRedirect(), isFalse);
  });
}
