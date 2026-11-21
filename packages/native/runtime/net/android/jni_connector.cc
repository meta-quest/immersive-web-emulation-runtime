// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

#include "jni_connector.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <mutex>
#include <string>

#include "iwn/net/url.h"

namespace iwn::net {

namespace {

JavaVM* g_vm = nullptr;

struct Jni {
  jclass socket, inet_socket_address, ssl_socket_factory, ssl_socket, ssl_parameters, https_url_connection,
      hostname_verifier, proxy_selector, uri, list, proxy, proxy_type, input_stream, output_stream, throwable,
      cls, ssl_exception, socket_timeout, unknown_host, connect_exception;
  jmethodID socket_ctor, socket_connect, socket_set_so_timeout, socket_set_tcp_no_delay, socket_close,
      socket_get_input, socket_get_output, isa_ctor, isa_get_host_string, isa_get_port, ssf_get_default,
      ssf_create_socket, ssl_get_params, ssl_set_params, ssl_start_handshake, ssl_get_session,
      params_set_endpoint_alg, huc_get_default_verifier, verifier_verify, ps_get_default, ps_select, uri_create,
      list_size, list_get, proxy_type_m, proxy_address, enum_name, is_read, os_write, throwable_get_message,
      object_get_class, class_get_name;
};
Jni g_jni;
std::once_flag g_init_once;
bool g_init_ok = false;

// Attaches the calling thread for the lifetime of the thread.
struct ThreadAttach {
  JNIEnv* env = nullptr;
  bool attached_here = false;
  ~ThreadAttach() {
    if (attached_here && g_vm) g_vm->DetachCurrentThread();
  }
};

JNIEnv* Env() {
  thread_local ThreadAttach t;
  if (t.env) return t.env;
  if (!g_vm) return nullptr;
  JNIEnv* env = nullptr;
  if (g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) == JNI_OK) {
    t.env = env;
    return env;
  }
  JavaVMAttachArgs args{JNI_VERSION_1_6, "iwn-net", nullptr};
  if (g_vm->AttachCurrentThread(&env, &args) != JNI_OK) return nullptr;
  t.env = env;
  t.attached_here = true;
  return env;
}

// Frees every local reference created in a scope (native threads that stay
// attached never return to Java, so locals would otherwise accumulate).
struct LocalFrame {
  JNIEnv* env;
  explicit LocalFrame(JNIEnv* e) : env(e) { env->PushLocalFrame(64); }
  ~LocalFrame() { env->PopLocalFrame(nullptr); }
};

jclass GlobalClass(JNIEnv* env, const char* name) {
  jclass local = env->FindClass(name);
  if (!local) {
    env->ExceptionClear();
    return nullptr;
  }
  jclass global = static_cast<jclass>(env->NewGlobalRef(local));
  env->DeleteLocalRef(local);
  return global;
}

bool LoadJni(JNIEnv* env) {
  Jni& j = g_jni;
#define CLS(field, name) \
  if (!(j.field = GlobalClass(env, name))) return false
  CLS(socket, "java/net/Socket");
  CLS(inet_socket_address, "java/net/InetSocketAddress");
  CLS(ssl_socket_factory, "javax/net/ssl/SSLSocketFactory");
  CLS(ssl_socket, "javax/net/ssl/SSLSocket");
  CLS(ssl_parameters, "javax/net/ssl/SSLParameters");
  CLS(https_url_connection, "javax/net/ssl/HttpsURLConnection");
  CLS(hostname_verifier, "javax/net/ssl/HostnameVerifier");
  CLS(proxy_selector, "java/net/ProxySelector");
  CLS(uri, "java/net/URI");
  CLS(list, "java/util/List");
  CLS(proxy, "java/net/Proxy");
  CLS(proxy_type, "java/net/Proxy$Type");
  CLS(input_stream, "java/io/InputStream");
  CLS(output_stream, "java/io/OutputStream");
  CLS(throwable, "java/lang/Throwable");
  CLS(cls, "java/lang/Class");
  CLS(ssl_exception, "javax/net/ssl/SSLException");
  CLS(socket_timeout, "java/net/SocketTimeoutException");
  CLS(unknown_host, "java/net/UnknownHostException");
  CLS(connect_exception, "java/net/ConnectException");
#undef CLS
#define MID(field, cls, name, sig) \
  if (!(j.field = env->GetMethodID(j.cls, name, sig))) return false
#define SMID(field, cls, name, sig) \
  if (!(j.field = env->GetStaticMethodID(j.cls, name, sig))) return false
  MID(socket_ctor, socket, "<init>", "()V");
  MID(socket_connect, socket, "connect", "(Ljava/net/SocketAddress;I)V");
  MID(socket_set_so_timeout, socket, "setSoTimeout", "(I)V");
  MID(socket_set_tcp_no_delay, socket, "setTcpNoDelay", "(Z)V");
  MID(socket_close, socket, "close", "()V");
  MID(socket_get_input, socket, "getInputStream", "()Ljava/io/InputStream;");
  MID(socket_get_output, socket, "getOutputStream", "()Ljava/io/OutputStream;");
  MID(isa_ctor, inet_socket_address, "<init>", "(Ljava/lang/String;I)V");
  MID(isa_get_host_string, inet_socket_address, "getHostString", "()Ljava/lang/String;");
  MID(isa_get_port, inet_socket_address, "getPort", "()I");
  SMID(ssf_get_default, ssl_socket_factory, "getDefault", "()Ljavax/net/SocketFactory;");
  MID(ssf_create_socket, ssl_socket_factory, "createSocket", "(Ljava/net/Socket;Ljava/lang/String;IZ)Ljava/net/Socket;");
  MID(ssl_get_params, ssl_socket, "getSSLParameters", "()Ljavax/net/ssl/SSLParameters;");
  MID(ssl_set_params, ssl_socket, "setSSLParameters", "(Ljavax/net/ssl/SSLParameters;)V");
  MID(ssl_start_handshake, ssl_socket, "startHandshake", "()V");
  MID(ssl_get_session, ssl_socket, "getSession", "()Ljavax/net/ssl/SSLSession;");
  MID(params_set_endpoint_alg, ssl_parameters, "setEndpointIdentificationAlgorithm", "(Ljava/lang/String;)V");
  SMID(huc_get_default_verifier, https_url_connection, "getDefaultHostnameVerifier", "()Ljavax/net/ssl/HostnameVerifier;");
  MID(verifier_verify, hostname_verifier, "verify", "(Ljava/lang/String;Ljavax/net/ssl/SSLSession;)Z");
  SMID(ps_get_default, proxy_selector, "getDefault", "()Ljava/net/ProxySelector;");
  MID(ps_select, proxy_selector, "select", "(Ljava/net/URI;)Ljava/util/List;");
  SMID(uri_create, uri, "create", "(Ljava/lang/String;)Ljava/net/URI;");
  MID(list_size, list, "size", "()I");
  MID(list_get, list, "get", "(I)Ljava/lang/Object;");
  MID(proxy_type_m, proxy, "type", "()Ljava/net/Proxy$Type;");
  MID(proxy_address, proxy, "address", "()Ljava/net/SocketAddress;");
  if (!(j.enum_name = env->GetMethodID(j.proxy_type, "name", "()Ljava/lang/String;"))) return false;
  MID(is_read, input_stream, "read", "([BII)I");
  MID(os_write, output_stream, "write", "([BII)V");
  MID(throwable_get_message, throwable, "getMessage", "()Ljava/lang/String;");
  if (!(j.object_get_class = env->GetMethodID(env->FindClass("java/lang/Object"), "getClass", "()Ljava/lang/Class;"))) return false;
  MID(class_get_name, cls, "getName", "()Ljava/lang/String;");
#undef MID
#undef SMID
  return true;
}

std::string JString(JNIEnv* env, jstring s) {
  if (!s) return std::string();
  const char* chars = env->GetStringUTFChars(s, nullptr);
  std::string out = chars ? chars : "";
  if (chars) env->ReleaseStringUTFChars(s, chars);
  return out;
}

// Converts a pending Java exception into a NetError and clears it.
bool TakeException(JNIEnv* env, NetError* err, NetErrorKind fallback) {
  if (!env->ExceptionCheck()) return false;
  jthrowable ex = env->ExceptionOccurred();
  env->ExceptionClear();
  LocalFrame frame(env);
  NetErrorKind kind = fallback;
  if (env->IsInstanceOf(ex, g_jni.ssl_exception)) kind = NetErrorKind::kTls;
  else if (env->IsInstanceOf(ex, g_jni.socket_timeout)) kind = NetErrorKind::kTimeout;
  else if (env->IsInstanceOf(ex, g_jni.unknown_host)) kind = NetErrorKind::kDns;
  else if (env->IsInstanceOf(ex, g_jni.connect_exception)) kind = NetErrorKind::kConnect;
  jobject cls = env->CallObjectMethod(ex, g_jni.object_get_class);
  std::string name = cls ? JString(env, static_cast<jstring>(env->CallObjectMethod(cls, g_jni.class_get_name))) : "";
  std::string msg = JString(env, static_cast<jstring>(env->CallObjectMethod(ex, g_jni.throwable_get_message)));
  env->ExceptionClear();
  err->kind = kind;
  err->message = name + (msg.empty() ? "" : ": " + msg);
  env->DeleteLocalRef(ex);
  return true;
}

class JniStream : public Stream {
 public:
  JniStream(JNIEnv* env, jobject socket) { Adopt(env, socket, false); }
  ~JniStream() override {
    JNIEnv* env = Env();
    if (!env) return;
    CloseSocket(env);
    Release(env);
  }

  long Read(uint8_t* buf, size_t len, int timeout_ms, NetError* err) override {
    JNIEnv* env = Env();
    if (!env) return Fail(err, NetErrorKind::kIo, "JNI unavailable");
    if (aborted_) return Fail(err, NetErrorKind::kAborted, "aborted");
    if (timeout_ms != so_timeout_) {
      env->CallVoidMethod(socket_, g_jni.socket_set_so_timeout, std::max(timeout_ms, 1));
      if (TakeException(env, err, NetErrorKind::kIo)) return -1;
      so_timeout_ = timeout_ms;
    }
    jint want = static_cast<jint>(std::min<size_t>(len, kBufSize));
    jint n = env->CallIntMethod(in_, g_jni.is_read, read_buf_, 0, want);
    if (TakeException(env, err, NetErrorKind::kClosed)) {
      if (aborted_) *err = {NetErrorKind::kAborted, "aborted"};
      return -1;
    }
    if (n < 0) return 0;
    env->GetByteArrayRegion(read_buf_, 0, n, reinterpret_cast<jbyte*>(buf));
    return n;
  }

  bool WriteAll(const uint8_t* buf, size_t len, int timeout_ms, NetError* err) override {
    (void)timeout_ms;  // blocking writes; Abort() unblocks them
    JNIEnv* env = Env();
    if (!env) return Fail(err, NetErrorKind::kIo, "JNI unavailable") == 0;
    size_t done = 0;
    while (done < len) {
      if (aborted_) {
        *err = {NetErrorKind::kAborted, "aborted"};
        return false;
      }
      jint n = static_cast<jint>(std::min<size_t>(len - done, kBufSize));
      env->SetByteArrayRegion(write_buf_, 0, n, reinterpret_cast<const jbyte*>(buf + done));
      env->CallVoidMethod(out_, g_jni.os_write, write_buf_, 0, n);
      if (TakeException(env, err, NetErrorKind::kClosed)) {
        if (aborted_) *err = {NetErrorKind::kAborted, "aborted"};
        return false;
      }
      done += static_cast<size_t>(n);
    }
    return true;
  }

  void Abort() override {
    if (aborted_.exchange(true)) return;
    JNIEnv* env = Env();
    if (env) CloseSocket(env);
  }

  bool secure() const override { return secure_; }

  // Layers TLS over the current (connected, possibly tunnelled) socket. The
  // handshake's reads wait at most `timeout_ms` (SO_TIMEOUT); Abort() or
  // closing the socket from another thread interrupts it.
  bool UpgradeToTls(const std::string& host, int port, int timeout_ms, NetError* err) {
    JNIEnv* env = Env();
    LocalFrame frame(env);
    const Jni& j = g_jni;
    jobject factory = env->CallStaticObjectMethod(j.ssl_socket_factory, j.ssf_get_default);
    if (TakeException(env, err, NetErrorKind::kTls)) return false;
    jstring jhost = env->NewStringUTF(host.c_str());
    jobject ssl = env->CallObjectMethod(factory, j.ssf_create_socket, socket_, jhost, port, JNI_TRUE);
    if (TakeException(env, err, NetErrorKind::kTls)) return false;
    jobject params = env->CallObjectMethod(ssl, j.ssl_get_params);
    if (TakeException(env, err, NetErrorKind::kTls)) return false;
    jstring alg = env->NewStringUTF("HTTPS");
    env->CallVoidMethod(params, j.params_set_endpoint_alg, alg);
    if (TakeException(env, err, NetErrorKind::kTls)) return false;
    env->CallVoidMethod(ssl, j.ssl_set_params, params);
    if (TakeException(env, err, NetErrorKind::kTls)) return false;
    // From here on the SSLSocket owns the plain socket (autoClose = true).
    Release(env);
    Adopt(env, ssl, true);
    if (aborted_) {
      CloseSocket(env);
      *err = {NetErrorKind::kAborted, "aborted"};
      return false;
    }
    // Without this the handshake would wait forever on a silent peer
    // (java.net.Socket's default SO_TIMEOUT is 0 = infinite).
    env->CallVoidMethod(socket_, j.socket_set_so_timeout, std::max(timeout_ms, 1));
    if (TakeException(env, err, NetErrorKind::kTls)) return false;
    so_timeout_ = std::max(timeout_ms, 1);
    env->CallVoidMethod(socket_, j.ssl_start_handshake);
    if (TakeException(env, err, NetErrorKind::kTls)) {
      if (aborted_) *err = {NetErrorKind::kAborted, "aborted"};
      else if (err->kind != NetErrorKind::kTimeout) err->kind = NetErrorKind::kTls;
      return false;
    }
    jobject session = env->CallObjectMethod(socket_, j.ssl_get_session);
    jobject verifier = env->CallStaticObjectMethod(j.https_url_connection, j.huc_get_default_verifier);
    if (TakeException(env, err, NetErrorKind::kTls)) return false;
    jboolean ok = env->CallBooleanMethod(verifier, j.verifier_verify, jhost, session);
    if (TakeException(env, err, NetErrorKind::kTls)) return false;
    if (!ok) {
      *err = {NetErrorKind::kTls, "certificate does not match host " + host};
      return false;
    }
    return true;
  }

  bool ok() const { return in_ && out_; }

 private:
  static constexpr size_t kBufSize = 64 * 1024;

  long Fail(NetError* err, NetErrorKind kind, const char* msg) {
    *err = {kind, msg};
    return -1;
  }

  void Adopt(JNIEnv* env, jobject socket, bool secure) {
    std::lock_guard<std::mutex> lock(mu_);
    socket_ = env->NewGlobalRef(socket);
    secure_ = secure;
    so_timeout_ = -1;
    jobject in = env->CallObjectMethod(socket_, g_jni.socket_get_input);
    jobject out = env->ExceptionCheck() ? nullptr : env->CallObjectMethod(socket_, g_jni.socket_get_output);
    env->ExceptionClear();
    in_ = in ? env->NewGlobalRef(in) : nullptr;
    out_ = out ? env->NewGlobalRef(out) : nullptr;
    if (!read_buf_) {
      jbyteArray rb = env->NewByteArray(kBufSize);
      jbyteArray wb = env->NewByteArray(kBufSize);
      read_buf_ = static_cast<jbyteArray>(env->NewGlobalRef(rb));
      write_buf_ = static_cast<jbyteArray>(env->NewGlobalRef(wb));
      env->DeleteLocalRef(rb);
      env->DeleteLocalRef(wb);
    }
    if (in) env->DeleteLocalRef(in);
    if (out) env->DeleteLocalRef(out);
  }

  // Drops references to the socket and its streams (not the buffers).
  void Release(JNIEnv* env) {
    std::lock_guard<std::mutex> lock(mu_);
    if (in_) env->DeleteGlobalRef(in_);
    if (out_) env->DeleteGlobalRef(out_);
    if (socket_) env->DeleteGlobalRef(socket_);
    in_ = out_ = socket_ = nullptr;
    if (read_buf_ && closing_all_) {
      env->DeleteGlobalRef(read_buf_);
      env->DeleteGlobalRef(write_buf_);
      read_buf_ = write_buf_ = nullptr;
    }
  }

  void CloseSocket(JNIEnv* env) {
    std::lock_guard<std::mutex> lock(mu_);
    closing_all_ = true;
    if (socket_) {
      env->CallVoidMethod(socket_, g_jni.socket_close);
      env->ExceptionClear();
    }
  }

  std::mutex mu_;
  jobject socket_ = nullptr;
  jobject in_ = nullptr;
  jobject out_ = nullptr;
  jbyteArray read_buf_ = nullptr;
  jbyteArray write_buf_ = nullptr;
  int so_timeout_ = -1;
  bool secure_ = false;
  bool closing_all_ = false;
  std::atomic<bool> aborted_{false};
};

int64_t NowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

class JniConnector : public Connector {
 public:
  std::unique_ptr<Stream> Connect(const ConnectTarget& target, int timeout_ms, NetError* err,
                                  ConnectCancel* cancel) override {
    JNIEnv* env = Env();
    if (!env || !g_init_ok) {
      *err = {NetErrorKind::kUnsupported, "JNI networking not initialised (InitJniNet)"};
      return nullptr;
    }
    if (cancel && cancel->cancelled()) {
      *err = {NetErrorKind::kAborted, "aborted"};
      return nullptr;
    }
    int64_t deadline = NowMs() + timeout_ms;
    auto remaining = [&] { return static_cast<int>(std::max<int64_t>(1, deadline - NowMs())); };
    LocalFrame frame(env);
    const Jni& j = g_jni;
    std::string host = target.host;
    if (host.size() > 2 && host.front() == '[') host = host.substr(1, host.size() - 2);
    ParsedUrl probe;
    bool loopback = ParseUrl("http://" + target.host + "/", &probe) && probe.IsLoopback();

    // System proxy for this origin (HTTP proxies only; DIRECT otherwise).
    std::string proxy_host;
    int proxy_port = 0;
    if (!loopback && !target.proxy_lookup_url.empty()) {
      jstring jurl = env->NewStringUTF(target.proxy_lookup_url.c_str());
      jobject uri = env->CallStaticObjectMethod(j.uri, j.uri_create, jurl);
      jobject selector = uri ? env->CallStaticObjectMethod(j.proxy_selector, j.ps_get_default) : nullptr;
      jobject list = selector ? env->CallObjectMethod(selector, j.ps_select, uri) : nullptr;
      if (env->ExceptionCheck()) {
        env->ExceptionClear();
      } else if (list && env->CallIntMethod(list, j.list_size) > 0) {
        jobject proxy = env->CallObjectMethod(list, j.list_get, 0);
        jobject type = env->CallObjectMethod(proxy, j.proxy_type_m);
        std::string type_name = JString(env, static_cast<jstring>(env->CallObjectMethod(type, j.enum_name)));
        if (type_name == "HTTP") {
          jobject addr = env->CallObjectMethod(proxy, j.proxy_address);
          if (addr && env->IsInstanceOf(addr, j.inet_socket_address)) {
            proxy_host = JString(env, static_cast<jstring>(env->CallObjectMethod(addr, j.isa_get_host_string)));
            proxy_port = env->CallIntMethod(addr, j.isa_get_port);
          }
        }
        env->ExceptionClear();
      }
    }

    bool via_proxy = !proxy_host.empty() && proxy_port > 0;
    jobject socket = env->NewObject(j.socket, j.socket_ctor);
    if (TakeException(env, err, NetErrorKind::kIo) || !socket) return nullptr;
    // Abort()/the deadline close the socket from another thread: that
    // unblocks Socket.connect(), the proxy tunnel and the TLS handshake.
    // (Name resolution in InetSocketAddress cannot be interrupted; it is
    // bounded by the system resolver's own timeouts.)
    jobject gsocket = env->NewGlobalRef(socket);
    struct Interruptible {
      ConnectCancel* cancel;
      jobject gsocket;
      ~Interruptible() {
        if (cancel) cancel->Disarm();
        if (JNIEnv* e = Env()) e->DeleteGlobalRef(gsocket);
      }
    } guard{cancel, gsocket};
    if (cancel && !cancel->Arm([gsocket] {
          if (JNIEnv* e = Env()) {
            e->CallVoidMethod(gsocket, g_jni.socket_close);
            e->ExceptionClear();
          }
        })) {
      *err = {NetErrorKind::kAborted, "aborted"};
      return nullptr;
    }
    auto aborted = [&] { return cancel && cancel->cancelled(); };
    jstring jhost = env->NewStringUTF((via_proxy ? proxy_host : host).c_str());
    jobject addr = env->NewObject(j.inet_socket_address, j.isa_ctor, jhost, via_proxy ? proxy_port : target.port);
    if (TakeException(env, err, NetErrorKind::kDns)) return nullptr;
    if (aborted()) {
      *err = {NetErrorKind::kAborted, "aborted"};
      return nullptr;
    }
    env->CallVoidMethod(socket, j.socket_connect, addr, remaining());
    if (TakeException(env, err, NetErrorKind::kConnect)) {
      env->CallVoidMethod(socket, j.socket_close);
      env->ExceptionClear();
      if (aborted()) *err = {NetErrorKind::kAborted, "aborted"};
      return nullptr;
    }
    env->CallVoidMethod(socket, j.socket_set_tcp_no_delay, JNI_TRUE);
    env->ExceptionClear();
    auto stream = std::make_unique<JniStream>(env, socket);
    if (!stream->ok()) {
      *err = {NetErrorKind::kIo, "socket has no streams"};
      return nullptr;
    }
    if (via_proxy && !ProxyConnectTunnel(stream.get(), target.host, target.port, remaining(), err)) {
      if (aborted()) *err = {NetErrorKind::kAborted, "aborted"};
      return nullptr;
    }
    if (target.tls && !stream->UpgradeToTls(host, target.port, remaining(), err)) {
      if (aborted()) *err = {NetErrorKind::kAborted, "aborted"};
      return nullptr;
    }
    if (aborted()) {
      *err = {NetErrorKind::kAborted, "aborted"};
      return nullptr;
    }
    return stream;
  }
};

}  // namespace

bool InitJniNet(JavaVM* vm) {
  std::call_once(g_init_once, [vm] {
    g_vm = vm;
    JNIEnv* env = Env();
    g_init_ok = env && LoadJni(env);
    if (env) env->ExceptionClear();
  });
  return g_init_ok;
}

std::unique_ptr<Connector> MakeJniConnector() { return std::make_unique<JniConnector>(); }

}  // namespace iwn::net
