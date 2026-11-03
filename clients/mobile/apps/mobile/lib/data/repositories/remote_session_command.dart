/// Submits a payload-only command on the paired session and returns its
/// command id, throwing when it is rejected.
typedef RemoteSessionCommandSubmit =
    Future<String> Function({
      required String type,
      required Map<String, dynamic> payload,
    });
