{
  'targets': [
    {
      # Test-only (supervision-owned-child.windows.test.ts); never staged.
      'target_name': 'owned_child_probe',
      'sources': ['owned_child_probe.c'],
      'defines': ['NAPI_VERSION=8'],
      'libraries': ['user32.lib'],
      'conditions': [
        ['OS!="win"', {
          'type': 'none',
          'sources!': ['owned_child_probe.c'],
          'libraries!': ['user32.lib'],
        }],
      ],
    },
  ],
}
