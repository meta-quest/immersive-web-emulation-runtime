// Host test addon: the generated GL natives built against Node's V8, so web/webgl runs on real GLES
// (Mesa llvmpipe, surfaceless EGL) inside Node. `require('iwn_gl.node').gl` is the natives object.
#include <node.h>

#include "../../include/iwn/gl.h"

NODE_MODULE_INIT(/* exports, module, context */) {
  iwn_register_gl(context->GetIsolate(), context, exports);
}
