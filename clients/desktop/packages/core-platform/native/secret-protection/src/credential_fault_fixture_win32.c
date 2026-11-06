/* Test-only build of the production entrypoint with deterministic failure/entry hooks. */
#include "credential_context_win32.h"
#include <node_api.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

static int fault = 0, erased_work = 0, erased_copy = 1, erased_credential = 0;
static void *copied_secret = NULL;
static size_t copied_size = 0;
static HANDLE waiting = NULL;
static void *fault_calloc(size_t count, size_t size);
static void audit_free(void *pointer);
static void audit_credential_free(PVOID pointer);
static napi_status fault_copy(napi_env env, size_t size, const void *data, void **copy, napi_value *value);
static napi_status fault_property(napi_env env, napi_value object, const char *name, napi_value value);
static napi_status fault_resolve(napi_env env, napi_deferred deferred, napi_value value);
static napi_status fault_queue(napi_env env, napi_async_work work);
static DWORD observe_wait(HANDLE handle, DWORD timeout);
static BOOL observe_write(volatile LONG *cancellation, PCREDENTIALW credential, DWORD flags);
#define calloc fault_calloc
#define free audit_free
#define CredFree audit_credential_free
#define napi_create_buffer_copy fault_copy
#define napi_set_named_property fault_property
#define napi_resolve_deferred fault_resolve
#define napi_queue_async_work fault_queue
#define WaitForSingleObject observe_wait
#define CredWriteW(credential, flags) observe_write(work->cancellation, credential, flags)
#define init slot_init
#undef NAPI_MODULE
#define NAPI_MODULE(name, callback)
#include "credential_slots_win32.c"
#undef init
#undef calloc
#undef free
#undef CredFree
#undef napi_create_buffer_copy
#undef napi_set_named_property
#undef napi_resolve_deferred
#undef napi_queue_async_work
#undef WaitForSingleObject
#undef CredWriteW

static int consume(int number) {
  if (fault != number) return 0;
  fault = 0;
  return 1;
}
static int all_zero(const void *data, size_t size) {
  const BYTE *bytes = (const BYTE *)data;
  size_t i;
  for (i = 0; i < size; ++i) if (bytes[i]) return 0;
  return 1;
}
static void *fault_calloc(size_t count, size_t size) {
  return consume(1) ? NULL : calloc(count, size);
}
static void audit_free(void *pointer) {
  if (pointer) erased_work = all_zero(pointer, sizeof(slot_work));
  if (copied_secret) erased_copy = all_zero(copied_secret, copied_size);
  copied_secret = NULL;
  free(pointer);
}
static void audit_credential_free(PVOID pointer) {
  PCREDENTIALW credential = (PCREDENTIALW)pointer;
  if (credential && credential->CredentialBlob && credential->CredentialBlobSize)
    erased_credential = all_zero(credential->CredentialBlob, credential->CredentialBlobSize);
  CredFree(pointer);
}
static napi_status fault_copy(napi_env env, size_t size, const void *data, void **copy, napi_value *value) {
  napi_status status;
  if (consume(2)) return napi_generic_failure;
  status = napi_create_buffer_copy(env, size, data, copy, value);
  if (status == napi_ok) { copied_secret = *copy; copied_size = size; }
  return status;
}
static napi_status fault_property(napi_env env, napi_value object, const char *name, napi_value value) {
  if (!strcmp(name, "material") && consume(3)) return napi_generic_failure;
  return napi_set_named_property(env, object, name, value);
}
static napi_status fault_resolve(napi_env env, napi_deferred deferred, napi_value value) {
  napi_status status;
  if (consume(4)) return napi_generic_failure;
  status = napi_resolve_deferred(env, deferred, value);
  /* A successfully returned copy belongs to JS, not the native cleanup path. */
  if (status == napi_ok) copied_secret = NULL;
  return status;
}
static napi_status fault_queue(napi_env env, napi_async_work work) {
  return consume(6) ? napi_generic_failure : napi_queue_async_work(env, work);
}
static BOOL observe_write(volatile LONG *cancellation, PCREDENTIALW credential, DWORD flags) {
  BOOL result = CredWriteW(credential, flags);
  /* Cancellation after submission cannot turn a landed write into a no-effect rejection. */
  if (consume(5)) InterlockedExchange(cancellation, 1);
  return result;
}
static DWORD observe_wait(HANDLE handle, DWORD timeout) {
  SetEvent(waiting);
  return WaitForSingleObject(handle, timeout);
}
static napi_value arm(napi_env env, napi_callback_info info) {
  napi_value argument, value;
  size_t argc = 1;
  int32_t number = 0;
  if (napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argument, &number) != napi_ok || number < 0 || number > 6) {
    napi_throw_type_error(env, NULL, "Invalid fault fixture mode."); return NULL;
  }
  fault = number; erased_work = erased_credential = 0; erased_copy = 1; copied_secret = NULL;
  ResetEvent(waiting);
  napi_get_undefined(env, &value); return value;
}
static napi_value audit(napi_env env, napi_callback_info info) {
  napi_value value, result;
  (void)info;
  napi_create_object(env, &result);
  napi_get_boolean(env, erased_work, &value); napi_set_named_property(env, result, "work", value);
  napi_get_boolean(env, erased_copy, &value); napi_set_named_property(env, result, "copy", value);
  napi_get_boolean(env, erased_credential, &value); napi_set_named_property(env, result, "credential", value);
  return result;
}
static napi_value wait_entry(napi_env env, napi_callback_info info) {
  napi_value value;
  (void)info;
  /* Only the fixture blocks JS, to observe the production worker's actual lock-wait entry. */
  napi_get_boolean(env, WaitForSingleObject(waiting, 2000) == WAIT_OBJECT_0, &value);
  return value;
}
static void cleanup(void *data) { (void)data; CloseHandle(waiting); waiting = NULL; }
NAPI_MODULE_INIT() {
  napi_value value, fn;
  waiting = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!waiting || !slot_init(env, exports) || napi_add_env_cleanup_hook(env, cleanup, NULL) != napi_ok) {
    if (waiting) cleanup(NULL);
    napi_throw_error(env, NULL, "Fault fixture initialization failed."); return NULL;
  }
  napi_get_boolean(env, true, &value); napi_set_named_property(env, exports, "fixture", value);
  napi_create_function(env, "arm", NAPI_AUTO_LENGTH, arm, NULL, &fn); napi_set_named_property(env, exports, "arm", fn);
  napi_create_function(env, "audit", NAPI_AUTO_LENGTH, audit, NULL, &fn); napi_set_named_property(env, exports, "audit", fn);
  napi_create_function(env, "waitEntry", NAPI_AUTO_LENGTH, wait_entry, NULL, &fn); napi_set_named_property(env, exports, "waitEntry", fn);
  return exports;
}
