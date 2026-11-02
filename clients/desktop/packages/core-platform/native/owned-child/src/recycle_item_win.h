#ifndef CANOPY_RECYCLE_ITEM_WIN_H
#define CANOPY_RECYCLE_ITEM_WIN_H

#include <node_api.h>

// recycleItem(path): a promise of "recycled", "refused", "failed",
// "deleted" or "unreported" for one Recycle Bin move (CAN-4726).
napi_value recycle_item(napi_env env, napi_callback_info info);

#endif
