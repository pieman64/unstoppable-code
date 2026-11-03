import 'package:flutter/foundation.dart';
import 'package:mobile/data/protocol/generated/account.dart';
import 'package:mobile/data/repositories/profile_repository.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

/// Handles profile mutations. Currently just the display name; avatar upload
/// and other fields land here in later slices.
final class ProfileViewModel extends ChangeNotifier with DisposeSafeNotifier {
  ProfileViewModel({required this.repository});

  final ProfileRepository repository;

  bool _isSaving = false;
  Object? _error;

  /// True while an update is in flight.
  bool get isSaving => _isSaving;

  /// Non-null when the most recent update failed.
  Object? get error => _error;

  /// Updates the display [name]. Returns the canonical server response on
  /// success, or `null` on failure (see [error]).
  Future<UpdateProfileResponse?> updateName(String name) async {
    _isSaving = true;
    _error = null;
    notifyListenersSafe();
    try {
      return await repository.updateName(name);
    } catch (e) {
      _error = e;
      return null;
    } finally {
      _isSaving = false;
      notifyListenersSafe();
    }
  }
}
