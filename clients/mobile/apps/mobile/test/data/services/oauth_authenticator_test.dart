import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/oauth_authenticator.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('flutter_web_auth_2');
  const authenticator = WebAuthOAuthenticator();

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('returns null when the browser authentication is canceled', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          channel,
          (_) => throw PlatformException(
            code: 'CANCELED',
            message: 'User canceled authentication',
          ),
        );

    final result = await authenticator.authenticate(
      authorizeUrl: 'https://example.com/authorize',
      callbackUrl: 'canopy://auth',
    );

    expect(result, isNull);
  });

  test('propagates non-cancellation browser authentication failures', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          channel,
          (_) => throw PlatformException(
            code: 'NO_BROWSER',
            message: 'No valid browser available for authentication',
          ),
        );

    await expectLater(
      authenticator.authenticate(
        authorizeUrl: 'https://example.com/authorize',
        callbackUrl: 'https://example.com/api/mobile/oauth-app-callback',
      ),
      throwsA(
        isA<PlatformException>().having(
          (error) => error.code,
          'code',
          'NO_BROWSER',
        ),
      ),
    );
  });
}
