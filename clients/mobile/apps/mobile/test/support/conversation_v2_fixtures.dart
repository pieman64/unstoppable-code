Map<String, dynamic> v2Message({
  String id = 'user-1',
  String request = 'r1',
  String role = 'USER',
  String text = 'hello agent',
  String? turnId = 'turn-1',
  int seq = 1,
}) => {
  'id': id,
  'seq': seq,
  'role': role,
  'content': text,
  'clientRequestId': request,
  'turnId': turnId,
  'createdAt': '2026-09-23T10:00:00Z',
  'updatedAt': '2026-09-23T10:00:00Z',
};
Map<String, dynamic> v2Turn({
  String id = 'turn-1',
  String request = 'r1',
  String status = 'QUEUED',
  String order = '1',
}) => {
  'turnId': id,
  'queueOrder': order,
  'clientRequestId': request,
  'userMessageId': 'user-$request',
  'inferenceRunId': status == 'QUEUED' ? null : 'run-$id',
  'assistantMessageId': null,
  'startedAt': null,
  'status': status,
};
Map<String, dynamic> v2Snapshot({
  String version = '0',
  String session = 'session-1',
  String status = 'OPEN',
  List<Map<String, dynamic>> messages = const [],
  List<Map<String, dynamic>> turns = const [],
  String? history,
}) => {
  'protocolVersion': 2,
  'sessionId': session,
  'stateVersion': version,
  'sessionStatus': status,
  'messages': messages,
  'turns': turns,
  'pendingTurnCount': turns
      .where((t) => t['status'] == 'RUNNING' || t['status'] == 'QUEUED')
      .length,
  'hasMoreHistory': history != null,
  'historyCursor': history,
  'eventAfter': 'event-$version',
  'streamResume': 'opaque:resume/$version+==',
};
Map<String, dynamic> v2Accepted(
  String request,
  String text, {
  String version = '1',
  String status = 'QUEUED',
  String session = 'session-1',
}) => {
  'protocolVersion': 2,
  'sessionId': session,
  'acceptedStateVersion': version,
  'turn': v2Turn(request: request, status: status),
  'message': v2Message(id: 'user-$request', request: request, text: text),
  'replayed': false,
};
