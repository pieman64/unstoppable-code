// Recycle Bin moves for PlatformServices.trash (CAN-4726, Windows).
//
// IFileOperation::DeleteItem with FOFX_RECYCLEONDELETE, as Electron's
// shell.trashItem does. FOF_NO_UI answers every prompt yes, including
// "delete permanently?", so the progress sink, like Electron's, aborts any
// delete the shell does not mark TSF_DELETE_RECYCLE_IF_POSSIBLE and lets
// every other notification through: an entry that cannot be
// recycled (network and removable volumes, a full or disabled Recycle Bin)
// is refused, never deleted. PostDeleteItem names the item now in the
// Recycle Bin; a success without one is reported as "deleted". The shell
// item is parsed from the lexical path, so a link or junction is recycled
// itself. Each call runs on a thread of its own in a fresh STA, off the JS
// thread. Results are fixed strings; errors carry fixed text.
#ifndef _WIN32
#error "core-owned-child (Windows) supports Windows only"
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef COBJMACROS
#define COBJMACROS
#endif

#include <windows.h>
#include <objbase.h>
#include <shellapi.h>
#include <shobjidl.h>

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include <node_api.h>

#include "recycle_item_win.h"

// Windows 8 and later; older SDK version macros hide the definitions.
#ifndef FOFX_RECYCLEONDELETE
#define FOFX_RECYCLEONDELETE 0x00080000
#endif
#ifndef FOFX_EARLYFAILURE
#define FOFX_EARLYFAILURE 0x00100000
#endif
#ifndef FOFX_NOCOPYHOOKS
#define FOFX_NOCOPYHOOKS 0x00800000
#endif
#ifndef FOFX_ADDUNDORECORD
#define FOFX_ADDUNDORECORD 0x20000000
#endif
#ifndef FOF_NO_UI
#define FOF_NO_UI \
  (FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_NOCONFIRMMKDIR)
#endif

// One path, in UTF-16 code units, without its terminating NUL.
#define RI_MAX_PATH_CHARS 32767

typedef struct {
  IFileOperationProgressSink iface;
  // The shell offered a delete it could not recycle; the sink aborted it.
  bool refused;
  bool reported;
  HRESULT deleted_result;
  bool in_recycle_bin;
} ri_sink;

typedef struct {
  ri_sink sink;
  wchar_t *path;
  const char *result;
  napi_deferred deferred;
  napi_async_work work;
} ri_request;

static ri_sink *ri_from(IFileOperationProgressSink *self) {
  return (ri_sink *)self;
}

static HRESULT STDMETHODCALLTYPE ri_query_interface(
    IFileOperationProgressSink *self, REFIID riid, void **out) {
  if (!out) return E_POINTER;
  if (IsEqualIID(riid, &IID_IUnknown) ||
      IsEqualIID(riid, &IID_IFileOperationProgressSink)) {
    *out = self;
    return S_OK;
  }
  *out = NULL;
  return E_NOINTERFACE;
}

// The request owns the sink and outlives the operation, so counting is moot.
static ULONG STDMETHODCALLTYPE ri_add_ref(IFileOperationProgressSink *self) {
  (void)self;
  return 2;
}

static ULONG STDMETHODCALLTYPE ri_release(IFileOperationProgressSink *self) {
  (void)self;
  return 1;
}

static HRESULT STDMETHODCALLTYPE ri_ok(IFileOperationProgressSink *self) {
  (void)self;
  return S_OK;
}

static HRESULT STDMETHODCALLTYPE ri_finish(IFileOperationProgressSink *self,
                                           HRESULT result) {
  (void)self;
  (void)result;
  return S_OK;
}

static HRESULT STDMETHODCALLTYPE ri_pre_rename(IFileOperationProgressSink *self,
                                               DWORD flags, IShellItem *item,
                                               LPCWSTR name) {
  (void)self, (void)flags, (void)item, (void)name;
  return S_OK;
}

static HRESULT STDMETHODCALLTYPE ri_post_rename(
    IFileOperationProgressSink *self, DWORD flags, IShellItem *item,
    LPCWSTR name, HRESULT result, IShellItem *created) {
  (void)self, (void)flags, (void)item, (void)name, (void)result,
      (void)created;
  return S_OK;
}

static HRESULT STDMETHODCALLTYPE ri_pre_transfer(
    IFileOperationProgressSink *self, DWORD flags, IShellItem *item,
    IShellItem *destination, LPCWSTR name) {
  (void)self, (void)flags, (void)item, (void)destination, (void)name;
  return S_OK;
}

static HRESULT STDMETHODCALLTYPE ri_post_transfer(
    IFileOperationProgressSink *self, DWORD flags, IShellItem *item,
    IShellItem *destination, LPCWSTR name, HRESULT result,
    IShellItem *created) {
  (void)self, (void)flags, (void)item, (void)destination, (void)name,
      (void)result, (void)created;
  return S_OK;
}

static HRESULT STDMETHODCALLTYPE ri_pre_delete(IFileOperationProgressSink *self,
                                               DWORD flags, IShellItem *item) {
  (void)item;
  if (flags & TSF_DELETE_RECYCLE_IF_POSSIBLE) return S_OK;
  ri_from(self)->refused = true;
  return E_ABORT;
}

static HRESULT STDMETHODCALLTYPE ri_post_delete(
    IFileOperationProgressSink *self, DWORD flags, IShellItem *item,
    HRESULT result, IShellItem *created) {
  (void)flags, (void)item;
  ri_sink *sink = ri_from(self);
  sink->reported = true;
  sink->deleted_result = result;
  sink->in_recycle_bin = created != NULL;
  return S_OK;
}

static HRESULT STDMETHODCALLTYPE ri_pre_new(IFileOperationProgressSink *self,
                                            DWORD flags,
                                            IShellItem *destination,
                                            LPCWSTR name) {
  (void)self, (void)flags, (void)destination, (void)name;
  return S_OK;
}

static HRESULT STDMETHODCALLTYPE ri_post_new(
    IFileOperationProgressSink *self, DWORD flags, IShellItem *destination,
    LPCWSTR name, LPCWSTR template_name, DWORD attributes, HRESULT result,
    IShellItem *created) {
  (void)self, (void)flags, (void)destination, (void)name,
      (void)template_name, (void)attributes, (void)result, (void)created;
  return S_OK;
}

static HRESULT STDMETHODCALLTYPE ri_progress(IFileOperationProgressSink *self,
                                             UINT total, UINT done) {
  (void)self, (void)total, (void)done;
  return S_OK;
}

static IFileOperationProgressSinkVtbl RI_SINK_VTBL = {
    .QueryInterface = ri_query_interface,
    .AddRef = ri_add_ref,
    .Release = ri_release,
    .StartOperations = ri_ok,
    .FinishOperations = ri_finish,
    .PreRenameItem = ri_pre_rename,
    .PostRenameItem = ri_post_rename,
    .PreMoveItem = ri_pre_transfer,
    .PostMoveItem = ri_post_transfer,
    .PreCopyItem = ri_pre_transfer,
    .PostCopyItem = ri_post_transfer,
    .PreDeleteItem = ri_pre_delete,
    .PostDeleteItem = ri_post_delete,
    .PreNewItem = ri_pre_new,
    .PostNewItem = ri_post_new,
    .UpdateProgress = ri_progress,
    .ResetTimer = ri_ok,
    .PauseTimer = ri_ok,
    .ResumeTimer = ri_ok,
};

// A refusal wins: the item is in place. Then any failure, then the shell's
// own report of where the item went.
static const char *ri_perform(ri_request *request) {
  IFileOperation *operation = NULL;
  IShellItem *item = NULL;
  const char *result = "failed";
  if (FAILED(CoCreateInstance(&CLSID_FileOperation, NULL, CLSCTX_INPROC_SERVER,
                              &IID_IFileOperation, (void **)&operation)))
    return result;
  if (SUCCEEDED(IFileOperation_SetOperationFlags(
          operation, FOF_NO_UI | FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE |
                         FOFX_NOCOPYHOOKS | FOFX_ADDUNDORECORD)) &&
      SUCCEEDED(SHCreateItemFromParsingName(request->path, NULL, &IID_IShellItem,
                                            (void **)&item)) &&
      SUCCEEDED(IFileOperation_DeleteItem(operation, item,
                                          &request->sink.iface))) {
    HRESULT performed = IFileOperation_PerformOperations(operation);
    BOOL aborted = FALSE;
    HRESULT checked = IFileOperation_GetAnyOperationsAborted(operation, &aborted);
    const ri_sink *sink = &request->sink;
    if (sink->refused)
      result = "refused";
    else if (FAILED(performed) || FAILED(checked) || aborted ||
             (sink->reported && FAILED(sink->deleted_result)))
      result = "failed";
    else if (!sink->reported)
      result = "unreported";
    else
      result = sink->in_recycle_bin ? "recycled" : "deleted";
  }
  if (item) IShellItem_Release(item);
  IFileOperation_Release(operation);
  return result;
}

static DWORD WINAPI ri_thread(LPVOID data) {
  ri_request *request = data;
  if (FAILED(CoInitializeEx(NULL, COINIT_APARTMENTTHREADED |
                                      COINIT_DISABLE_OLE1DDE)))
    return 0;
  request->result = ri_perform(request);
  CoUninitialize();
  return 0;
}

// A thread of its own, so no pool thread's apartment is changed or inherited.
static void ri_execute(napi_env env, void *data) {
  (void)env;
  ri_request *request = data;
  HANDLE thread = CreateThread(NULL, 0, ri_thread, request, 0, NULL);
  if (!thread) return;
  WaitForSingleObject(thread, INFINITE);
  CloseHandle(thread);
}

static void ri_complete(napi_env env, napi_status status, void *data) {
  ri_request *request = data;
  napi_value value = NULL;
  if (status == napi_ok &&
      napi_create_string_utf8(env, request->result, NAPI_AUTO_LENGTH,
                              &value) == napi_ok) {
    napi_resolve_deferred(env, request->deferred, value);
  } else {
    napi_value code = NULL;
    napi_value message = NULL;
    napi_value error = NULL;
    if (napi_create_string_utf8(env, "ERR_OWNED_CHILD_RECYCLE",
                                NAPI_AUTO_LENGTH, &code) == napi_ok &&
        napi_create_string_utf8(env, "Recycle call did not complete.",
                                NAPI_AUTO_LENGTH, &message) == napi_ok &&
        napi_create_error(env, code, message, &error) == napi_ok)
      napi_reject_deferred(env, request->deferred, error);
  }
  napi_delete_async_work(env, request->work);
  free(request->path);
  free(request);
}

static bool ri_copy_path(napi_env env, napi_value value, wchar_t **out) {
  napi_valuetype type;
  size_t size = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf16(env, value, NULL, 0, &size) != napi_ok ||
      size == 0 || size > RI_MAX_PATH_CHARS)
    return false;
  char16_t *text = calloc(size + 1, sizeof *text);
  if (!text) return false;
  size_t copied = 0;
  if (napi_get_value_string_utf16(env, value, text, size + 1, &copied) !=
          napi_ok ||
      copied != size || wcslen((const wchar_t *)text) != size) {
    free(text);
    return false;
  }
  *out = (wchar_t *)text;
  return true;
}

napi_value recycle_item(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value promise = NULL;
  napi_value name = NULL;
  ri_request *request = calloc(1, sizeof *request);
  if (!request || napi_get_cb_info(env, info, &argc, argv, NULL, NULL) !=
                      napi_ok ||
      argc != 1 || !ri_copy_path(env, argv[0], &request->path)) {
    free(request);
    napi_throw_error(env, "ERR_OWNED_CHILD_ARGUMENT",
                     "Owned child call is invalid.");
    return NULL;
  }
  request->sink.iface.lpVtbl = &RI_SINK_VTBL;
  request->result = "failed";
  if (napi_create_promise(env, &request->deferred, &promise) != napi_ok) {
    free(request->path);
    free(request);
    napi_throw_error(env, "ERR_OWNED_CHILD_RECYCLE",
                     "Recycle call could not start.");
    return NULL;
  }
  if (napi_create_string_utf8(env, "recycleItem", NAPI_AUTO_LENGTH, &name) !=
          napi_ok ||
      napi_create_async_work(env, NULL, name, ri_execute, ri_complete, request,
                             &request->work) != napi_ok) {
    request->work = NULL;
  } else if (napi_queue_async_work(env, request->work) == napi_ok) {
    return promise;
  }
  // The promise exists, so it is rejected rather than left pending.
  napi_value code = NULL;
  napi_value message = NULL;
  napi_value error = NULL;
  if (napi_create_string_utf8(env, "ERR_OWNED_CHILD_RECYCLE", NAPI_AUTO_LENGTH,
                              &code) == napi_ok &&
      napi_create_string_utf8(env, "Recycle call could not start.",
                              NAPI_AUTO_LENGTH, &message) == napi_ok &&
      napi_create_error(env, code, message, &error) == napi_ok)
    napi_reject_deferred(env, request->deferred, error);
  if (request->work) napi_delete_async_work(env, request->work);
  free(request->path);
  free(request);
  return promise;
}
