import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Stores the auth session bearer token.
///
/// Exposes a synchronous [currentToken] cache so the [ApiClient] token provider
/// can attach `Authorization: Bearer` without awaiting storage on every request.
abstract interface class SessionStore {
  /// The cached token, available synchronously after [read] / [save].
  String? get currentToken;

  /// The cached two-factor proof (for 2FA users; sent as the
  /// `x-two-factor-verified` header), available synchronously after
  /// [read] / [save].
  String? get currentTwoFactorProof;

  /// Loads the token and two-factor proof from persistent storage into the
  /// synchronous caches. Returns the token.
  Future<String?> read();

  /// Persists [token] (and optional [twoFactorProof]) and updates the caches.
  /// A null [twoFactorProof] clears any previously stored proof.
  Future<void> save(String token, {String? twoFactorProof});

  /// Clears the token and two-factor proof from storage and the caches.
  Future<void> clear();
}

/// [SessionStore] backed by the platform keychain (iOS Keychain / Android
/// Keystore) via `flutter_secure_storage`.
final class SecureSessionStore implements SessionStore {
  SecureSessionStore({FlutterSecureStorage? storage})
    : _storage =
          storage ??
          const FlutterSecureStorage(
            aOptions: androidOptions,
            iOptions: iosOptions,
          );

  /// Migrate existing encrypted preferences to the v10 AES-GCM store. Keep the
  /// backup path disabled so v9 EncryptedSharedPreferences are imported first.
  /// Surface storage failures without erasing saved sessions.
  static const AndroidOptions androidOptions = AndroidOptions(
    migrateOnAlgorithmChange: true,
    migrateWithBackup: false,
    resetOnError: false,
  );

  /// Hardened iOS keychain accessibility: readable only after the device's
  /// first unlock since boot, and never migrated to another device via backup
  /// or iCloud (the `_this_device` variant).
  static const IOSOptions iosOptions = IOSOptions(
    accessibility: KeychainAccessibility.first_unlock_this_device,
  );

  static const String _key = 'canopy.session_token';
  static const String _proofKey = 'canopy.two_factor_proof';

  final FlutterSecureStorage _storage;
  String? _cached;
  String? _cachedProof;

  @override
  String? get currentToken => _cached;

  @override
  String? get currentTwoFactorProof => _cachedProof;

  @override
  Future<String?> read() async {
    _cached = await _storage.read(key: _key);
    _cachedProof = await _storage.read(key: _proofKey);
    return _cached;
  }

  @override
  Future<void> save(String token, {String? twoFactorProof}) async {
    _cached = token;
    _cachedProof = twoFactorProof;
    await _storage.write(key: _key, value: token);
    if (twoFactorProof == null) {
      await _storage.delete(key: _proofKey);
    } else {
      await _storage.write(key: _proofKey, value: twoFactorProof);
    }
  }

  @override
  Future<void> clear() async {
    _cached = null;
    _cachedProof = null;
    await _storage.delete(key: _key);
    await _storage.delete(key: _proofKey);
  }
}

/// In-memory [SessionStore] for tests and the mock auth path.
final class InMemorySessionStore implements SessionStore {
  InMemorySessionStore({String? initialToken, String? initialTwoFactorProof})
    : _cached = initialToken,
      _cachedProof = initialTwoFactorProof;

  String? _cached;
  String? _cachedProof;

  @override
  String? get currentToken => _cached;

  @override
  String? get currentTwoFactorProof => _cachedProof;

  @override
  Future<String?> read() async => _cached;

  @override
  Future<void> save(String token, {String? twoFactorProof}) async {
    _cached = token;
    _cachedProof = twoFactorProof;
  }

  @override
  Future<void> clear() async {
    _cached = null;
    _cachedProof = null;
  }
}
