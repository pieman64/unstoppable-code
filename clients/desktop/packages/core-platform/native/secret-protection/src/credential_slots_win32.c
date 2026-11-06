#include "credential_context_win32.h"
#include <node_api.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

/* No CredUI, DPAPI fallback, enumeration, diagnostics or reset path. */
typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  napi_ref cancellation_ref;
  napi_ref completion_error_ref;
  volatile LONG *cancellation;
  char operation[16];
  WCHAR target[512], mutex[128], principal[192];
  BYTE input[1024], output[1024];
  size_t input_size, output_size;
  const char *code;
} slot_work;

static int cancelled(slot_work *work) {
  return InterlockedCompareExchange(work->cancellation, 0, 0) != 0;
}

static void free_credential(PCREDENTIALW credential) {
  if (!credential) return;
  if (credential->CredentialBlob && credential->CredentialBlobSize)
    SecureZeroMemory(credential->CredentialBlob, credential->CredentialBlobSize);
  CredFree(credential);
}

static void execute(napi_env env, void *data) {
  slot_work *work = (slot_work *)data;
  HANDLE mutex = NULL;
  PCREDENTIALW existing = NULL;
  ULONGLONG deadline = GetTickCount64() + 5000;
  int acquired = 0, present = 0;
  (void)env;
  if (cancelled(work)) { work->code = "cancelled"; return; }
  if (strcmp(work->code, "unknown") != 0) return;
  work->code = credential_context(work->principal);
  if (strcmp(work->code, "unknown") != 0 || strcmp(work->operation, "status") == 0) return;
  if (cancelled(work)) { work->code = "cancelled"; return; }
  work->code = credential_mutex(work->mutex, work->principal, &mutex);
  if (!mutex) return;
  for (;;) {
    DWORD waited;
    if (cancelled(work)) { work->code = "cancelled"; goto done; }
    waited = WaitForSingleObject(mutex, 25);
    if (waited == WAIT_OBJECT_0 || waited == WAIT_ABANDONED) { acquired = 1; break; }
    if (waited != WAIT_TIMEOUT) { work->code = "unavailable"; goto done; }
    if (GetTickCount64() >= deadline) { work->code = "unavailable"; goto done; }
  }
  /* After abandonment the credential set, not the previous owner's memory, is authoritative. */
  if (cancelled(work)) { work->code = "cancelled"; goto done; }
  work->code = credential_context(work->principal);
  if (strcmp(work->code, "unknown") != 0) goto done;
  if (cancelled(work)) { work->code = "cancelled"; goto done; }
  /* Only cooperating mutex holders share create/replace atomicity (C-12). */
  if (CredReadW(work->target, CRED_TYPE_GENERIC, 0, &existing)) present = 1;
  else {
    work->code = credential_error(GetLastError());
    if (strcmp(work->code, "absent") != 0) goto done;
  }
  if (strcmp(work->operation, "read") == 0) {
    if (!present) { work->code = "absent"; goto done; }
    if (existing->Persist != CRED_PERSIST_LOCAL_MACHINE || existing->CredentialBlobSize < 1 ||
        existing->CredentialBlobSize > 1024 || !existing->CredentialBlob) { work->code = "corrupt"; goto done; }
    work->output_size = existing->CredentialBlobSize;
    memcpy(work->output, existing->CredentialBlob, work->output_size);
    work->code = "ok";
    goto done;
  }
  /* q-27 accepts the check/OS-entry race; await entered calls despite abort. */
  if (cancelled(work)) { work->code = "cancelled"; goto done; }
  if (strcmp(work->operation, "delete") == 0) {
    if (!present) work->code = "absent";
    else if (CredDeleteW(work->target, CRED_TYPE_GENERIC, 0)) work->code = "ok";
    else {
      work->code = credential_error(GetLastError());
      if (strcmp(work->code, "unavailable") == 0) work->code = "uncertain";
    }
  } else if ((strcmp(work->operation, "create") == 0 && present) ||
             (strcmp(work->operation, "replace") == 0 && !present)) work->code = "conflict";
  else {
    CREDENTIALW credential;
    ZeroMemory(&credential, sizeof(credential));
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = work->target;
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    credential.CredentialBlob = work->input;
    credential.CredentialBlobSize = (DWORD)work->input_size;
    if (CredWriteW(&credential, 0)) work->code = "ok";
    else {
      work->code = credential_error(GetLastError());
      if (strcmp(work->code, "unavailable") == 0 || strcmp(work->code, "absent") == 0)
        work->code = "uncertain";
    }
    SecureZeroMemory(&credential, sizeof(credential));
  }
done:
  free_credential(existing);
  if (acquired) ReleaseMutex(mutex);
  CloseHandle(mutex);
  SecureZeroMemory(work->input, sizeof(work->input));
}

static void complete(napi_env env, napi_status status, void *data) {
  slot_work *work = (slot_work *)data;
  napi_value result, code, bytes;
  void *copied = NULL;
  if (status != napi_ok) work->code = "uncertain";
  {
    int ok = napi_create_object(env, &result) == napi_ok &&
      napi_create_string_utf8(env, work->code, NAPI_AUTO_LENGTH, &code) == napi_ok &&
      napi_set_named_property(env, result, "code", code) == napi_ok;
    if (ok && strcmp(work->code, "ok") == 0 && work->output_size)
      ok = napi_create_buffer_copy(env, work->output_size, work->output, &copied, &bytes) == napi_ok &&
        napi_set_named_property(env, result, "material", bytes) == napi_ok;
    if (ok) ok = napi_resolve_deferred(env, work->deferred, result) == napi_ok;
    if (!ok) {
      napi_value error;
      bool pending = false;
      /* A failed property/settlement must not strand a secret in an unreturned Buffer. */
      if (copied) SecureZeroMemory(copied, work->output_size);
      if (napi_is_exception_pending(env, &pending) == napi_ok && pending &&
          napi_get_and_clear_last_exception(env, &error) == napi_ok)
        napi_reject_deferred(env, work->deferred, error);
      else if (napi_get_reference_value(env, work->completion_error_ref, &error) == napi_ok)
        napi_reject_deferred(env, work->deferred, error);
    }
  }
  napi_delete_reference(env, work->cancellation_ref);
  napi_delete_reference(env, work->completion_error_ref);
  napi_delete_async_work(env, work->work);
  SecureZeroMemory(work, sizeof(*work));
  free(work);
}

static int wide(napi_env env, napi_value value, WCHAR *out, size_t capacity) {
  size_t size = 0, copied = 0;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &size) != napi_ok || !size || size >= capacity ||
      napi_get_value_string_utf16(env, value, (char16_t *)out, capacity, &copied) != napi_ok || copied != size) return 0;
  return wcslen(out) == size;
}

static napi_value run(napi_env env, napi_callback_info info) {
  napi_value args[6], promise, name, buffer, message, error;
  size_t argc = 6, length = 0, operation_size = 0, offset = 0;
  bool detachable = true;
  napi_typedarray_type type;
  void *bytes = NULL;
  slot_work *work = (slot_work *)calloc(1, sizeof(slot_work));
  if (!work) { napi_throw_error(env, NULL, "Secret protection allocation failed."); return NULL; }
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 6 ||
      napi_get_value_string_utf8(env, args[0], NULL, 0, &operation_size) != napi_ok ||
      !operation_size || operation_size >= sizeof(work->operation) ||
      napi_get_value_string_utf8(env, args[0], work->operation, sizeof(work->operation), &length) != napi_ok ||
      operation_size != length || strlen(work->operation) != length ||
      (strcmp(work->operation, "status") && strcmp(work->operation, "read") && strcmp(work->operation, "create") &&
       strcmp(work->operation, "replace") && strcmp(work->operation, "delete")) ||
      !wide(env, args[1], work->target, 512) || !wide(env, args[2], work->mutex, 128) ||
      !wide(env, args[4], work->principal, 192) ||
      napi_get_typedarray_info(env, args[3], &type, &length, &bytes, &buffer, &offset) != napi_ok ||
      type != napi_uint8_array || length > 1024 ||
      ((!strcmp(work->operation, "create") || !strcmp(work->operation, "replace")) && length < 1)) goto invalid;
  work->input_size = length;
  if (length) memcpy(work->input, bytes, length);
  if (napi_get_typedarray_info(env, args[5], &type, &length, &bytes, &buffer, &offset) != napi_ok ||
      type != napi_uint32_array || length != 1 || !bytes ||
      napi_is_arraybuffer(env, buffer, &detachable) != napi_ok || detachable) goto invalid;
  /* Only SharedArrayBuffer is safe: retaining a typed array cannot prevent ArrayBuffer transfer. */
  work->cancellation = (volatile LONG *)bytes;
  if (napi_create_reference(env, args[5], 1, &work->cancellation_ref) != napi_ok) goto invalid;
  /* Completion may fail to allocate: reserve its bounded rejection before dispatch. */
  if (napi_create_string_utf8(env, "Secret protection completion failed.", NAPI_AUTO_LENGTH, &message) != napi_ok ||
      napi_create_error(env, NULL, message, &error) != napi_ok ||
      napi_create_reference(env, error, 1, &work->completion_error_ref) != napi_ok) goto invalid;
  /* Capture the calling thread's context before libuv changes threads. */
  work->code = credential_context(work->principal);
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "credential-slot", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, execute, complete, work, &work->work) != napi_ok ||
      napi_queue_async_work(env, work->work) != napi_ok) goto invalid;
  return promise;
invalid:
  if (work->work) napi_delete_async_work(env, work->work);
  if (work->cancellation_ref) napi_delete_reference(env, work->cancellation_ref);
  if (work->completion_error_ref) napi_delete_reference(env, work->completion_error_ref);
  SecureZeroMemory(work, sizeof(*work));
  free(work);
  napi_throw_type_error(env, NULL, "Invalid secret protection call.");
  return NULL;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn, fixture, abi;
  if (napi_create_function(env, "run", NAPI_AUTO_LENGTH, run, NULL, &fn) != napi_ok ||
      napi_set_named_property(env, exports, "run", fn) != napi_ok ||
      napi_get_boolean(env, 0, &fixture) != napi_ok ||
      napi_set_named_property(env, exports, "fixture", fixture) != napi_ok ||
      napi_create_string_utf8(env, "windows-credential-v1", NAPI_AUTO_LENGTH, &abi) != napi_ok ||
      napi_set_named_property(env, exports, "abi", abi) != napi_ok) {
    napi_throw_error(env, NULL, "Secret protection initialization failed.");
    return NULL;
  }
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
