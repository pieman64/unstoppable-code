import 'dart:ui';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_platform_interface/test.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:firebase_crashlytics_platform_interface/firebase_crashlytics_platform_interface.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/services/crash_reporting.dart';

void main() {
  // Every test installs global handlers, so each one must restore whatever
  // the test binding had in place or later tests inherit the fake.
  late FlutterExceptionHandler? previousFlutterOnError;
  late FlutterExceptionHandler previousFlutterPresenter;
  late ErrorCallback? previousPlatformOnError;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    TestFirebaseCoreHostApi.setUp(_FakeFirebaseCoreHostApi());
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(MethodChannelFirebaseCrashlytics.channel, (
          MethodCall call,
        ) async {
          _firebaseMethodCalls.add(call);
          return null;
        });
    await Firebase.initializeApp();
  });

  setUp(() {
    previousFlutterOnError = FlutterError.onError;
    previousFlutterPresenter = FlutterError.presentError;
    previousPlatformOnError = PlatformDispatcher.instance.onError;
    _firebaseMethodCalls.clear();
  });

  tearDown(() {
    FlutterError.onError = previousFlutterOnError;
    FlutterError.presentError = previousFlutterPresenter;
    PlatformDispatcher.instance.onError = previousPlatformOnError;
  });

  test('records uncaught framework errors as fatal', () {
    // Chaining is the point of installCrashHandlers, so the chain must end in
    // a sink this test owns. Left as flutter_test's own onError, the forwarded
    // error prints an "EXCEPTION CAUGHT BY FLUTTER FRAMEWORK" dump that reads
    // like a failure and would mask a real one.
    FlutterError.onError = (_) {};

    final reporter = FakeCrashReporter();
    installCrashHandlers(reporter: reporter);

    final details = FlutterErrorDetails(
      exception: StateError('boom'),
      stack: StackTrace.current,
    );
    FlutterError.onError!(details);

    expect(reporter.flutterErrors, hasLength(1));
    expect(reporter.flutterErrors.single.exception, isA<StateError>());
  });

  test('chains to the previously installed FlutterError.onError', () {
    final seenByPrevious = <FlutterErrorDetails>[];
    FlutterError.onError = seenByPrevious.add;

    final reporter = FakeCrashReporter();
    installCrashHandlers(reporter: reporter);

    final details = FlutterErrorDetails(exception: StateError('boom'));
    FlutterError.onError!(details);

    expect(
      seenByPrevious,
      hasLength(1),
      reason:
          'the pre-existing handler must still run so debug console '
          'output and red-screen behavior survive',
    );
    expect(reporter.flutterErrors, hasLength(1));
  });

  test(
    'Firebase reporter presents framework errors only through the previous handler',
    () async {
      var presentationCount = 0;
      FlutterError.presentError = (_) => presentationCount++;
      FlutterError.onError = FlutterError.presentError;

      installCrashHandlers(
        reporter: FirebaseCrashReporter(
          crashlytics: FirebaseCrashlytics.instance,
        ),
      );

      FlutterError.onError!(
        FlutterErrorDetails(
          exception: StateError('boom'),
          stack: StackTrace.current,
          context: ErrorDescription('while testing Crashlytics'),
          informationCollector: () sync* {
            yield ErrorDescription('extra framework detail');
          },
        ),
      );
      await Future<void>.delayed(Duration.zero);

      expect(presentationCount, 1);
      final recordCall = _firebaseMethodCalls.singleWhere(
        (call) => call.method == 'Crashlytics#recordError',
      );
      expect(recordCall.arguments['fatal'], isTrue);
      expect(
        recordCall.arguments['reason'],
        contains('while testing Crashlytics'),
      );
      expect(
        recordCall.arguments['information'],
        contains('extra framework detail'),
      );
    },
  );

  test('records uncaught async errors as fatal and marks them handled', () {
    final reporter = FakeCrashReporter();
    installCrashHandlers(reporter: reporter);

    final stack = StackTrace.current;
    final handled = PlatformDispatcher.instance.onError!(
      ArgumentError('async boom'),
      stack,
    );

    expect(handled, isTrue);
    expect(reporter.errors, hasLength(1));
    expect(reporter.errors.single.error, isA<ArgumentError>());
    expect(reporter.errors.single.stack, same(stack));
    expect(reporter.errors.single.fatal, isTrue);
  });

  test('still reports when the previous async handler returns false', () {
    PlatformDispatcher.instance.onError = (_, _) => false;

    final reporter = FakeCrashReporter();
    installCrashHandlers(reporter: reporter);

    final handled = PlatformDispatcher.instance.onError!(
      ArgumentError('async boom'),
      StackTrace.current,
    );

    expect(handled, isTrue);
    expect(reporter.errors, hasLength(1));
  });
}

final List<MethodCall> _firebaseMethodCalls = <MethodCall>[];

final class _FakeFirebaseCoreHostApi implements TestFirebaseCoreHostApi {
  CoreInitializeResponse get _response => CoreInitializeResponse(
    name: defaultFirebaseAppName,
    options: CoreFirebaseOptions(
      apiKey: 'test-api-key',
      projectId: 'test-project',
      appId: 'test-app',
      messagingSenderId: 'test-sender',
    ),
    pluginConstants: const {
      'plugins.flutter.io/firebase_crashlytics': {
        'isCrashlyticsCollectionEnabled': true,
      },
    },
  );

  @override
  Future<CoreInitializeResponse> initializeApp(
    String appName,
    CoreFirebaseOptions initializeAppRequest,
  ) async => _response;

  @override
  Future<List<CoreInitializeResponse>> initializeCore() async => [_response];

  @override
  Future<CoreFirebaseOptions> optionsFromResource() async => _response.options;
}
