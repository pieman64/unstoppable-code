{
  'targets': [{
    'target_name': 'core_secret_protection',
    'sources': ['src/credential_slots_win32.c', 'src/credential_context_win32.c'],
    'defines': ['NAPI_VERSION=8', 'UNICODE', '_UNICODE', '_WIN32_WINNT=0x0602'],
    'libraries': ['advapi32.lib', 'secur32.lib'],
    'conditions': [['OS!="win"', { 'type': 'none' }]],
  }, {
    'target_name': 'credential_acl_fixture',
    'sources': ['src/credential_acl_fixture_win32.c', 'src/credential_context_win32.c'],
    'defines': ['NAPI_VERSION=8', 'UNICODE', '_UNICODE', '_WIN32_WINNT=0x0602'],
    'libraries': ['advapi32.lib', 'secur32.lib'],
    'conditions': [['OS!="win"', { 'type': 'none' }]],
  }, {
    'target_name': 'credential_fault_fixture',
    'sources': ['src/credential_fault_fixture_win32.c', 'src/credential_context_win32.c'],
    'defines': ['NAPI_VERSION=8', 'UNICODE', '_UNICODE', '_WIN32_WINNT=0x0602'],
    'libraries': ['advapi32.lib', 'secur32.lib'],
    'conditions': [['OS!="win"', { 'type': 'none' }]],
  }, {
    'target_name': 'credential_error_contract',
    'type': 'executable',
    'sources': ['src/credential_errors_win32.c', 'src/credential_context_win32.c'],
    'defines': ['UNICODE', '_UNICODE', '_WIN32_WINNT=0x0602'],
    'libraries': ['advapi32.lib', 'secur32.lib'],
    'conditions': [['OS!="win"', { 'type': 'none' }]],
  }],
}
