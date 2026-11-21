// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

#include <zlib.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <deque>
#include <map>
#include <set>
#include <system_error>
#include <thread>

#include "iwn/net/http.h"
#include "iwn/net/util.h"
#include "iwn/net/watchdog.h"

namespace iwn::net {

bool IsForbiddenRequestHeader(const std::string& n) {
  // Fetch §2.2.2 "forbidden request-header" (names the runtime owns).
  static const char* kNames[] = {
      "accept-charset", "accept-encoding", "access-control-request-headers",
      "access-control-request-method", "connection", "content-length", "cookie", "cookie2", "date", "dnt",
      "expect", "host", "keep-alive", "origin", "referer", "set-cookie", "te", "trailer",
      "transfer-encoding", "upgrade", "via"};
  for (const char* k : kNames) {
    if (n == k) return true;
  }
  return n.rfind("proxy-", 0) == 0 || n.rfind("sec-", 0) == 0;
}

namespace {

int64_t NowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

// gzip / zlib / raw-deflate decoder (Content-Encoding: gzip, x-gzip, deflate).
// Output is produced in bounded pieces so a highly compressible body cannot
// turn one socket read into an unbounded buffer (the flow window applies to
// decoded bytes).
class Inflater {
 public:
  explicit Inflater(bool deflate) : deflate_(deflate) { Init(deflate ? 15 : 15 + 16); }
  ~Inflater() { inflateEnd(&zs_); }

  // Takes the next compressed bytes (call when HasMore() is false).
  void SetInput(std::vector<uint8_t>* raw) {
    input_.swap(*raw);
    raw->clear();
    zs_.next_in = input_.empty() ? nullptr : input_.data();
    zs_.avail_in = static_cast<uInt>(input_.size());
  }
  // True while the current input can still produce output.
  bool HasMore() const { return !finished_ && (zs_.avail_in > 0 || output_pending_); }

  // Appends at most `max_out` decoded bytes to *out. Returns false on corrupt data.
  bool Inflate(std::vector<uint8_t>* out, size_t max_out) {
    size_t start = out->size();
    while (!finished_ && out->size() - start < max_out) {
      if (zs_.avail_in == 0 && !output_pending_) break;
      size_t room = std::min<size_t>(64 * 1024, max_out - (out->size() - start));
      size_t old = out->size();
      out->resize(old + room);
      zs_.next_out = out->data() + old;
      zs_.avail_out = static_cast<uInt>(room);
      int r = inflate(&zs_, Z_NO_FLUSH);
      size_t produced = room - zs_.avail_out;
      out->resize(old + produced);
      if (r == Z_DATA_ERROR && deflate_ && !tried_raw_ && total_out_ == 0) {
        // "deflate" bodies are often raw DEFLATE without the zlib wrapper.
        tried_raw_ = true;
        inflateEnd(&zs_);
        Init(-15);
        zs_.next_in = input_.empty() ? nullptr : input_.data();
        zs_.avail_in = static_cast<uInt>(input_.size());
        output_pending_ = false;
        continue;
      }
      if (r != Z_OK && r != Z_STREAM_END && r != Z_BUF_ERROR) return false;
      total_out_ += produced;
      output_pending_ = zs_.avail_out == 0;  // zlib may hold more output for this input
      if (r == Z_STREAM_END) {
        finished_ = true;  // trailing garbage after the stream is ignored
        output_pending_ = false;
        break;
      }
      if (r == Z_BUF_ERROR && produced == 0) {
        output_pending_ = false;
        break;
      }
    }
    return true;
  }

 private:
  void Init(int window_bits) {
    std::memset(&zs_, 0, sizeof zs_);
    inflateInit2(&zs_, window_bits);
  }
  z_stream zs_;
  bool deflate_;
  bool tried_raw_ = false;
  bool finished_ = false;
  bool output_pending_ = false;
  size_t total_out_ = 0;
  std::vector<uint8_t> input_;
};

struct PooledConn {
  std::shared_ptr<Stream> stream;
  int64_t idle_since = 0;
};

}  // namespace

struct QueuedRequest {
  std::shared_ptr<HttpJob> job;
  HttpRequest request;
  std::shared_ptr<HttpListener> listener;
  std::string origin;  // per-origin limit key
};

struct HttpClient::Shared : std::enable_shared_from_this<HttpClient::Shared> {
  std::shared_ptr<Connector> connector;
  HttpClientOptions options;
  mutable std::mutex mu;
  std::condition_variable work_cv;  // pool threads wait for runnable requests
  std::condition_variable done_cv;  // the destructor waits for `active` to drain
  OriginAllowlist allowlist;
  std::map<std::string, std::vector<PooledConn>> pool;  // key: "https://host:port"
  std::deque<QueuedRequest> queue;
  std::map<std::string, int> running_per_origin;
  std::set<std::shared_ptr<HttpJob>> active;  // queued + running
  int running = 0;
  int threads = 0;
  int idle = 0;
  int wakeups = 0;   // work_cv notifications no idle thread has taken yet
  int starting = 0;  // threads created that have not looked at the queue yet
  bool shutting_down = false;

  std::shared_ptr<Stream> TakePooled(const std::string& key) {
    std::lock_guard<std::mutex> lock(mu);
    auto it = pool.find(key);
    if (it == pool.end()) return nullptr;
    int64_t now = NowMs();
    while (!it->second.empty()) {
      PooledConn c = std::move(it->second.back());
      it->second.pop_back();
      if (now - c.idle_since < options.idle_connection_ms) return c.stream;
    }
    return nullptr;
  }
  void ReturnPooled(const std::string& key, std::shared_ptr<Stream> s) {
    std::lock_guard<std::mutex> lock(mu);
    if (shutting_down) return;
    auto& v = pool[key];
    if (v.size() >= 6) v.erase(v.begin());
    v.push_back({std::move(s), NowMs()});
  }

  // mu held.
  bool OriginHasRoom(const std::string& origin) const {
    auto it = running_per_origin.find(origin);
    return it == running_per_origin.end() || it->second < options.max_per_origin;
  }
  // Queued requests that could start now: those whose origin stays under the
  // limit together with the runnable requests ahead of them.
  int RunnableCount() const {
    int n = 0;
    std::map<std::string, int> ahead;
    for (const auto& q : queue) {
      auto it = running_per_origin.find(q.origin);
      int& taken = ahead[q.origin];
      if ((it == running_per_origin.end() ? 0 : it->second) + taken < options.max_per_origin) {
        ++taken;
        ++n;
      }
    }
    return n;
  }
  bool TakeRunnable(QueuedRequest* out) {
    for (auto it = queue.begin(); it != queue.end(); ++it) {
      if (!OriginHasRoom(it->origin)) continue;
      *out = std::move(*it);
      queue.erase(it);
      return true;
    }
    return false;
  }

  // Removes a still-queued job (HttpJob::Abort); it then fails with kAborted.
  void CancelQueued(HttpJob* job) {
    std::shared_ptr<HttpListener> listener;
    {
      std::lock_guard<std::mutex> lock(mu);
      for (auto it = queue.begin(); it != queue.end(); ++it) {
        if (it->job.get() != job) continue;
        listener = std::move(it->listener);
        active.erase(it->job);
        queue.erase(it);
        break;
      }
      done_cv.notify_all();
    }
    if (listener) listener->OnError(NetError{NetErrorKind::kAborted, "aborted"});
  }

  // mu held via `lock`. Gives every runnable queued request a pool thread on
  // its way: wakes idle threads first and starts new ones only when none is
  // left. A wake-up stays counted until an idle thread takes it, so a burst of
  // Start() calls cannot all lean on one idle thread that has not run yet.
  // Requests waiting for their origin's limit get no thread: the thread that
  // finishes one of that origin's requests takes the next. Returns false if
  // no thread can run the queue (thread creation failed and none exists).
  bool Dispatch(std::unique_lock<std::mutex>& lock) {
    for (int missing = RunnableCount() - (wakeups + starting); missing > 0; --missing) {
      if (idle > wakeups) {
        ++wakeups;
        work_cv.notify_one();
        continue;
      }
      if (threads >= options.max_threads) break;  // a running job will pick it up
      try {
        std::thread([self = shared_from_this()] { self->WorkerMain(); }).detach();
      } catch (const std::system_error&) {
        return threads > 0;
      }
      ++threads;
      ++starting;
    }
    return true;
  }

  void WorkerMain();
  void RunOne(QueuedRequest& q);
};

void HttpJob::Abort() {
  std::shared_ptr<Stream> s;
  std::shared_ptr<ConnectCancel> c;
  {
    std::lock_guard<std::mutex> lock(mu_);
    aborted_ = true;
    s = stream_;
    c = connect_cancel_;
  }
  if (c) c->Cancel();
  if (s) s->Abort();
  cv_.notify_all();
  if (on_abort_queued_) on_abort_queued_();
}

void HttpJob::Ack(size_t bytes) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    in_flight_ = bytes > in_flight_ ? 0 : in_flight_ - bytes;
  }
  cv_.notify_all();
}

struct HttpJobRunner {
  std::shared_ptr<HttpClient::Shared> shared;
  std::shared_ptr<HttpJob> job;
  HttpRequest req;
  std::shared_ptr<HttpListener> listener;
  bool head_sent = false;

  bool Aborted() const { return job->aborted_.load(); }

  void Fail(NetErrorKind kind, std::string message) {
    if (Aborted() && kind != NetErrorKind::kBlocked) kind = NetErrorKind::kAborted;
    listener->OnError(NetError{kind, std::move(message)});
  }

  void SetStream(std::shared_ptr<Stream> s) {
    std::lock_guard<std::mutex> lock(job->mu_);
    job->stream_ = std::move(s);
    if (job->aborted_ && job->stream_) job->stream_->Abort();
  }

  // DNS + TCP + proxy tunnel + TLS handshake, bounded by the request timeout
  // and interruptible by Abort() (NET-6), whatever the connector does.
  std::unique_ptr<Stream> Connect(const ConnectTarget& target, NetError* err) {
    auto cancel = std::make_shared<ConnectCancel>();
    {
      std::lock_guard<std::mutex> lock(job->mu_);
      if (job->aborted_) {
        *err = {NetErrorKind::kAborted, "aborted"};
        return nullptr;
      }
      job->connect_cancel_ = cancel;
    }
    std::unique_ptr<Stream> s;
    bool fired;
    {
      WatchdogScope deadline(req.timeout_ms, [cancel] { cancel->Cancel(); });
      s = shared->connector->Connect(target, req.timeout_ms, err, cancel.get());
      fired = deadline.Disarm();
    }
    {
      std::lock_guard<std::mutex> lock(job->mu_);
      job->connect_cancel_.reset();
    }
    if (!s && fired && !Aborted()) {
      *err = {NetErrorKind::kTimeout, "connecting to " + target.host + " took longer than " +
                                          std::to_string(req.timeout_ms) + " ms"};
    }
    return s;
  }

  // WriteAll bounded by the request timeout (the JNI transport has no write timeout).
  bool Write(const std::shared_ptr<Stream>& stream, const uint8_t* data, size_t len, NetError* err) {
    bool ok, fired;
    {
      WatchdogScope deadline(req.timeout_ms, [stream] { stream->Abort(); });
      ok = stream->WriteAll(data, len, req.timeout_ms, err);
      fired = deadline.Disarm();
    }
    if (fired && !Aborted()) {
      *err = {NetErrorKind::kTimeout, "sending the request took longer than " + std::to_string(req.timeout_ms) + " ms"};
      return false;
    }
    return ok;
  }

  std::string BuildRequest(const ParsedUrl& url, const std::string& method, const HeaderList& headers,
                           const std::vector<uint8_t>* body) {
    std::string out;
    out.reserve(512);
    out += method;
    out += ' ';
    out += url.path_query;
    out += " HTTP/1.1\r\nHost: ";
    out += url.HostHeader();
    out += "\r\n";
    bool has_ua = false, has_accept = false;
    for (const auto& h : headers) {
      std::string lower = AsciiLowerStr(h.first);
      if (IsForbiddenRequestHeader(lower)) continue;
      if (lower == "user-agent") has_ua = true;
      if (lower == "accept") has_accept = true;
      out += h.first;
      out += ": ";
      out += h.second;
      out += "\r\n";
    }
    if (!has_ua) out += "User-Agent: " + shared->options.user_agent + "\r\n";
    if (!has_accept) out += "Accept: */*\r\n";
    out += "Accept-Encoding: gzip, deflate\r\nConnection: keep-alive\r\n";
    bool needs_length = body || method == "POST" || method == "PUT" || method == "PATCH";
    if (needs_length) out += "Content-Length: " + std::to_string(body ? body->size() : 0) + "\r\n";
    out += "\r\n";
    return out;
  }

  // Waits until the consumer has room for more body bytes.
  bool WaitForWindow() {
    std::unique_lock<std::mutex> lock(job->mu_);
    if (!req.flow_control) return !job->aborted_;
    job->cv_.wait(lock, [&] { return job->aborted_ || job->in_flight_ < shared->options.flow_window_bytes; });
    return !job->aborted_;
  }

  void Deliver(std::vector<uint8_t>* chunk) {
    if (chunk->empty()) return;
    {
      std::lock_guard<std::mutex> lock(job->mu_);
      job->in_flight_ += chunk->size();
    }
    listener->OnData(std::move(*chunk));
    chunk->clear();
  }

  void Run() {
    std::string method = req.method;
    HeaderList headers = req.headers;
    std::shared_ptr<const std::vector<uint8_t>> body = req.body;
    std::string url_str = req.url;
    bool redirected = false;
    for (int hop = 0;; ++hop) {
      ParsedUrl url;
      std::string why;
      if (!ParseUrl(url_str, &url, &why) || (url.scheme != "http" && url.scheme != "https")) {
        return Fail(NetErrorKind::kProtocol, "invalid URL " + url_str + ": " + why);
      }
      if (url.has_userinfo) return Fail(NetErrorKind::kProtocol, "URL includes credentials");
      OriginAllowlist::Verdict verdict;
      {
        std::lock_guard<std::mutex> lock(shared->mu);
        verdict = shared->allowlist.Check(url);
      }
      if (verdict != OriginAllowlist::Verdict::kAllowed) {
        return Fail(NetErrorKind::kBlocked,
                    url.HttpOrigin() + (verdict == OriginAllowlist::Verdict::kCleartextBlocked
                                            ? " (cleartext http is allowed only to loopback in debug builds)"
                                            : " is not in native.network.allow"));
      }
      std::string key = url.HttpOrigin();
      bool reused = false;
      std::shared_ptr<Stream> stream;
      HttpResponseParser parser;
      std::vector<uint8_t> raw_body;
      std::vector<uint8_t> buf(shared->options.read_chunk_bytes);
      bool got_response_bytes = false;
      // Up to two attempts: a reused keep-alive connection may have been
      // closed by the server while idle.
      for (int attempt = 0; attempt < 2; ++attempt) {
        if (Aborted()) return Fail(NetErrorKind::kAborted, "aborted");
        stream = attempt == 0 ? shared->TakePooled(key) : nullptr;
        reused = stream != nullptr;
        if (!stream) {
          NetError err;
          ConnectTarget target{url.host, url.port, url.secure(), key};
          std::unique_ptr<Stream> s = Connect(target, &err);
          if (!s) return Fail(err.kind, err.message);
          stream = std::move(s);
        }
        SetStream(stream);
        std::string head = BuildRequest(url, method, headers, body.get());
        NetError err;
        bool ok = Write(stream, reinterpret_cast<const uint8_t*>(head.data()), head.size(), &err);
        if (ok && body && !body->empty()) ok = Write(stream, body->data(), body->size(), &err);
        parser.Reset(method == "HEAD");
        got_response_bytes = false;
        int64_t deadline = NowMs() + req.timeout_ms;
        while (ok && parser.state() == HttpResponseParser::State::kHead) {
          int remaining = static_cast<int>(deadline - NowMs());
          if (remaining <= 0) {
            err = {NetErrorKind::kTimeout, "no response within " + std::to_string(req.timeout_ms) + " ms"};
            ok = false;
            break;
          }
          long n = stream->Read(buf.data(), buf.size(), remaining, &err);
          if (n < 0) {
            ok = false;
            break;
          }
          if (n == 0) {
            parser.OnEof();
            if (!got_response_bytes) {
              err = {NetErrorKind::kClosed, "connection closed before the response"};
              ok = false;
            }
            break;
          }
          got_response_bytes = true;
          size_t used = parser.Feed(buf.data(), static_cast<size_t>(n), &raw_body, true);
          if (parser.state() != HttpResponseParser::State::kHead && used < static_cast<size_t>(n)) {
            parser.Feed(buf.data() + used, static_cast<size_t>(n) - used, &raw_body);
          }
        }
        if (ok && parser.state() == HttpResponseParser::State::kError) {
          return Fail(NetErrorKind::kProtocol, parser.error());
        }
        if (ok) break;
        if (Aborted()) return Fail(NetErrorKind::kAborted, "aborted");
        if (reused && !got_response_bytes && attempt == 0 && err.kind != NetErrorKind::kTimeout) continue;  // stale pooled connection
        return Fail(err.kind, err.message);
      }

      int status = parser.status();
      const std::string* location = parser.Find("location");
      bool is_redirect = (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) && location;
      if (is_redirect && req.redirect != RedirectMode::kFollow) {
        if (req.redirect == RedirectMode::kError) {
          return Fail(NetErrorKind::kProtocol, "redirect to " + *location + " with redirect mode 'error'");
        }
        HttpResponseHead h;
        h.opaque_redirect = true;
        h.url = url_str;
        h.redirected = redirected;
        head_sent = true;
        listener->OnHead(std::move(h));
        if (!Aborted()) listener->OnEnd();
        return;
      }
      if (is_redirect) {
        if (hop + 1 > shared->options.max_redirects) return Fail(NetErrorKind::kProtocol, "too many redirects");
        std::string next;
        if (!ResolveRedirect(url, *location, &next)) {
          return Fail(NetErrorKind::kProtocol, "bad redirect location: " + *location);
        }
        // Drain a small body so the connection can be reused; otherwise drop it.
        bool reusable = parser.keep_alive();
        int64_t drained = 0;
        while (reusable && parser.state() == HttpResponseParser::State::kBody && drained < 64 * 1024) {
          NetError err;
          long n = stream->Read(buf.data(), buf.size(), req.timeout_ms, &err);
          if (n <= 0) {
            reusable = false;
            break;
          }
          raw_body.clear();
          parser.Feed(buf.data(), static_cast<size_t>(n), &raw_body);
          drained += n;
        }
        SetStream(nullptr);
        if (reusable && parser.state() == HttpResponseParser::State::kDone) shared->ReturnPooled(key, stream);
        // Fetch §4.4 HTTP-redirect fetch, steps 11-13.
        bool drop_body = ((status == 301 || status == 302) && method == "POST") ||
                         (status == 303 && method != "GET" && method != "HEAD");
        if (drop_body) {
          if (method != "HEAD") method = "GET";
          body.reset();
          HeaderList kept;
          for (auto& h : headers) {
            std::string n = AsciiLowerStr(h.first);
            if (n == "content-type" || n == "content-encoding" || n == "content-language" ||
                n == "content-location" || n == "content-length") {
              continue;
            }
            kept.push_back(h);
          }
          headers.swap(kept);
        }
        ParsedUrl next_url;
        if (ParseUrl(next, &next_url) && next_url.HttpOrigin() != url.HttpOrigin()) {
          headers.erase(std::remove_if(headers.begin(), headers.end(),
                                       [](const auto& h) { return EqualsIgnoreCase(h.first, "authorization"); }),
                        headers.end());
        }
        url_str = next;
        redirected = true;
        continue;
      }

      // Final response.
      HttpResponseHead h;
      h.status = status;
      h.status_text = parser.reason();
      h.url = url.Href();
      h.redirected = redirected;
      for (const auto& kv : parser.headers()) {
        std::string n = AsciiLowerStr(kv.first);
        if (n == "set-cookie" || n == "set-cookie2") continue;  // no cookie jar (documented)
        h.headers.emplace_back(std::move(n), kv.second);
      }
      std::unique_ptr<Inflater> inflater;
      if (const std::string* ce = parser.Find("content-encoding")) {
        std::string v = AsciiLowerStr(TrimHttpWhitespace(*ce));
        if (v == "gzip" || v == "x-gzip") inflater = std::make_unique<Inflater>(false);
        else if (v == "deflate") inflater = std::make_unique<Inflater>(true);
      }
      head_sent = true;
      listener->OnHead(std::move(h));
      std::vector<uint8_t> out;
      // 0 ok, 1 corrupt compressed data, 2 aborted while waiting for the window.
      auto push = [&](std::vector<uint8_t>* raw) -> int {
        if (raw->empty()) return 0;
        if (!inflater) {
          out.swap(*raw);
          raw->clear();
          Deliver(&out);
          return 0;
        }
        inflater->SetInput(raw);
        while (inflater->HasMore()) {
          if (!inflater->Inflate(&out, shared->options.max_chunk_bytes)) return 1;
          Deliver(&out);
          if (inflater->HasMore() && !WaitForWindow()) return 2;
        }
        return 0;
      };
      auto push_failed = [&](int r) {
        if (r == 1) Fail(NetErrorKind::kProtocol, "corrupt compressed body");
        else Fail(NetErrorKind::kAborted, "aborted");
      };
      if (int r = push(&raw_body)) return push_failed(r);
      while (parser.state() == HttpResponseParser::State::kBody) {
        if (!WaitForWindow()) return Fail(NetErrorKind::kAborted, "aborted");
        NetError err;
        long n = stream->Read(buf.data(), buf.size(), req.timeout_ms, &err);
        if (n < 0) return Fail(err.kind, err.message);
        if (n == 0) {
          parser.OnEof();
          break;
        }
        parser.Feed(buf.data(), static_cast<size_t>(n), &raw_body);
        if (int r = push(&raw_body)) return push_failed(r);
      }
      if (parser.state() != HttpResponseParser::State::kDone) {
        return Fail(NetErrorKind::kClosed, parser.error().empty() ? "incomplete body" : parser.error());
      }
      SetStream(nullptr);
      if (parser.keep_alive() && !Aborted()) shared->ReturnPooled(key, stream);
      if (Aborted()) return Fail(NetErrorKind::kAborted, "aborted");
      listener->OnEnd();
      return;
    }
  }
};

void HttpClient::Shared::RunOne(QueuedRequest& q) {
  if (q.job->aborted_) {
    q.listener->OnError(NetError{NetErrorKind::kAborted, "aborted"});
  } else {
    HttpJobRunner runner{shared_from_this(), q.job, std::move(q.request), q.listener};
    runner.Run();
  }
  std::lock_guard<std::mutex> lock(q.job->mu_);
  q.job->stream_.reset();
  q.job->connect_cancel_.reset();
}

void HttpClient::Shared::WorkerMain() {
  SetCurrentThreadName("iwn-http");
  std::unique_lock<std::mutex> lock(mu);
  --starting;
  for (;;) {
    QueuedRequest q;
    if (TakeRunnable(&q)) {
      ++running;
      ++running_per_origin[q.origin];
      lock.unlock();
      RunOne(q);
      q.listener.reset();  // outside the lock: listeners may post work
      lock.lock();
      --running;
      auto it = running_per_origin.find(q.origin);
      if (it != running_per_origin.end() && --it->second <= 0) running_per_origin.erase(it);
      active.erase(q.job);
      done_cv.notify_all();
      continue;
    }
    if (shutting_down && queue.empty()) break;
    ++idle;
    bool woke = work_cv.wait_for(lock, std::chrono::milliseconds(options.idle_thread_ms),
                                 [&] { return shutting_down || wakeups > 0; });
    --idle;
    if (wakeups > 0) {
      --wakeups;  // any idle thread may take a wake-up; it then scans the queue
    } else if (!woke) {
      break;  // idle for too long
    }
  }
  --threads;
  done_cv.notify_all();
}

HttpClient::HttpClient(std::shared_ptr<Connector> connector, HttpClientOptions options)
    : shared_(std::make_shared<Shared>()) {
  shared_->connector = std::move(connector);
  shared_->options = std::move(options);
}

HttpClient::~HttpClient() {
  AbortAll();
  std::unique_lock<std::mutex> lock(shared_->mu);
  shared_->shutting_down = true;
  shared_->work_cv.notify_all();
  shared_->done_cv.wait(lock, [&] { return shared_->active.empty(); });
}

void HttpClient::SetAllowlist(const OriginAllowlist& allowlist) {
  std::lock_guard<std::mutex> lock(shared_->mu);
  shared_->allowlist = allowlist;
}

OriginAllowlist HttpClient::allowlist() const {
  std::lock_guard<std::mutex> lock(shared_->mu);
  return shared_->allowlist;
}

HttpClient::Stats HttpClient::stats() const {
  std::lock_guard<std::mutex> lock(shared_->mu);
  return Stats{static_cast<int>(shared_->queue.size()), shared_->running, shared_->threads};
}

void HttpClient::AbortAll() {
  std::set<std::shared_ptr<HttpJob>> jobs;
  {
    std::lock_guard<std::mutex> lock(shared_->mu);
    jobs = shared_->active;
    shared_->pool.clear();
  }
  for (auto& j : jobs) j->Abort();
}

std::shared_ptr<HttpJob> HttpClient::Start(HttpRequest request, std::shared_ptr<HttpListener> listener) {
  auto job = std::make_shared<HttpJob>();
  std::string lower_method = AsciiLowerStr(request.method);
  if (!IsHttpToken(request.method) || lower_method == "connect" || lower_method == "trace" ||
      lower_method == "track") {
    listener->OnError(NetError{NetErrorKind::kProtocol, "forbidden method " + request.method});
    return job;
  }
  for (const auto& h : request.headers) {
    if (!IsHttpToken(h.first) || !IsValidHeaderValue(h.second)) {
      listener->OnError(NetError{NetErrorKind::kProtocol, "invalid header " + h.first});
      return job;
    }
  }
  if (request.timeout_ms <= 0) request.timeout_ms = 60000;
  // Normalise well-known methods to upper case (Fetch "normalize").
  static const char* kNormalized[] = {"DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"};
  for (const char* m : kNormalized) {
    if (EqualsIgnoreCase(request.method, m)) request.method = m;
  }
  ParsedUrl parsed;
  std::string origin = ParseUrl(request.url, &parsed) ? parsed.HttpOrigin() : std::string();
  job->on_abort_queued_ = [weak = std::weak_ptr<Shared>(shared_), raw = job.get()] {
    if (auto s = weak.lock()) s->CancelQueued(raw);
  };
  bool dispatched;
  {
    std::unique_lock<std::mutex> lock(shared_->mu);
    if (shared_->shutting_down) {
      lock.unlock();
      listener->OnError(NetError{NetErrorKind::kAborted, "client shut down"});
      return job;
    }
    shared_->active.insert(job);
    shared_->queue.push_back(QueuedRequest{job, std::move(request), listener, origin});
    dispatched = shared_->Dispatch(lock);
    if (!dispatched) {
      shared_->queue.pop_back();
      shared_->active.erase(job);
    }
  }
  if (!dispatched) listener->OnError(NetError{NetErrorKind::kIo, "cannot start a network thread"});
  return job;
}

namespace {
class BlockingListener : public HttpListener {
 public:
  void OnHead(HttpResponseHead head) override {
    std::lock_guard<std::mutex> l(mu);
    result.head = std::move(head);
  }
  void OnData(std::vector<uint8_t> chunk) override {
    std::lock_guard<std::mutex> l(mu);
    result.body.insert(result.body.end(), chunk.begin(), chunk.end());
  }
  void OnEnd() override { Finish(NetError{}); }
  void OnError(NetError e) override { Finish(std::move(e)); }
  bool Wait(int total_ms) {
    std::unique_lock<std::mutex> l(mu);
    if (total_ms <= 0) {
      cv.wait(l, [&] { return done; });
      return true;
    }
    return cv.wait_for(l, std::chrono::milliseconds(total_ms), [&] { return done; });
  }
  std::mutex mu;
  std::condition_variable cv;
  BlockingResult result;
  bool done = false;

 private:
  void Finish(NetError e) {
    std::lock_guard<std::mutex> l(mu);
    result.error = std::move(e);
    done = true;
    cv.notify_all();
  }
};
}  // namespace

BlockingResult FetchBlocking(HttpClient& client, HttpRequest request, int total_timeout_ms) {
  request.flow_control = false;
  auto listener = std::make_shared<BlockingListener>();
  std::shared_ptr<HttpJob> job = client.Start(std::move(request), listener);
  bool finished = listener->Wait(total_timeout_ms);
  if (!finished) {
    job->Abort();
    listener->Wait(0);  // Abort() makes the job finish promptly
  }
  std::lock_guard<std::mutex> l(listener->mu);
  BlockingResult out = std::move(listener->result);
  if (!finished) {
    out.timed_out = true;
    out.error = NetError{NetErrorKind::kTimeout, "timed out after " + std::to_string(total_timeout_ms) + " ms"};
    out.body.clear();
  }
  return out;
}

}  // namespace iwn::net
