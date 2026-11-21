// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// HTTP/1.1 response parsing per RFC 9112 §4 (status line), §5 (fields),
// §6 (message body length) and §7.1 (chunked transfer coding).

#include <algorithm>
#include <cstring>

#include "iwn/net/http.h"
#include "iwn/net/util.h"

namespace iwn::net {

namespace {
constexpr size_t kMaxHead = 64 * 1024;
constexpr size_t kMaxHeaders = 256;
constexpr size_t kMaxLine = 8 * 1024;

// End of the response head: the first empty line. RFC 9112 §2.2 lets a
// recipient accept a bare LF as a line terminator (browsers do), so both
// "\r\n\r\n" and "\n\n" (and mixes) end the head. Returns the offset just
// past the terminator, or npos.
size_t FindHeadEnd(const std::string& buf, size_t from) {
  for (size_t i = buf.find('\n', from); i != std::string::npos; i = buf.find('\n', i + 1)) {
    if (i + 1 < buf.size() && buf[i + 1] == '\n') return i + 2;
    if (i + 2 < buf.size() && buf[i + 1] == '\r' && buf[i + 2] == '\n') return i + 3;
  }
  return std::string::npos;
}

// Next line of a head starting at `pos` (terminator LF or CRLF). Returns false
// at the end of the buffer.
bool NextLine(const std::string& head, size_t* pos, std::string_view* line) {
  if (*pos >= head.size()) return false;
  size_t lf = head.find('\n', *pos);
  size_t end = lf == std::string::npos ? head.size() : lf;
  size_t stop = end;
  if (stop > *pos && head[stop - 1] == '\r') --stop;
  *line = std::string_view(head.data() + *pos, stop - *pos);
  *pos = lf == std::string::npos ? head.size() : lf + 1;
  return true;
}
}  // namespace

void HttpResponseParser::Reset(bool head_request) {
  *this = HttpResponseParser();
  head_request_ = head_request;
}

const std::string* HttpResponseParser::Find(const std::string& name) const {
  for (const auto& h : headers_) {
    if (EqualsIgnoreCase(h.first, name)) return &h.second;
  }
  return nullptr;
}

bool HttpResponseParser::ParseHead(const std::string& head) {
  size_t pos = 0;
  std::string_view status_line;
  NextLine(head, &pos, &status_line);
  // HTTP-version SP status-code SP [reason-phrase]
  if (status_line.size() < 12 || status_line.compare(0, 5, "HTTP/") != 0 || status_line[6] != '.' ||
      status_line[5] != '1' || status_line[8] != ' ') {
    error_ = "malformed status line";
    return false;
  }
  minor_ = status_line[7] - '0';
  if (minor_ < 0 || minor_ > 9) {
    error_ = "malformed HTTP version";
    return false;
  }
  int code = 0;
  for (int i = 9; i < 12; ++i) {
    char c = status_line[i];
    if (c < '0' || c > '9') {
      error_ = "malformed status code";
      return false;
    }
    code = code * 10 + (c - '0');
  }
  if (code < 100 || (status_line.size() > 12 && status_line[12] != ' ')) {
    error_ = "malformed status code";
    return false;
  }
  status_ = code;
  reason_ = status_line.size() > 13 ? std::string(status_line.substr(13)) : std::string();
  headers_.clear();
  std::string_view line;
  while (NextLine(head, &pos, &line)) {
    if (line.empty()) break;
    if (line.front() == ' ' || line.front() == '\t') {
      // Obsolete line folding (RFC 9112 §5.2): replace with a space.
      if (headers_.empty()) {
        error_ = "folded first header";
        return false;
      }
      headers_.back().second += " ";
      headers_.back().second += std::string(TrimHttpWhitespace(line));
      continue;
    }
    size_t colon = line.find(':');
    if (colon == std::string_view::npos || colon == 0) {
      error_ = "malformed header line";
      return false;
    }
    std::string_view name = line.substr(0, colon);
    if (!IsHttpToken(name)) {
      error_ = "malformed header name";
      return false;
    }
    if (headers_.size() >= kMaxHeaders) {
      error_ = "too many headers";
      return false;
    }
    headers_.emplace_back(std::string(name), std::string(TrimHttpWhitespace(line.substr(colon + 1))));
  }
  const std::string* conn = Find("connection");
  keep_alive_ = minor_ >= 1;
  if (conn) {
    if (HeaderHasToken(*conn, "close")) keep_alive_ = false;
    if (HeaderHasToken(*conn, "keep-alive")) keep_alive_ = true;
  }
  return true;
}

void HttpResponseParser::StartBody() {
  if (head_request_ || status_ == 204 || status_ == 304 || (status_ >= 100 && status_ < 200)) {
    body_mode_ = BodyMode::kNone;
    state_ = State::kDone;
    return;
  }
  const std::string* te = Find("transfer-encoding");
  if (te) {
    // RFC 9112 §6.3: chunked must be the final coding; otherwise read to close.
    std::string v = AsciiLowerStr(*te);
    size_t last = v.rfind(',');
    std::string_view final_coding = TrimHttpWhitespace(last == std::string::npos ? std::string_view(v) : std::string_view(v).substr(last + 1));
    if (final_coding == "chunked") {
      body_mode_ = BodyMode::kChunked;
      chunk_state_ = ChunkState::kSize;
    } else {
      body_mode_ = BodyMode::kUntilClose;
      keep_alive_ = false;
    }
    state_ = State::kBody;
    return;
  }
  // Content-Length: all values must agree (RFC 9112 §6.3 item 5).
  bool have_len = false;
  uint64_t len = 0;
  for (const auto& h : headers_) {
    if (!EqualsIgnoreCase(h.first, "content-length")) continue;
    std::string_view v = h.second;
    while (!v.empty()) {
      size_t comma = v.find(',');
      std::string_view part = TrimHttpWhitespace(v.substr(0, comma));
      if (part.empty() || part.size() > 19) {
        state_ = State::kError;
        error_ = "bad content-length";
        return;
      }
      uint64_t n = 0;
      for (char c : part) {
        if (c < '0' || c > '9') {
          state_ = State::kError;
          error_ = "bad content-length";
          return;
        }
        n = n * 10 + static_cast<uint64_t>(c - '0');
      }
      if (have_len && n != len) {
        state_ = State::kError;
        error_ = "conflicting content-length";
        return;
      }
      have_len = true;
      len = n;
      if (comma == std::string_view::npos) break;
      v.remove_prefix(comma + 1);
    }
  }
  if (have_len) {
    body_mode_ = BodyMode::kLength;
    remaining_ = len;
    state_ = len == 0 ? State::kDone : State::kBody;
    return;
  }
  body_mode_ = BodyMode::kUntilClose;
  keep_alive_ = false;
  state_ = State::kBody;
}

size_t HttpResponseParser::Feed(const uint8_t* data, size_t len, std::vector<uint8_t>* body, bool stop_after_head) {
  size_t used = 0;
  while (used < len && state_ != State::kDone && state_ != State::kError) {
    if (state_ == State::kHead) {
      // Append until the empty line. Search only the new region (+3 bytes back).
      size_t old = head_buf_.size();
      size_t take = len - used;
      head_buf_.append(reinterpret_cast<const char*>(data + used), take);
      size_t from = old >= 3 ? old - 3 : 0;
      size_t head_len = FindHeadEnd(head_buf_, from);
      if (head_len == std::string::npos) {
        used += take;
        if (head_buf_.size() > kMaxHead) {
          state_ = State::kError;
          error_ = "response head too large";
        }
        continue;
      }
      used += head_len - old;
      head_buf_.resize(head_len);
      if (!ParseHead(head_buf_)) {
        state_ = State::kError;
        continue;
      }
      head_buf_.clear();
      if (status_ >= 100 && status_ < 200 && status_ != 101) {
        // Interim response (e.g. 100 Continue): skip it, read the next head.
        status_ = 0;
        headers_.clear();
        continue;
      }
      StartBody();
      if (stop_after_head) return used;
      continue;
    }
    // kBody
    const uint8_t* p = data + used;
    size_t avail = len - used;
    switch (body_mode_) {
      case BodyMode::kNone:
        state_ = State::kDone;
        break;
      case BodyMode::kUntilClose:
        body->insert(body->end(), p, p + avail);
        used += avail;
        break;
      case BodyMode::kLength: {
        size_t n = static_cast<size_t>(std::min<uint64_t>(avail, remaining_));
        body->insert(body->end(), p, p + n);
        used += n;
        remaining_ -= n;
        if (remaining_ == 0) state_ = State::kDone;
        break;
      }
      case BodyMode::kChunked: {
        if (chunk_state_ == ChunkState::kData) {
          size_t n = static_cast<size_t>(std::min<uint64_t>(avail, remaining_));
          body->insert(body->end(), p, p + n);
          used += n;
          remaining_ -= n;
          if (remaining_ == 0) chunk_state_ = ChunkState::kDataCrlf;
          break;
        }
        // Line-oriented states: collect one line.
        char c = static_cast<char>(*p);
        ++used;
        if (c != '\n') {
          line_buf_.push_back(c);
          if (line_buf_.size() > kMaxLine) {
            state_ = State::kError;
            error_ = "chunk line too long";
          }
          break;
        }
        if (!line_buf_.empty() && line_buf_.back() == '\r') line_buf_.pop_back();
        std::string line;
        line.swap(line_buf_);
        if (chunk_state_ == ChunkState::kDataCrlf) {
          if (!line.empty()) {
            state_ = State::kError;
            error_ = "missing CRLF after chunk";
            break;
          }
          chunk_state_ = ChunkState::kSize;
        } else if (chunk_state_ == ChunkState::kSize) {
          size_t semi = line.find(';');  // chunk extensions ignored
          std::string_view hex = TrimHttpWhitespace(std::string_view(line).substr(0, semi));
          if (hex.empty() || hex.size() > 15) {
            state_ = State::kError;
            error_ = "bad chunk size";
            break;
          }
          uint64_t size = 0;
          for (char h : hex) {
            int v = (h >= '0' && h <= '9') ? h - '0' : (h >= 'a' && h <= 'f') ? h - 'a' + 10 : (h >= 'A' && h <= 'F') ? h - 'A' + 10 : -1;
            if (v < 0) {
              state_ = State::kError;
              error_ = "bad chunk size";
              break;
            }
            size = size * 16 + static_cast<uint64_t>(v);
          }
          if (state_ == State::kError) break;
          if (size == 0) {
            chunk_state_ = ChunkState::kTrailer;
          } else {
            remaining_ = size;
            chunk_state_ = ChunkState::kData;
          }
        } else {  // kTrailer: trailer fields are ignored; empty line ends the message
          if (line.empty()) state_ = State::kDone;
        }
        break;
      }
    }
  }
  return used;
}

void HttpResponseParser::OnEof() {
  if (state_ == State::kBody && body_mode_ == BodyMode::kUntilClose) {
    state_ = State::kDone;
    return;
  }
  if (state_ != State::kDone && state_ != State::kError) {
    error_ = state_ == State::kHead ? "connection closed before the response head" : "connection closed mid-body";
    state_ = State::kError;
  }
}

}  // namespace iwn::net
