// structuredClone over v8::ValueSerializer / ValueDeserializer (HTML "StructuredSerializeWithTransfer", TMR-3).
// Transferred ArrayBuffers move their backing store to the clone and are detached in the source.
#include <v8.h>

#include <vector>

#include "v8/v8_util.h"

namespace iwn {
namespace {

void throw_data_clone_error(v8::Isolate* isolate, v8::Local<v8::String> message) {
  // A DOMException "DataCloneError" when the glue installed DOMException; otherwise a TypeError-like Error.
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  v8::Local<v8::Value> ctor;
  if (ctx->Global()->Get(ctx, v8u::sym(isolate, "DOMException")).ToLocal(&ctor) && ctor->IsFunction()) {
    v8::Local<v8::Value> args[] = {message, v8u::sym(isolate, "DataCloneError")};
    v8::Local<v8::Object> ex;
    v8::TryCatch tc(isolate);
    if (ctor.As<v8::Function>()->NewInstance(ctx, 2, args).ToLocal(&ex)) {
      tc.Reset();
      isolate->ThrowException(ex);
      return;
    }
  }
  v8::Local<v8::Value> err = v8::Exception::Error(message);
  err.As<v8::Object>()->Set(ctx, v8u::sym(isolate, "name"), v8u::sym(isolate, "DataCloneError")).Check();
  isolate->ThrowException(err);
}

class SerializerDelegate : public v8::ValueSerializer::Delegate {
 public:
  explicit SerializerDelegate(v8::Isolate* isolate) : isolate_(isolate) {}
  void ThrowDataCloneError(v8::Local<v8::String> message) override { throw_data_clone_error(isolate_, message); }
  v8::Maybe<uint32_t> GetSharedArrayBufferId(v8::Isolate* isolate, v8::Local<v8::SharedArrayBuffer> sab) override {
    for (size_t i = 0; i < sabs.size(); ++i) {
      if (sabs[i] == sab) return v8::Just(static_cast<uint32_t>(i));
    }
    sabs.push_back(sab);
    return v8::Just(static_cast<uint32_t>(sabs.size() - 1));
  }
  std::vector<v8::Local<v8::SharedArrayBuffer>> sabs;

 private:
  v8::Isolate* isolate_;
};

class DeserializerDelegate : public v8::ValueDeserializer::Delegate {
 public:
  explicit DeserializerDelegate(const std::vector<v8::Local<v8::SharedArrayBuffer>>& sabs) : sabs_(sabs) {}
  v8::MaybeLocal<v8::SharedArrayBuffer> GetSharedArrayBufferFromId(v8::Isolate*, uint32_t id) override {
    if (id < sabs_.size()) return sabs_[id];
    return {};
  }

 private:
  const std::vector<v8::Local<v8::SharedArrayBuffer>>& sabs_;
};

void structured_clone(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  v8::Local<v8::Value> value = info.Length() > 0 ? info[0] : v8::Undefined(isolate).As<v8::Value>();
  std::vector<v8::Local<v8::ArrayBuffer>> transfers;
  if (info.Length() > 1 && info[1]->IsArray()) {
    auto arr = info[1].As<v8::Array>();
    for (uint32_t i = 0; i < arr->Length(); ++i) {
      v8::Local<v8::Value> item = arr->Get(ctx, i).ToLocalChecked();
      if (!item->IsArrayBuffer()) {
        throw_data_clone_error(isolate, v8u::str(isolate, "Only ArrayBuffers can be transferred here"));
        return;
      }
      auto ab = item.As<v8::ArrayBuffer>();
      for (auto& t : transfers) {
        if (t == ab) {
          throw_data_clone_error(isolate, v8u::str(isolate, "ArrayBuffer listed twice in the transfer list"));
          return;
        }
      }
      if (ab->WasDetached() || !ab->IsDetachable()) {
        throw_data_clone_error(isolate, v8u::str(isolate, "ArrayBuffer is detached or not transferable"));
        return;
      }
      transfers.push_back(ab);
    }
  }
  SerializerDelegate sdel(isolate);
  v8::ValueSerializer ser(isolate, &sdel);
  for (size_t i = 0; i < transfers.size(); ++i) ser.TransferArrayBuffer(static_cast<uint32_t>(i), transfers[i]);
  ser.WriteHeader();
  if (!ser.WriteValue(ctx, value).FromMaybe(false)) return;  // DataCloneError thrown by the delegate
  std::pair<uint8_t*, size_t> buf = ser.Release();
  // Move transferred backing stores to new ArrayBuffers and detach the originals.
  std::vector<v8::Local<v8::ArrayBuffer>> moved;
  for (auto& ab : transfers) {
    std::shared_ptr<v8::BackingStore> store = ab->GetBackingStore();
    if (ab->Detach(v8::Local<v8::Value>()).IsNothing()) {
      free(buf.first);
      return;
    }
    moved.push_back(v8::ArrayBuffer::New(isolate, store));
  }
  DeserializerDelegate ddel(sdel.sabs);
  v8::ValueDeserializer des(isolate, buf.first, buf.second, &ddel);
  for (size_t i = 0; i < moved.size(); ++i) des.TransferArrayBuffer(static_cast<uint32_t>(i), moved[i]);
  v8::Local<v8::Value> out;
  if (des.ReadHeader(ctx).FromMaybe(false) && des.ReadValue(ctx).ToLocal(&out)) info.GetReturnValue().Set(out);
  free(buf.first);
}

}  // namespace

void install_clone_natives(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives) {
  v8::Local<v8::Object> clone = v8::Object::New(isolate);
  v8u::set_function(isolate, ctx, clone, "structuredClone", structured_clone);
  v8u::set_value(isolate, ctx, natives, "clone", clone);
}

}  // namespace iwn
