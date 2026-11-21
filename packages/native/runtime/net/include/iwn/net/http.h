// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// HTTP/1.1 client core for fetch/XHR (spec NET-5, NET-6, NET-7):
// RFC 9110 semantics, RFC 9112 message syntax, Fetch's redirect rules
// (method rewrite, body drop, Authorization strip on cross-origin, 20-hop
// limit, modes follow/error/manual), the origin allowlist checked on every
// hop, gzip/deflate decoding, keep-alive connection reuse, abort, timeouts
// and byte-window flow control. Listeners are called on worker threads.

#ifndef IWN_NET_HTTP_H_
#define IWN_NET_HTTP_H_

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "iwn/net/stream.h"
#include "iwn/net/url.h"

namespace iwn::net {

using HeaderList = std::vector<std::pair<std::string, std::string>>;

enum class RedirectMode { kFollow = 0, kError = 1, kManual = 2 };

struct HttpRequest {
  std::string url;
  std::string method = "GET";
  HeaderList headers;
  std::shared_ptr<const std::vector<uint8_t>> body;  // may be null
  RedirectMode redirect = RedirectMode::kFollow;
  // Bounds each blocking step: connect + tunnel + TLS handshake together,
  // each write, and the wait for every read (inactivity timeout).
  int timeout_ms = 60000;
  // false: deliver the body without waiting for Ack() (synchronous requests
  // whose consumer buffers everything).
  bool flow_control = true;
};

struct HttpResponseHead {
  int status = 0;
  std::string status_text;
  HeaderList headers;     // names lower-cased, order kept, Set-Cookie removed
  std::string url;        // final URL
  bool redirected = false;
  // RedirectMode::kManual stopped at a redirect: the Fetch "opaque-redirect"
  // filtered response (status 0 to JS, no headers, no body).
  bool opaque_redirect = false;
};

class HttpListener {
 public:
  virtual ~HttpListener() = default;
  virtual void OnHead(HttpResponseHead head) = 0;
  virtual void OnData(std::vector<uint8_t> chunk) = 0;
  virtual void OnEnd() = 0;
  // Called at most once, instead of OnHead or after it (body failure).
  virtual void OnError(NetError error) = 0;
};

// Incremental parser for one HTTP/1.1 response.
class HttpResponseParser {
 public:
  enum class State { kHead, kBody, kDone, kError };
  // `head_request`: the request method was HEAD (no body).
  void Reset(bool head_request);
  // Consumes bytes; decoded (de-chunked, not decompressed) body bytes are
  // appended to *body. Returns bytes consumed; stops after the head when
  // stop_after_head is set, so the caller can inspect it first.
  size_t Feed(const uint8_t* data, size_t len, std::vector<uint8_t>* body, bool stop_after_head = false);
  // The peer closed the connection.
  void OnEof();

  State state() const { return state_; }
  const std::string& error() const { return error_; }
  int status() const { return status_; }
  const std::string& reason() const { return reason_; }
  const HeaderList& headers() const { return headers_; }  // raw names
  bool keep_alive() const { return keep_alive_; }
  // First value of a header (case-insensitive), or nullptr.
  const std::string* Find(const std::string& name) const;
  int http_minor() const { return minor_; }

 private:
  bool ParseHead(const std::string& head);
  void StartBody();
  enum class BodyMode { kNone, kLength, kChunked, kUntilClose };
  enum class ChunkState { kSize, kData, kDataCrlf, kTrailer };

  State state_ = State::kHead;
  bool head_request_ = false;
  std::string head_buf_;
  std::string error_;
  int status_ = 0;
  int minor_ = 1;
  std::string reason_;
  HeaderList headers_;
  bool keep_alive_ = true;
  BodyMode body_mode_ = BodyMode::kNone;
  uint64_t remaining_ = 0;
  ChunkState chunk_state_ = ChunkState::kSize;
  std::string line_buf_;
};

struct HttpClientOptions {
  std::string user_agent = "iwer-native";
  int max_redirects = 20;
  int idle_connection_ms = 30000;
  size_t flow_window_bytes = 1 << 20;  // undelivered-unacked bytes before reads pause
  size_t read_chunk_bytes = 256 * 1024;
  // Largest decoded chunk handed to the listener at once (gzip output is cut
  // into pieces of this size, each waiting for the flow window).
  size_t max_chunk_bytes = 256 * 1024;
  // Requests run on a pool of worker threads; requests beyond the limits
  // wait in a queue without a thread. Like browsers' HTTP/1.1 pools: at most
  // `max_per_origin` running requests per origin (of the request URL),
  // `max_threads` in total.
  int max_per_origin = 6;
  int max_threads = 32;
  int idle_thread_ms = 30000;  // idle pool threads exit after this
};

class HttpClient;

// One in-flight request. Methods are thread-safe.
class HttpJob {
 public:
  // Cancels the request; the listener gets OnError(kAborted) unless it
  // already finished.
  void Abort();
  // The consumer took `bytes` of delivered body: lets the reader continue.
  void Ack(size_t bytes);

 private:
  friend class HttpClient;
  friend struct HttpJobRunner;
  std::mutex mu_;
  std::condition_variable cv_;
  std::atomic<bool> aborted_{false};
  size_t in_flight_ = 0;
  std::shared_ptr<Stream> stream_;                  // current connection, for Abort()
  std::shared_ptr<ConnectCancel> connect_cancel_;   // connect in progress, for Abort()
  std::function<void()> on_abort_queued_;           // removes the job from the client's queue
};

class HttpClient {
 public:
  HttpClient(std::shared_ptr<Connector> connector, HttpClientOptions options = {});
  ~HttpClient();  // aborts running jobs and waits for their threads
  HttpClient(const HttpClient&) = delete;
  HttpClient& operator=(const HttpClient&) = delete;

  void SetAllowlist(const OriginAllowlist& allowlist);
  OriginAllowlist allowlist() const;

  // Starts a worker for the request. Validation errors (bad URL, blocked
  // origin, forbidden method) are reported through the listener as well.
  std::shared_ptr<HttpJob> Start(HttpRequest request, std::shared_ptr<HttpListener> listener);

  // Aborts every job and drops pooled connections (app exit).
  void AbortAll();

  struct Stats {
    int queued = 0;
    int running = 0;
    int threads = 0;
  };
  Stats stats() const;

  struct Shared;  // implementation detail, public for the worker

 private:
  std::shared_ptr<Shared> shared_;
};

// A whole request run to completion on the calling thread (synchronous XHR in
// worker isolates, NET-11). The body is buffered without flow control.
// `total_timeout_ms` (> 0) bounds the whole request; when it passes the job is
// aborted and `timed_out` is set.
struct BlockingResult {
  HttpResponseHead head;
  std::vector<uint8_t> body;
  NetError error;  // kNone on success
  bool timed_out = false;
};
BlockingResult FetchBlocking(HttpClient& client, HttpRequest request, int total_timeout_ms);

// RFC 9110 / Fetch: request headers the page may not set; they are dropped
// (the JS layer drops them too).
bool IsForbiddenRequestHeader(const std::string& lower_name);

}  // namespace iwn::net

#endif  // IWN_NET_HTTP_H_
