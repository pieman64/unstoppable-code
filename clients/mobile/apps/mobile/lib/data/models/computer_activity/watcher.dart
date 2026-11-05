/// Display-only Portal watcher projection. Unknown triggers and statuses stay
/// intact so newer desktops remain readable without a mobile release.
library;

class RemoteWatcher {
  const RemoteWatcher({
    required this.id,
    required this.projectId,
    required this.worktreeId,
    required this.chatId,
    required this.trigger,
    required this.status,
    this.targetKind,
    this.createdAt,
    this.followUpInstruction,
    this.deliveryError,
    this.display,
  });

  static RemoteWatcher? fromJson(Object? value, {String? localId}) {
    if (value is! Map<String, dynamic>) return null;
    final id = localId ?? _nonEmpty(value['id']);
    final projectId = _nonEmpty(value['projectId']);
    final worktreeId = _nonEmpty(value['worktreeId']);
    final chatId = _nonEmpty(value['chatId']);
    if (id == null ||
        projectId == null ||
        worktreeId == null ||
        chatId == null) {
      return null;
    }
    return RemoteWatcher(
      id: id,
      projectId: projectId,
      worktreeId: worktreeId,
      chatId: chatId,
      trigger: _string(value['trigger']) ?? 'unknown',
      status: _string(value['status']) ?? 'unknown',
      targetKind: _string(value['targetKind']),
      createdAt: _string(value['createdAt']),
      followUpInstruction: _string(value['followUpInstruction']),
      deliveryError: _string(value['deliveryError']),
      display: RemoteWatcherDisplay.fromJson(value['display']),
    );
  }

  final String id;
  final String projectId;
  final String worktreeId;
  final String chatId;
  final String trigger;
  final String status;
  final String? targetKind;
  final String? createdAt;
  final String? followUpInstruction;
  final String? deliveryError;
  final RemoteWatcherDisplay? display;

  bool get isVisible => status == 'active' || status == 'delivery_failed';

  Map<String, dynamic> toJson() => {
    'id': id,
    'projectId': projectId,
    'worktreeId': worktreeId,
    'chatId': chatId,
    'trigger': trigger,
    'status': status,
    'targetKind': ?targetKind,
    'createdAt': ?createdAt,
    'followUpInstruction': ?followUpInstruction,
    'deliveryError': ?deliveryError,
    'display': ?display?.toJson(),
  };
}

class RemoteWatcherDetail {
  const RemoteWatcherDetail({required this.label, required this.value});

  final String label;
  final String value;

  Map<String, dynamic> toJson() => {'label': label, 'value': value};
}

class RemoteWatcherOwnerDelegate {
  const RemoteWatcherOwnerDelegate({required this.name, this.detail});

  final String name;
  final String? detail;

  Map<String, dynamic> toJson() => {'name': name, 'detail': ?detail};
}

class RemoteWatcherGithubDisplay {
  const RemoteWatcherGithubDisplay({
    this.subtitle,
    this.filters = const [],
    this.samples = const [],
    this.totalCount,
  });

  final String? subtitle;
  final List<RemoteWatcherDetail> filters;
  final List<String> samples;
  final int? totalCount;

  Map<String, dynamic> toJson() => {
    'subtitle': ?subtitle,
    'filters': [for (final row in filters) row.toJson()],
    'samples': samples,
    'totalCount': ?totalCount,
  };
}

class RemoteWatcherDisplay {
  const RemoteWatcherDisplay({
    this.title,
    this.subtitle,
    this.watching,
    this.watchingSubtitle,
    this.status,
    this.details = const [],
    this.ownerDelegate,
    this.github,
  });

  static RemoteWatcherDisplay? fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final owner = value['ownerDelegate'];
    final github = value['github'];
    final count = github is Map<String, dynamic> ? github['totalCount'] : null;
    return RemoteWatcherDisplay(
      title: _string(value['title']),
      subtitle: _string(value['subtitle']),
      watching: _string(value['watching']),
      watchingSubtitle: _string(value['watchingSubtitle']),
      status: _string(value['status']),
      details: _details(value['details']),
      ownerDelegate: owner is Map<String, dynamic> && owner['name'] is String
          ? RemoteWatcherOwnerDelegate(
              name: _string(owner['name'])!,
              detail: _string(owner['detail']),
            )
          : null,
      github: github is Map<String, dynamic>
          ? RemoteWatcherGithubDisplay(
              subtitle: _string(github['subtitle']),
              filters: _details(github['filters']),
              samples: [
                if (github['samples'] case final List<Object?> samples)
                  ...samples.whereType<String>(),
              ],
              totalCount: count is num && count.isFinite ? count.toInt() : null,
            )
          : null,
    );
  }

  final String? title;
  final String? subtitle;
  final String? watching;
  final String? watchingSubtitle;
  final String? status;
  final List<RemoteWatcherDetail> details;
  final RemoteWatcherOwnerDelegate? ownerDelegate;
  final RemoteWatcherGithubDisplay? github;

  Map<String, dynamic> toJson() => {
    'title': ?title,
    'subtitle': ?subtitle,
    'watching': ?watching,
    'watchingSubtitle': ?watchingSubtitle,
    'status': ?status,
    'details': [for (final row in details) row.toJson()],
    'ownerDelegate': ?ownerDelegate?.toJson(),
    'github': ?github?.toJson(),
  };
}

List<RemoteWatcherDetail> _details(Object? raw) => [
  if (raw is List)
    for (final row in raw.whereType<Map<String, dynamic>>())
      if (row case {'label': final String label, 'value': final String value})
        RemoteWatcherDetail(label: label, value: value),
];

String? _string(Object? value) => value is String ? value : null;
String? _nonEmpty(Object? value) =>
    value is String && value.isNotEmpty ? value : null;
