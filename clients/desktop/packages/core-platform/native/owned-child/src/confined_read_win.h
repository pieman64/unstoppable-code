#ifndef CANOPY_CONFINED_READ_WIN_H
#define CANOPY_CONFINED_READ_WIN_H

#include <node_api.h>

// readConfinedFile(root, components, maxBytes): one W5 capture file read
// through handles opened from the trusted root (CAN-5202).
napi_value confined_read_file(napi_env env, napi_callback_info info);

#endif
