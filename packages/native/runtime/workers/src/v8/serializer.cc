/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Structured serialize/deserialize across isolates (HTML §2.7.3 StructuredSerializeWithTransfer, §2.7.5
// StructuredDeserializeWithTransfer) over V8's ValueSerializer / ValueDeserializer (v8-value-serializer.h):
//   * ArrayBuffers in the transfer list move: their BackingStore travels in the message (shared_ptr, so the memory is
//     freed exactly once by whichever side drops it last, even after the creating worker ended: JS-2, REG-8) and the
//     sender's buffer is detached after serialization succeeded.
//   * SharedArrayBuffers (and shared WebAssembly.Memory, which V8 writes through them) share their BackingStore when
//     the app is cross-origin isolated by policy; otherwise DataCloneError (WRK-5, decision in README).
//   * WebAssembly.Module values share the compiled module (CompiledWasmModule).
//   * Platform objects implemented in JS (Blob, File, ImageData, ImageBitmap, MessagePort, DOMException, ...) are
//     "host objects": the binding's host hooks turn them into plain descriptors (write) and back (read). V8 runs
//     no JS while it deserializes (DisallowJavascriptExecution in ValueDeserializer), so the descriptors travel in a
//     second buffer: the main data holds an index per host object (identity and cycles kept: V8 maps the object to
//     its first index), and the receiver revives every descriptor with its JS hook before reading the main value.
#include <cstdlib>
#include <cstring>

#include "v8/internal.h"

#if defined(IWN_WORKERS_HAVE_IMAGE)
#include "iwn/image/pool.h"
#endif

namespace iwn::workers {

SerializedMessage::~SerializedMessage() {
  if (data) std::free(data);
  if (host_data) std::free(host_data);
  if (!delivered) {
    // Never delivered (receiver gone, port closed, worker terminated): transferred ports close (their peers become
    // disentangled) and parked ImageBitmap pixels are released.
    for (PortId p : ports) PortHub::shared().close(p);
#if defined(IWN_WORKERS_HAVE_IMAGE)
    for (uint64_t id : bitmaps) iwn::image::TransferRegistry::Shared().Discard(id);
#endif
  }
}

size_t SerializedMessage::byte_size() const {
  size_t n = size + host_size;
  for (const auto& bs : array_buffers) n += bs ? bs->ByteLength() : 0;
  return n;
}

namespace {

class WriteDelegate final : public v8::ValueSerializer::Delegate {
 public:
  WriteDelegate(IsolateBinding& binding, v8::Local<v8::Context> ctx, SerializedMessage& out, bool allow_shared)
      : binding_(binding), ctx_(ctx), out_(out), allow_shared_(allow_shared),
        // Created here, in the caller's HandleScope: V8 calls the delegate inside its own handle scopes, so a Local
        // made in WriteHostObject would not outlive the call.
        descriptors_(v8::Array::New(binding.isolate())) {}
  void set_serializer(v8::ValueSerializer* s) { serializer_ = s; }

  void ThrowDataCloneError(v8::Local<v8::String> message) override {
    throw_dom_exception(binding_.isolate(), utf8(binding_.isolate(), message), "DataCloneError");
  }

  bool HasCustomHostObject(v8::Isolate*) override { return true; }

  v8::Maybe<bool> IsHostObject(v8::Isolate*, v8::Local<v8::Object> object) override {
    return v8::Just(binding_.is_host_object(object));
  }

  v8::Maybe<bool> WriteHostObject(v8::Isolate* isolate, v8::Local<v8::Object> object) override {
    if (!binding_.has_hooks()) {
      throw_dom_exception(isolate, "This platform object could not be cloned.", "DataCloneError");
      return v8::Nothing<bool>();
    }
    v8::Local<v8::Value> argv[] = {object};
    v8::Local<v8::Value> descriptor;
    // Called directly (not as a runtime callback): an exception is the serialization's result (DataCloneError).
    if (!binding_.host_write()->Call(ctx_, v8::Undefined(isolate), 1, argv).ToLocal(&descriptor)) {
      return v8::Nothing<bool>();
    }
    if (!descriptor->IsObject()) {
      throw_dom_exception(isolate, "This platform object could not be cloned.", "DataCloneError");
      return v8::Nothing<bool>();
    }
    uint32_t index = descriptors_->Length();
    if (descriptors_->Set(ctx_, index, descriptor).IsNothing()) return v8::Nothing<bool>();
    serializer_->WriteUint32(index);
    return v8::Just(true);
  }
  v8::Local<v8::Array> descriptors() const { return descriptors_; }

  v8::Maybe<uint32_t> GetSharedArrayBufferId(v8::Isolate* isolate, v8::Local<v8::SharedArrayBuffer> sab) override {
    if (!allow_shared_) {
      throw_dom_exception(isolate,
                          "SharedArrayBuffer transfer requires cross-origin isolation (config workers."
                          "crossOriginIsolated is false).",
                          "DataCloneError");
      return v8::Nothing<uint32_t>();
    }
    for (size_t i = 0; i < seen_shared_.size(); ++i) {
      if (seen_shared_[i] == sab) return v8::Just(static_cast<uint32_t>(i));
    }
    seen_shared_.push_back(sab);
    out_.shared_buffers.push_back(sab->GetBackingStore());
    return v8::Just(static_cast<uint32_t>(seen_shared_.size() - 1));
  }

  v8::Maybe<uint32_t> GetWasmModuleTransferId(v8::Isolate*, v8::Local<v8::WasmModuleObject> module) override {
    for (size_t i = 0; i < seen_wasm_.size(); ++i) {
      if (seen_wasm_[i] == module) return v8::Just(static_cast<uint32_t>(i));
    }
    seen_wasm_.push_back(module);
    out_.wasm_modules.push_back(module->GetCompiledModule());
    return v8::Just(static_cast<uint32_t>(seen_wasm_.size() - 1));
  }

 private:
  IsolateBinding& binding_;
  v8::Local<v8::Context> ctx_;
  SerializedMessage& out_;
  bool allow_shared_;
  v8::ValueSerializer* serializer_ = nullptr;
  v8::Local<v8::Array> descriptors_;
  std::vector<v8::Local<v8::SharedArrayBuffer>> seen_shared_;
  std::vector<v8::Local<v8::WasmModuleObject>> seen_wasm_;
};

// The descriptors' own serializer: plain data only (a descriptor holding a platform object or a SharedArrayBuffer
// is a hook bug and fails with DataCloneError).
class DescriptorDelegate final : public v8::ValueSerializer::Delegate {
 public:
  explicit DescriptorDelegate(v8::Isolate* isolate) : isolate_(isolate) {}
  void ThrowDataCloneError(v8::Local<v8::String> message) override {
    throw_dom_exception(isolate_, utf8(isolate_, message), "DataCloneError");
  }

 private:
  v8::Isolate* isolate_;
};

class ReadDelegate final : public v8::ValueDeserializer::Delegate {
 public:
  ReadDelegate(v8::Local<v8::Context> ctx, SerializedMessage& message, v8::Local<v8::Array> revived)
      : ctx_(ctx), message_(message), revived_(revived) {}
  void set_deserializer(v8::ValueDeserializer* d) { deserializer_ = d; }

  // No JS may run here: the host objects were revived before deserialization started.
  v8::MaybeLocal<v8::Object> ReadHostObject(v8::Isolate* isolate) override {
    uint32_t index = 0;
    v8::Local<v8::Value> object;
    if (!deserializer_->ReadUint32(&index) || revived_.IsEmpty() || index >= revived_->Length() ||
        !revived_->Get(ctx_, index).ToLocal(&object) || !object->IsObject()) {
      isolate->ThrowException(v8::Exception::Error(v8str(isolate, "invalid host object in a message")));
      return {};
    }
    return object.As<v8::Object>();
  }

  v8::MaybeLocal<v8::SharedArrayBuffer> GetSharedArrayBufferFromId(v8::Isolate* isolate, uint32_t id) override {
    if (id >= message_.shared_buffers.size()) return {};
    return v8::SharedArrayBuffer::New(isolate, message_.shared_buffers[id]);
  }

  v8::MaybeLocal<v8::WasmModuleObject> GetWasmModuleFromId(v8::Isolate* isolate, uint32_t id) override {
    if (id >= message_.wasm_modules.size()) return {};
    return v8::WasmModuleObject::FromCompiledModule(isolate, message_.wasm_modules[id]);
  }

 private:
  v8::Local<v8::Context> ctx_;
  SerializedMessage& message_;
  v8::Local<v8::Array> revived_;
  v8::ValueDeserializer* deserializer_ = nullptr;
};

}  // namespace

std::unique_ptr<SerializedMessage> serialize_message(IsolateBinding& binding, v8::Local<v8::Context> ctx,
                                                     v8::Local<v8::Value> value,
                                                     const std::vector<v8::Local<v8::ArrayBuffer>>& transfer,
                                                     bool allow_shared) {
  v8::Isolate* isolate = binding.isolate();
  // Transfer list checks (HTML StructuredSerializeWithTransfer step 1-2): no duplicates, nothing detached, and only
  // buffers V8 can detach (not a WebAssembly.Memory's buffer).
  for (size_t i = 0; i < transfer.size(); ++i) {
    for (size_t j = 0; j < i; ++j) {
      if (transfer[i] == transfer[j]) {
        throw_dom_exception(isolate, "ArrayBuffer at index " + std::to_string(i) + " is a duplicate of an earlier ArrayBuffer.",
                            "DataCloneError");
        return nullptr;
      }
    }
    if (transfer[i]->WasDetached()) {
      throw_dom_exception(isolate, "ArrayBuffer at index " + std::to_string(i) + " is already detached.",
                          "DataCloneError");
      return nullptr;
    }
    if (!transfer[i]->IsDetachable()) {
      throw_dom_exception(isolate, "ArrayBuffer at index " + std::to_string(i) + " is not detachable and could not be transferred.",
                          "DataCloneError");
      return nullptr;
    }
  }
  auto out = std::make_unique<SerializedMessage>();
  WriteDelegate delegate(binding, ctx, *out, allow_shared);
  v8::ValueSerializer serializer(isolate, &delegate);
  delegate.set_serializer(&serializer);
  serializer.WriteHeader();
  for (size_t i = 0; i < transfer.size(); ++i) serializer.TransferArrayBuffer(static_cast<uint32_t>(i), transfer[i]);
  if (!serializer.WriteValue(ctx, value).FromMaybe(false)) return nullptr;
  auto [data, size] = serializer.Release();
  out->data = data;
  out->size = size;
  if (v8::Local<v8::Array> descriptors = delegate.descriptors(); descriptors->Length() > 0) {
    DescriptorDelegate ddel(isolate);
    v8::ValueSerializer dser(isolate, &ddel);
    dser.WriteHeader();
    if (!dser.WriteValue(ctx, descriptors).FromMaybe(false)) return nullptr;
    auto [hdata, hsize] = dser.Release();
    out->host_data = hdata;
    out->host_size = hsize;
    out->host_count = descriptors->Length();
  }
  // Only now, after serialization succeeded, are the transferred buffers detached (nothing is detached on failure).
  out->array_buffers.reserve(transfer.size());
  for (auto ab : transfer) out->array_buffers.push_back(ab->GetBackingStore());
  for (size_t i = 0; i < transfer.size(); ++i) {
    if (transfer[i]->Detach(v8::Local<v8::Value>()).IsNothing()) {
      // A detach key mismatch (an embedder-owned buffer): the earlier ones are already detached; report it.
      throw_dom_exception(isolate, "ArrayBuffer at index " + std::to_string(i) + " could not be detached.",
                          "DataCloneError");
      return nullptr;
    }
  }
  return out;
}

v8::MaybeLocal<v8::Value> deserialize_message(IsolateBinding& binding, v8::Local<v8::Context> ctx,
                                              SerializedMessage& message, v8::Local<v8::Array> ports,
                                              v8::Local<v8::Array> bitmaps) {
  v8::Isolate* isolate = binding.isolate();
  v8::EscapableHandleScope scope(isolate);
  // 1. Revive the host objects in this realm (JS hook), in index order.
  v8::Local<v8::Array> revived;
  if (message.host_count > 0) {
    if (!binding.has_hooks()) {
      throw_dom_exception(isolate, "No host object reader in this global.", "DataCloneError");
      return {};
    }
    v8::ValueDeserializer dd(isolate, message.host_data, message.host_size);
    v8::Local<v8::Value> descs;
    if (!dd.ReadHeader(ctx).FromMaybe(false) || !dd.ReadValue(ctx).ToLocal(&descs) || !descs->IsArray()) return {};
    auto arr = descs.As<v8::Array>();
    revived = v8::Array::New(isolate, static_cast<int>(arr->Length()));
    v8::Local<v8::Function> read = binding.host_read();
    for (uint32_t i = 0; i < arr->Length(); ++i) {
      v8::Local<v8::Value> desc, obj;
      if (!arr->Get(ctx, i).ToLocal(&desc)) return {};
      v8::Local<v8::Value> argv[] = {desc, ports, bitmaps};
      if (!read->Call(ctx, v8::Undefined(isolate), 3, argv).ToLocal(&obj)) return {};
      if (!obj->IsObject()) {
        throw_dom_exception(isolate, "A platform object could not be deserialized.", "DataCloneError");
        return {};
      }
      if (revived->Set(ctx, i, obj).IsNothing()) return {};
    }
  }
  // 2. The value itself (no JS runs from here on).
  ReadDelegate delegate(ctx, message, revived);
  v8::ValueDeserializer deserializer(isolate, message.data, message.size, &delegate);
  delegate.set_deserializer(&deserializer);
  for (size_t i = 0; i < message.array_buffers.size(); ++i) {
    deserializer.TransferArrayBuffer(static_cast<uint32_t>(i),
                                     v8::ArrayBuffer::New(isolate, message.array_buffers[i]));
  }
  if (!deserializer.ReadHeader(ctx).FromMaybe(false)) return {};
  v8::Local<v8::Value> value;
  if (!deserializer.ReadValue(ctx).ToLocal(&value)) return {};
  return scope.Escape(value);
}

}  // namespace iwn::workers
