#include "v8/v8_util.h"

namespace iwn::v8u {

std::string to_utf8(v8::Isolate* isolate, v8::Local<v8::Value> value) {
  if (value.IsEmpty()) return {};
  v8::String::Utf8Value utf8(isolate, value);
  return *utf8 ? std::string(*utf8, utf8.length()) : std::string();
}

std::string safe_to_string(v8::Isolate* isolate, v8::Local<v8::Value> value) {
  if (value.IsEmpty()) return "<empty>";
  v8::TryCatch tc(isolate);
  v8::Local<v8::String> s;
  if (!value->ToString(isolate->GetCurrentContext()).ToLocal(&s)) return "<unprintable>";
  return to_utf8(isolate, s);
}

void throw_type_error(v8::Isolate* isolate, std::string_view message) {
  isolate->ThrowException(v8::Exception::TypeError(str(isolate, message)));
}

void throw_error(v8::Isolate* isolate, std::string_view message) {
  isolate->ThrowException(v8::Exception::Error(str(isolate, message)));
}

void set_function(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> target, const char* name,
                  v8::FunctionCallback cb, v8::Local<v8::Value> data) {
  v8::Local<v8::Function> fn =
      v8::Function::New(ctx, cb, data, 0, v8::ConstructorBehavior::kThrow).ToLocalChecked();
  fn->SetName(sym(isolate, name));
  target->Set(ctx, sym(isolate, name), fn).Check();
}

void set_value(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> target, const char* name,
               v8::Local<v8::Value> value) {
  target->Set(ctx, sym(isolate, name), value).Check();
}

std::string exception_text(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Value> exception) {
  if (exception.IsEmpty()) return "<no exception>";
  if (exception->IsObject()) {
    v8::TryCatch tc(isolate);
    v8::Local<v8::Value> stack;
    if (exception.As<v8::Object>()->Get(ctx, sym(isolate, "stack")).ToLocal(&stack) && stack->IsString()) {
      std::string s = to_utf8(isolate, stack);
      if (!s.empty()) {
        // V8 15.5 writes the stack header from the message given to the Error constructor. A class that sets its
        // message afterwards (accessors, as WebIDL interfaces have) gets a header with the name only, and the log
        // would lose the explanation: put Error.prototype.toString's "name: message" in its place then.
        const size_t eol = s.find('\n');
        const std::string head = s.substr(0, eol);
        v8::Local<v8::String> str;
        if (exception->ToString(ctx).ToLocal(&str)) {
          const std::string text = to_utf8(isolate, str);
          if (text.size() > head.size() + 2 && text.compare(0, head.size(), head) == 0 &&
              text.compare(head.size(), 2, ": ") == 0) {
            return eol == std::string::npos ? text : text + s.substr(eol);
          }
        }
        return s;
      }
    }
  }
  return safe_to_string(isolate, exception);
}

}  // namespace iwn::v8u
