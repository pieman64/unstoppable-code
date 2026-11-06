/* Test-only handle holder over the production mutex constructor. Never packaged. */
#include "credential_context_win32.h"
#include <node_api.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

typedef struct { HANDLE handle; int owned; } held_mutex;
static void close_mutex(held_mutex *held) {
  if (!held || !held->handle) return;
  if (held->owned) ReleaseMutex(held->handle);
  CloseHandle(held->handle);
  held->handle = NULL;
}
static void finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  close_mutex((held_mutex *)data);
  free(data);
}
static napi_value hold(napi_env env, napi_callback_info info) {
  napi_value args[3], external;
  size_t argc = 3, size = 0;
  WCHAR name[128], sid[192];
  bool owned = false;
  held_mutex *held = NULL;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 3 ||
      napi_get_value_string_utf16(env, args[0], (char16_t *)name, 128, &size) != napi_ok || size < 1 || size >= 127 ||
      napi_get_value_string_utf16(env, args[1], (char16_t *)sid, 192, &size) != napi_ok || size < 1 || size >= 191 ||
      napi_get_value_bool(env, args[2], &owned) != napi_ok || strcmp(credential_context(sid), "unknown")) goto failed;
  held = (held_mutex *)calloc(1, sizeof(*held));
  if (!held || strcmp(credential_mutex(name, sid, &held->handle), "ok")) goto failed;
  if (owned) {
    DWORD result = WaitForSingleObject(held->handle, 0);
    if (result != WAIT_OBJECT_0 && result != WAIT_ABANDONED) goto failed;
    held->owned = 1;
  }
  if (napi_create_external(env, held, finalize, NULL, &external) == napi_ok) return external;
failed:
  close_mutex(held); free(held);
  napi_throw_error(env, NULL, "Mutex fixture refused."); return NULL;
}
static napi_value release(napi_env env, napi_callback_info info) {
  napi_value arg, result;
  size_t argc = 1;
  void *held = NULL;
  if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_external(env, arg, &held) != napi_ok) {
    napi_throw_type_error(env, NULL, "Invalid mutex fixture handle."); return NULL;
  }
  close_mutex((held_mutex *)held);
  napi_get_undefined(env, &result); return result;
}
static napi_value corrupt(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  size_t argc = 2, size = 0;
  WCHAR target[512], sid[192];
  CREDENTIALW credential;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2 ||
      napi_get_value_string_utf16(env, args[0], (char16_t *)target, 512, &size) != napi_ok || size < 1 || size >= 511 ||
      napi_get_value_string_utf16(env, args[1], (char16_t *)sid, 192, &size) != napi_ok || size < 1 || size >= 191 ||
      strcmp(credential_context(sid), "unknown")) {
    napi_throw_error(env, NULL, "Corrupt-slot fixture refused."); return NULL;
  }
  ZeroMemory(&credential, sizeof(credential));
  credential.Type = CRED_TYPE_GENERIC;
  credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
  credential.TargetName = target;
  /* Only the qualification fixture can create this malformed zero-byte item. */
  if (!CredWriteW(&credential, 0)) {
    napi_throw_error(env, NULL, "Corrupt-slot fixture write failed."); return NULL;
  }
  napi_get_undefined(env, &result); return result;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_value fn, fixture;
  napi_create_function(env, "holdMutex", NAPI_AUTO_LENGTH, hold, NULL, &fn);
  napi_set_named_property(env, exports, "holdMutex", fn);
  napi_create_function(env, "releaseMutex", NAPI_AUTO_LENGTH, release, NULL, &fn);
  napi_set_named_property(env, exports, "releaseMutex", fn);
  napi_create_function(env, "corruptSlot", NAPI_AUTO_LENGTH, corrupt, NULL, &fn);
  napi_set_named_property(env, exports, "corruptSlot", fn);
  napi_get_boolean(env, true, &fixture);
  napi_set_named_property(env, exports, "fixture", fixture);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
