#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <softpub.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <node_api.h>
#include "migration_image_win.h"

// W2 is inert. The held file denies write/delete sharing; unit T must have
// pinned this same file before launch, not merely hashed this pathname later.
typedef struct {
  const void *owner;
  HANDLE process;
  HANDLE file;
} image_pin;
static const napi_type_tag IMAGE_TAG = {0x5732696d61676570ULL, 0x696e763100000001ULL};

static void close_pin(image_pin *pin) {
  if (pin->file) CloseHandle(pin->file);
  if (pin->process) CloseHandle(pin->process);
  pin->file = pin->process = NULL;
}
static void finalize_pin(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  close_pin(data);
  free(data);
}
static napi_value nothing(napi_env env) {
  napi_value result;
  napi_get_null(env, &result);
  return result;
}
static void text(napi_env env, napi_value result, const char *key, const char *str) {
  napi_value value;
  napi_create_string_utf8(env, str, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, key, value);
}
static void wide(napi_env env, napi_value result, const char *key, const wchar_t *str, size_t size) {
  napi_value value;
  napi_create_string_utf16(env, (const char16_t *)str, size, &value);
  napi_set_named_property(env, result, key, value);
}
static void hex(const BYTE bytes[32], char out[72]) {
  memcpy(out, "sha256:", 7);
  for (size_t i = 0; i < 32; i++) sprintf(out + 7 + i * 2, "%02x", bytes[i]);
}
static bool digest(HANDLE file, char out[72]) {
  HCRYPTPROV provider = 0;
  HCRYPTHASH hash = 0;
  BYTE bytes[65536], sum[32];
  DWORD count = 0, size = sizeof sum;
  bool ok = CryptAcquireContextW(&provider, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) &&
            CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash);
  while (ok) {
    ok = ReadFile(file, bytes, sizeof bytes, &count, NULL) != 0;
    if (!ok || !count) break;
    ok = CryptHashData(hash, bytes, count, 0) != 0;
  }
  ok = ok && CryptGetHashParam(hash, HP_HASHVAL, sum, &size, 0) && size == 32;
  if (ok) hex(sum, out);
  if (hash) CryptDestroyHash(hash);
  if (provider) CryptReleaseContext(provider, 0);
  return ok;
}
static bool signer(napi_env env, napi_value result, HANDLE file, wchar_t *path) {
  GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  WINTRUST_FILE_INFO input = {sizeof input};
  input.pcwszFilePath = path;
  input.hFile = file;
  WINTRUST_DATA trust = {sizeof trust};
  trust.dwUIChoice = WTD_UI_NONE;
  trust.fdwRevocationChecks = WTD_REVOKE_NONE;
  trust.dwUnionChoice = WTD_CHOICE_FILE;
  trust.pFile = &input;
  trust.dwStateAction = WTD_STATEACTION_VERIFY;
  trust.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL;
  LONG status = WinVerifyTrust(NULL, &action, &trust);
  bool ok = false;
  if (status == ERROR_SUCCESS) {
    CRYPT_PROVIDER_DATA *provider = WTHelperProvDataFromStateData(trust.hWVTStateData);
    CRYPT_PROVIDER_SGNR *signer = provider ? WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0) : NULL;
    PCCERT_CONTEXT cert = signer && signer->csCertChain ? signer->pasCertChain[0].pCert : NULL;
    BYTE sum[32];
    DWORD size = sizeof sum;
    wchar_t publisher[512];
    DWORD chars = cert ? CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, NULL, publisher, 512) : 0;
    if (chars > 1 && chars < 512 && CryptHashCertificate2(L"SHA256", 0, NULL,
        cert->pbCertEncoded, cert->cbCertEncoded, sum, &size) && size == 32) {
      char hash[72];
      hex(sum, hash);
      text(env, result, "certificateDigest", hash);
      wide(env, result, "publisher", publisher, chars - 1);
      ok = true;
    }
  }
  trust.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(NULL, &action, &trust);
  text(env, result, "signing", ok ? "valid" : "invalid");
  return ok;
}

// ProcessCommandLineInformation reads the retained process, never argv supplied
// by the peer. Exact role policy still belongs to authenticated prepared trust.
typedef NTSTATUS (NTAPI *query_process)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG, PULONG);
DWORD migration_parent_pid(HANDLE process) {
  struct { NTSTATUS exit_status; void *peb; ULONG_PTR affinity; LONG priority;
           ULONG_PTR pid; ULONG_PTR parent; } basic;
  query_process query = (query_process)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
  return query && query(process, ProcessBasicInformation, &basic, sizeof basic, NULL) >= 0
      && basic.parent <= MAXDWORD ? (DWORD)basic.parent : 0;
}
napi_value capture_migration_image(napi_env env, HANDLE process, const void *owner) {
  image_pin *pin = calloc(1, sizeof *pin);
  wchar_t path[32768];
  DWORD length = 32768;
  char hash[72], file_id[25];
  BY_HANDLE_FILE_INFORMATION file;
  void *command = NULL;
  ULONG needed = 0;
  query_process query = (query_process)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
  if (!pin) return nothing(env);
  pin->owner = owner;
  if (!DuplicateHandle(GetCurrentProcess(), process, GetCurrentProcess(), &pin->process,
                       0, FALSE, DUPLICATE_SAME_ACCESS) ||
      WaitForSingleObject(process, 0) != WAIT_TIMEOUT ||
      !QueryFullProcessImageNameW(process, 0, path, &length) ||
      length < 3 || path[1] != L':' || path[2] != L'\\') goto fail;
  pin->file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                         FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
  if (pin->file == INVALID_HANDLE_VALUE) { pin->file = NULL; goto fail; }
  if (!GetFileInformationByHandle(pin->file, &file) ||
      file.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) ||
      !digest(pin->file, hash) || !query) goto fail;
  query(process, (PROCESSINFOCLASS)60, NULL, 0, &needed);
  if (needed < sizeof(UNICODE_STRING) || needed > 131072) goto fail;
  command = calloc(1, needed);
  if (!command || query(process, (PROCESSINFOCLASS)60, command, needed, &needed) < 0) goto fail;
  UNICODE_STRING *line = command;
  uintptr_t start = (uintptr_t)command, string = (uintptr_t)line->Buffer;
  if (!line->Length || line->Length % 2 || string < start + sizeof *line ||
      string - start > needed || line->Length > needed - (string - start)) goto fail;
  napi_value result, handle;
  if (napi_create_object(env, &result) != napi_ok || napi_create_object(env, &handle) != napi_ok ||
      napi_type_tag_object(env, handle, &IMAGE_TAG) != napi_ok) goto fail;
  napi_value parent;
  DWORD parent_pid = migration_parent_pid(process);
  if (!parent_pid) goto fail;
  napi_create_uint32(env, parent_pid, &parent);
  napi_set_named_property(env, result, "parentPid", parent);
  text(env, result, "digest", hash);
  snprintf(file_id, sizeof file_id, "%08lx%08lx%08lx", (unsigned long)file.dwVolumeSerialNumber,
           (unsigned long)file.nFileIndexHigh, (unsigned long)file.nFileIndexLow);
  text(env, result, "fileId", file_id);
  wide(env, result, "commandLine", line->Buffer, line->Length / 2);
  signer(env, result, pin->file, path);
  free(command); command = NULL;
  if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT ||
      napi_wrap(env, handle, pin, finalize_pin, NULL, NULL) != napi_ok) goto fail;
  napi_set_named_property(env, result, "pin", handle);
  return result;
fail:
  free(command);
  close_pin(pin);
  free(pin);
  return nothing(env);
}

static image_pin *pin_arg(napi_env env, napi_callback_info info) {
  napi_value arg;
  size_t count = 1;
  void *owner = NULL, *raw = NULL;
  bool tagged = false;
  if (napi_get_cb_info(env, info, &count, &arg, NULL, &owner) != napi_ok || count != 1 ||
      napi_check_object_type_tag(env, arg, &IMAGE_TAG, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, arg, &raw) != napi_ok || !raw) return NULL;
  image_pin *pin = raw;
  return pin->owner == owner ? pin : NULL;
}
napi_value migration_image_current(napi_env env, napi_callback_info info) {
  image_pin *pin = pin_arg(env, info);
  napi_value result;
  napi_get_boolean(env, pin && pin->file && pin->process &&
                   WaitForSingleObject(pin->process, 0) == WAIT_TIMEOUT, &result);
  return result;
}
napi_value migration_image_close(napi_env env, napi_callback_info info) {
  image_pin *pin = pin_arg(env, info);
  if (pin) close_pin(pin);
  return nothing(env);
}
