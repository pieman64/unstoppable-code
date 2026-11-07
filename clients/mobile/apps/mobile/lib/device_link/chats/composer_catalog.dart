import 'package:mobile/data/models/composer_plugins.dart';
import '../protocol.dart';

List<Map<String, dynamic>> _rows(Object? value) {
  if (value is! List) throw const FormatException('Missing composer catalog');
  return value.map(deviceLinkObject).toList();
}

/// Projects existing desktop catalogs into the shared mobile picker. Provider
/// support is supplied by the computer, using the same flags as the Portal
/// picker. Paths, install state and credentials are not presentation data.
ComposerPluginCatalog deviceComposerCatalog({
  required Object? collections,
  required Object? skills,
  required Object? plugins,
  required Object? servers,
}) {
  final marketplaces = _rows(deviceLinkObject(plugins)['marketplaces']);
  final serverRows = _rows(deviceLinkObject(servers)['servers']);
  return ComposerPluginCatalog.fromJson({
    'collections': _rows(collections),
    'skills': [
      for (final skill in _rows(skills))
        {
          'sourceId': skill['sourceId'],
          'skillName': skill['name'],
          'name': skill['name'],
          'description': skill['description'],
        },
    ],
    'plugins': [
      for (final marketplace in marketplaces)
        for (final plugin in _rows(marketplace['plugins']))
          {
            'marketplaceId': plugin['marketplaceId'],
            'pluginName': plugin['name'],
            'name': plugin['name'],
            'description': plugin['description'],
            // Missing support is unknown, not permission to enable a plugin.
            'claudeSupported':
                deviceLinkObject(plugin['providerSupport'])['claude'] ==
                'native',
            'codexSupported': switch (deviceLinkObject(
              plugin['providerSupport'],
            )['codex']) {
              'native' || 'compat' => true,
              _ => false,
            },
          },
    ],
    'mcpServers': [
      for (final server in serverRows)
        for (final config in _rows(server['configs']))
          if (config['enabled'] == true)
            {
              'serverId': server['id'],
              'serverName': server['name'],
              'configId': config['id'],
              'configName': config['name'],
              'description': server['description'],
            },
    ],
  });
}
