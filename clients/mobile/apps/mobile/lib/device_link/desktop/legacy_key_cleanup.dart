import 'saved_connection.dart';

/// Removes only the API key recorded by earlier Computer connect builds.
/// Identity and pairing pins live in a separate store and are never changed.
final class LegacyComputerConnectKeyCleanup {
  LegacyComputerConnectKeyCleanup({
    required this.saved,
    required this.revoke,
    required this.persist,
  });

  final SavedComputerConnection saved;
  final Future<void> Function(String id) revoke;
  final Future<void> Function() persist;
  bool _running = false;

  Future<void> run() async {
    if (_running || (saved.credential == null && !saved.creatingCredential)) {
      return;
    }
    _running = true;
    final credential = saved.credential;
    final creating = saved.creatingCredential;
    try {
      if (credential != null) await revoke(credential.id);
      if (!identical(saved.credential, credential)) return;
      // An interrupted create without a stored response cannot identify a key.
      // Clear only its marker; never search for or revoke unrelated keys.
      saved.credential = null;
      saved.creatingCredential = false;
      try {
        await persist();
      } catch (_) {
        // Keep the retry state in memory as well as on disk. A later discovery
        // retries the idempotent revocation (not-found is success) and save.
        saved.credential = credential;
        saved.creatingCredential = creating;
      }
    } catch (_) {
      // Revocation failed; the recorded key remains available for a retry.
    } finally {
      _running = false;
    }
  }
}
