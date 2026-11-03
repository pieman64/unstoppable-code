import 'dart:async';

import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';

/// Platform-agnostic contract over the underlying crash-reporting plugin
/// (Firebase Crashlytics), so [installCrashHandlers] is testable without
/// platform channels — the same seam [PushMessaging] provides for push.
abstract interface class CrashReporter {
  /// Records an uncaught error from the Flutter framework.
  void recordFlutterError(FlutterErrorDetails details);

  /// Records an error raised outside the framework, typically an uncaught
  /// asynchronous error surfaced through [PlatformDispatcher.onError].
  void recordError(Object error, StackTrace? stack, {required bool fatal});
}

/// [CrashReporter] backed by the real Firebase Crashlytics plugin.
///
/// Instantiating this is inert; it is only safe to *use* once
/// `Firebase.initializeApp()` has succeeded, which is why `main.dart` calls
/// [installCrashHandlers] inside the same guarded block.
final class FirebaseCrashReporter implements CrashReporter {
  /// Creates a reporter writing to the given [crashlytics] instance,
  /// defaulting to the singleton the plugin exposes.
  FirebaseCrashReporter({FirebaseCrashlytics? crashlytics})
    : _crashlytics = crashlytics ?? FirebaseCrashlytics.instance;

  final FirebaseCrashlytics _crashlytics;

  @override
  void recordFlutterError(FlutterErrorDetails details) {
    final information = details.informationCollector?.call() ?? const [];
    unawaited(
      _crashlytics.recordError(
        details.exceptionAsString(),
        details.stack,
        reason: details.context
            ?.toStringDeep(minLevel: DiagnosticLevel.info)
            .trim(),
        information: information,
        printDetails: false,
        fatal: true,
      ),
    );
  }

  @override
  void recordError(Object error, StackTrace? stack, {required bool fatal}) {
    unawaited(_crashlytics.recordError(error, stack, fatal: fatal));
  }
}

/// Routes uncaught Dart errors to [reporter].
///
/// Installs two global handlers:
///
/// * [FlutterError.onError] for errors the framework catches (build, layout,
///   paint, gesture callbacks).
/// * [PlatformDispatcher.onError] for uncaught asynchronous errors, which
///   never reach [FlutterError.onError] at all.
///
/// Both **chain to whatever handler was already installed** rather than
/// replacing it, so Flutter's default console logging and red-screen error
/// widgets keep working; reporting is added alongside existing behavior, not
/// in place of it. The async handler always returns `true` regardless of what
/// the previous one returned — the error has been reported, so re-raising it
/// to the platform would only duplicate it.
///
/// Native Android/iOS crashes need no wiring here: the Crashlytics SDK
/// captures them once the platform Firebase config is present.
void installCrashHandlers({required CrashReporter reporter}) {
  final previousFlutterOnError = FlutterError.onError;
  FlutterError.onError = (FlutterErrorDetails details) {
    reporter.recordFlutterError(details);
    previousFlutterOnError?.call(details);
  };

  final previousPlatformOnError = PlatformDispatcher.instance.onError;
  PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
    reporter.recordError(error, stack, fatal: true);
    previousPlatformOnError?.call(error, stack);
    return true;
  };
}

/// In-memory [CrashReporter] used in tests, recording every reported error
/// instead of sending it anywhere.
final class FakeCrashReporter implements CrashReporter {
  /// Framework errors passed to [recordFlutterError], in order.
  final List<FlutterErrorDetails> flutterErrors = <FlutterErrorDetails>[];

  /// Errors passed to [recordError], in order.
  final List<RecordedCrashError> errors = <RecordedCrashError>[];

  @override
  void recordFlutterError(FlutterErrorDetails details) {
    flutterErrors.add(details);
  }

  @override
  void recordError(Object error, StackTrace? stack, {required bool fatal}) {
    errors.add(RecordedCrashError(error: error, stack: stack, fatal: fatal));
  }
}

/// A single error captured by [FakeCrashReporter.recordError].
final class RecordedCrashError {
  /// Creates a record of one reported error.
  const RecordedCrashError({
    required this.error,
    required this.stack,
    required this.fatal,
  });

  /// The reported error object.
  final Object error;

  /// The stack trace reported alongside [error], if any.
  final StackTrace? stack;

  /// Whether the error was reported as fatal.
  final bool fatal;
}
