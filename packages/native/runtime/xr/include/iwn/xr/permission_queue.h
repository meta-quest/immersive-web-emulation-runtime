// The order of Android runtime-permission requests (XR-PERM-1), V8- and JNI-free so it is unit-tested on the host
// (xr_permissions.cc drives it).
//
// Activity.requestPermissions starts nothing while another request of the app is in flight: it logs "Can request only
// one set of permissions at a time" and answers with empty arrays, which NativeActivity drops, so such a request would
// read as denied without a dialog. The broker therefore keeps one request in flight; what is asked for meanwhile waits
// and goes to the system in the next one, merged (one dialog). A permission is put to the user once per process: a
// later request (another page, a reload) only re-checks it, so a grant made in Settings since still counts. A
// permission the app's manifest does not declare is never asked for (the system would start and finish its dialog
// activity at once, still pausing the session): it reads as denied.
#pragma once

#include <cstdint>
#include <functional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace iwn::xr {

class PermissionQueue {
 public:
  // Queues a request for `names`; returns its ticket (never 0).
  uint64_t push(std::vector<std::string> names);
  // Something waits for the next batch.
  bool pending() const { return !queued_.empty(); }
  // Starts the next batch: every queued request. `names` gets their names, each once, in the order first asked.
  // False (and nothing started) when nothing is queued.
  bool begin(std::vector<std::string>* names);
  // Of the batch's names that are not held now, those to put to the user: declared in the manifest (`declared`;
  // null: unknown, all count as declared) and not put to the user before in this process. They count as asked from
  // now on.
  std::vector<std::string> to_ask(const std::vector<std::string>& missing,
                                  const std::function<bool(const std::string&)>& declared);
  // Ends the batch with each of its names' final state (`held`, in `names` order): every request of the batch with
  // the states of its own names, in its order.
  std::vector<std::pair<uint64_t, std::vector<bool>>> finish(const std::vector<std::string>& names,
                                                             const std::vector<bool>& held);
  // Everything still queued or in the batch (shutdown): the tickets, emptied.
  std::vector<uint64_t> drain();

 private:
  struct Request {
    uint64_t ticket;
    std::vector<std::string> names;
  };
  uint64_t next_ = 0;
  std::vector<Request> queued_;
  std::vector<Request> batch_;
  std::set<std::string> asked_;
};

}  // namespace iwn::xr
