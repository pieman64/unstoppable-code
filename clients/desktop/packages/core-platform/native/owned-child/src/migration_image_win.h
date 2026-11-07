#ifndef CANOPY_MIGRATION_IMAGE_WIN_H
#define CANOPY_MIGRATION_IMAGE_WIN_H
#include <windows.h>
#include <node_api.h>
DWORD migration_parent_pid(HANDLE process);
napi_value capture_migration_image(napi_env env, HANDLE process, const void *owner);
napi_value migration_image_current(napi_env env, napi_callback_info info);
napi_value migration_image_close(napi_env env, napi_callback_info info);
#endif
