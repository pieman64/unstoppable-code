{
  'targets': [
    {
      # Windows only; Darwin builds src/owned_child.c with clang directly
      # (scripts/build-owned-child.mjs). Keep node-gyp's defaults: the static
      # CRT, and win_delay_load_hook, which binds napi imports to the host
      # process, so one addon loads in electron.exe, node.exe and the renamed
      # SEA CLI.
      'target_name': 'core_owned_child',
      'sources': [
        'src/owned_child_win.c',
        'src/confined_read_win.c',
        'src/recycle_item_win.c',
      ],
      'defines': ['NAPI_VERSION=8'],
      'libraries': ['advapi32.lib', 'ole32.lib', 'shell32.lib', 'uuid.lib'],
      'conditions': [
        ['OS!="win"', {
          'type': 'none',
          'sources!': [
            'src/owned_child_win.c',
            'src/confined_read_win.c',
            'src/recycle_item_win.c',
          ],
          'libraries!': ['advapi32.lib', 'ole32.lib', 'shell32.lib', 'uuid.lib'],
        }],
      ],
    },
  ],
}
