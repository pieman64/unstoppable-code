{
  'targets': [
    {
      # Keep node-gyp's defaults: the static CRT, and win_delay_load_hook,
      # which binds napi/uv imports to the host process. The daemon runs as a
      # renamed SEA executable, so the hook must stay on.
      'target_name': 'windows_pipe_security',
      'sources': ['src/pipe_security.c'],
      'defines': ['NAPI_VERSION=8'],
      'libraries': ['advapi32.lib'],
      'conditions': [
        ['OS!="win"', {
          # Windows-only: elsewhere the target compiles and links nothing.
          'type': 'none',
          'sources!': ['src/pipe_security.c'],
          'libraries!': ['advapi32.lib'],
        }],
      ],
    },
  ],
}
