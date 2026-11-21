// Host tests for XR-thread code of src/android that makes OpenXR calls only, against the fake runtime of
// fake_openxr.h (which behaves as Meta's where it matters): the scene model (XR-AR-2, xr_scene.cc) and spatial
// anchors (XR-ANCHOR-1, xr_anchors.cc).
#include <cstring>
#include <string>
#include <vector>

#include "android/xr_anchors.h"
#include "android/xr_scene.h"
#include "fake_openxr.h"
#include "iwn/xr/handoff.h"
#include "iwn_test.h"

using namespace iwn::xr;

namespace {

const std::vector<std::string> kSceneExtensions = {
    XR_FB_SPATIAL_ENTITY_EXTENSION_NAME, XR_FB_SPATIAL_ENTITY_QUERY_EXTENSION_NAME,
    XR_FB_SPATIAL_ENTITY_CONTAINER_EXTENSION_NAME, XR_FB_SCENE_EXTENSION_NAME,
    XR_META_SPATIAL_ENTITY_MESH_EXTENSION_NAME};

// A room with a floor, a wall, a table (top and volume) and the global mesh.
void furnished_room() {
  fakexr::reset();
  auto& w = fakexr::runtime().world;
  w.push_back({fakexr::uuid(1), true, "", false, false, false, {}});
  w.push_back({fakexr::uuid(2), false, "FLOOR", true, false, false, {}});
  w.push_back({fakexr::uuid(3), false, "WALL_FACE", true, false, false, {}});
  w.push_back({fakexr::uuid(4), false, "TABLE", true, true, false, {}});
  w.push_back({fakexr::uuid(5), false, "GLOBAL_MESH", false, false, true, {}});
}

void pump(XrScene& scene) {
  fakexr::pump([&](const XrEventDataBuffer& e) { scene.on_event(e); });
}

// Locates the entities (as before a frame is posted) and counts the slots located this frame.
int located(XrScene& scene, uint32_t slots) {
  scene.locate(fakexr::kBase, 1000);
  int n = 0;
  const float* p = XrScene::poses();
  for (uint32_t s = 0; s < slots; ++s) n += p[s * XrScene::kSlotFloats + 7] == 1.0f ? 1 : 0;
  return n;
}

std::string phase(XrScene& scene) { return scene.status()["phase"].string_or(""); }

}  // namespace

IWN_TEST(Scene, QueriesTheRoomAndParsesItsEntities) {
  furnished_room();
  XrScene scene;
  scene.init(fakexr::kInstance, fakexr::kSession, kSceneExtensions);
  IWN_CHECK(scene.available());
  scene.start("test");
  pump(scene);
  auto snap = scene.snapshot();
  IWN_CHECK(snap != nullptr);
  IWN_CHECK_EQ(snap->entities.size(), size_t{4});
  IWN_CHECK_EQ(phase(scene), std::string("ready"));
  const SceneEntity* table = nullptr;
  const SceneEntity* mesh = nullptr;
  for (const SceneEntity& e : snap->entities) {
    if (e.labels == "TABLE") table = &e;
    if (e.labels == "GLOBAL_MESH") mesh = &e;
  }
  IWN_CHECK(table && table->polygon.size() == 8 && table->has_box && table->box[5] == 0.7f);
  IWN_CHECK(mesh && mesh->vertices.size() == 9 && mesh->indices.size() == 3 && mesh->polygon.empty());
  IWN_CHECK_EQ(located(scene, 4), 4);  // LOCATABLE was enabled for every entity
}

IWN_TEST(Scene, ReQueriesKeepTheHandlesTheRuntimeHandsBack) {
  // Meta's runtime answers a re-query of an unchanged room with the handles already loaded: destroying the old set
  // after the swap would kill the new one (no entity located from then on)
  furnished_room();
  XrScene scene;
  scene.init(fakexr::kInstance, fakexr::kSession, kSceneExtensions);
  scene.start("session 1");
  pump(scene);
  IWN_CHECK_EQ(located(scene, 4), 4);
  scene.resumed();  // OpenXR READY again (headset off and on)
  pump(scene);
  IWN_CHECK_EQ(located(scene, 4), 4);
  IWN_CHECK_EQ(fakexr::runtime().located_dead, 0);
  scene.session_ended();
  scene.start("session 2");
  pump(scene);
  IWN_CHECK_EQ(located(scene, 4), 4);
  IWN_CHECK_EQ(scene.snapshot()->version, 3u);
  // a removed entity's handle goes; the others stay
  fakexr::runtime().world.erase(fakexr::runtime().world.begin() + 2);  // the wall
  scene.resumed();
  pump(scene);
  IWN_CHECK_EQ(scene.snapshot()->entities.size(), size_t{3});
  IWN_CHECK_EQ(fakexr::runtime().located_dead, 0);
  IWN_CHECK_EQ(fakexr::runtime().destroyed_dead, 0);
  IWN_CHECK_EQ(fakexr::live_handles(), 4);  // the room was destroyed and loaded again, the wall is gone
}

IWN_TEST(Scene, RefusedQueriesFailInsteadOfReadingAsAnEmptyRoom) {
  // the spatial-data service refuses the package (SPS ERROR_PACKAGE_UNTRUSTED): the query completes with an error
  furnished_room();
  fakexr::runtime().room_query_result = XR_ERROR_RUNTIME_FAILURE;
  XrScene scene;
  scene.init(fakexr::kInstance, fakexr::kSession, kSceneExtensions);
  scene.start("test");
  pump(scene);
  IWN_CHECK_EQ(phase(scene), std::string("failed"));
  IWN_CHECK(scene.status()["error"].string_or("").find("-2") != std::string::npos);  // XR_ERROR_RUNTIME_FAILURE
  IWN_CHECK(scene.snapshot() == nullptr);
  // no room at all (Space Setup never ran): XR_SUCCESS with no results, an empty scene, not a failure
  fakexr::reset();
  XrScene empty;
  empty.init(fakexr::kInstance, fakexr::kSession, kSceneExtensions);
  empty.start("test");
  pump(empty);
  IWN_CHECK_EQ(phase(empty), std::string("ready"));
  IWN_CHECK(empty.snapshot() && empty.snapshot()->entities.empty());
}

IWN_TEST(Scene, AFailedReQueryKeepsTheLastRoomPublishedAndLocated) {
  furnished_room();
  XrScene scene;
  scene.init(fakexr::kInstance, fakexr::kSession, kSceneExtensions);
  scene.start("test");
  pump(scene);
  const uint32_t version = scene.snapshot()->version;
  // the rooms step completes with an error, its results cannot be read, or the rooms' contents cannot be read
  for (int failure = 0; failure < 3; ++failure) {
    fakexr::runtime().room_query_result = failure == 0 ? XR_ERROR_RUNTIME_FAILURE : XR_SUCCESS;
    fakexr::runtime().fail_retrieve = failure == 1;
    fakexr::runtime().fail_container = failure == 2;
    scene.resumed();
    pump(scene);
    IWN_CHECK_EQ(phase(scene), std::string("failed"));
    IWN_CHECK_EQ(scene.snapshot()->version, version);
    IWN_CHECK_EQ(scene.snapshot()->entities.size(), size_t{4});
    IWN_CHECK_EQ(located(scene, 4), 4);
  }
  // a later query that works replaces it
  fakexr::runtime().fail_container = false;
  scene.resumed();
  pump(scene);
  IWN_CHECK_EQ(phase(scene), std::string("ready"));
  IWN_CHECK_EQ(scene.snapshot()->version, version + 1);
  IWN_CHECK_EQ(located(scene, 4), 4);
}

IWN_TEST(Scene, TeardownDestroysEachHandleOnceAndClearsTheLocatedFlags) {
  furnished_room();
  XrScene scene;
  scene.init(fakexr::kInstance, fakexr::kSession, kSceneExtensions);
  scene.start("test");
  pump(scene);
  IWN_CHECK_EQ(located(scene, 4), 4);
  scene.destroy();
  IWN_CHECK_EQ(fakexr::live_handles(), 0);
  IWN_CHECK_EQ(fakexr::runtime().destroyed_dead, 0);
  const float* p = XrScene::poses();
  for (uint32_t s = 0; s < 4; ++s) IWN_CHECK_EQ(p[s * XrScene::kSlotFloats + 7], 0.0f);
  IWN_CHECK(scene.snapshot() == nullptr);
}

// --- spatial anchors (XR-ANCHOR-1) ----------------------------------------------------------------------------------

namespace {

// The XR thread's side of XrAnchors on the test thread: commands, then the runtime's events, then the results.
struct Anchors {
  CommandQueue queue;
  XrAnchors anchors;
  std::vector<AnchorResult> results;

  Anchors() {
    anchors.set_queue(&queue);
    anchors.init(fakexr::kInstance, 1, fakexr::kSession, fakexr::kBase,
                 {XR_FB_SPATIAL_ENTITY_EXTENSION_NAME, XR_FB_SPATIAL_ENTITY_STORAGE_EXTENSION_NAME,
                  XR_FB_SPATIAL_ENTITY_QUERY_EXTENSION_NAME});
    anchors.locate(1000);  // a frame time for xrCreateSpatialAnchorFB
  }
  ~Anchors() { anchors.shutdown(); }

  // Runs the queued commands and every event they cause; the results of `request`.
  AnchorResult run(uint32_t request) {
    for (int i = 0; i < 4; ++i) {
      queue.run_pending();
      fakexr::pump([&](const XrEventDataBuffer& e) { anchors.on_event(e); });
    }
    std::vector<AnchorResult> got;
    if (anchors.take_results(&got)) results.insert(results.end(), got.begin(), got.end());
    for (const AnchorResult& r : results) {
      if (r.request == request) return r;
    }
    AnchorResult none;
    none.error = "no result";
    return none;
  }
  uint32_t created() {
    XrPosef pose{{0, 0, 0, 1}, {0.5f, 1, -1}};
    return run(anchors.create(pose)).anchor;
  }
};

}  // namespace

IWN_TEST(Anchors, ARestoredAnchorCanBeErased) {
  // xrEraseSpaceFB needs STORABLE, which a space loaded by a query (a restored anchor) does not have
  fakexr::reset();
  std::string uuid;
  {
    Anchors a;  // session 1: create and persist
    const uint32_t id = a.created();
    IWN_CHECK(id != 0);
    const AnchorResult saved = a.run(a.anchors.persist(id));
    IWN_CHECK(saved.ok);
    uuid = saved.uuid;
    a.anchors.end_session();
  }
  Anchors b;  // relaunch: restore, then delete the persisted copy
  const AnchorResult restored = b.run(b.anchors.restore(uuid));
  IWN_CHECK(restored.ok);
  const AnchorResult erased = b.run(b.anchors.erase(uuid));
  IWN_CHECK(erased.ok);
  IWN_CHECK(erased.error.empty());
  XrUuidEXT u{};
  IWN_CHECK(parse_uuid(uuid, u.data));
  IWN_CHECK(!fakexr::persisted(u));
  // an anchor this session never loaded: loaded for the erase, STORABLE enabled, erased, its space destroyed
  Anchors c;
  const uint32_t id = c.created();
  const std::string other = c.run(c.anchors.persist(id)).uuid;
  c.anchors.end_session();
  c.run(0);
  const int before = fakexr::live_handles();
  IWN_CHECK(b.run(b.anchors.erase(other)).ok);
  IWN_CHECK_EQ(fakexr::live_handles(), before);
  IWN_CHECK_EQ(fakexr::runtime().destroyed_dead, 0);
}

IWN_TEST(Anchors, EraseThenDeleteOfTheSameAnchorErasesIt) {
  // proto-placement's takeDown: deletePersistentAnchor(uuid), then anchor.delete() before the erase command ran
  fakexr::reset();
  Anchors a;
  const uint32_t id = a.created();
  const std::string uuid = a.run(a.anchors.persist(id)).uuid;
  const uint32_t request = a.anchors.erase(uuid);
  a.anchors.destroy(id);  // released on the JS thread at once
  const AnchorResult erased = a.run(request);
  IWN_CHECK(erased.ok);
  XrUuidEXT u{};
  parse_uuid(uuid, u.data);
  IWN_CHECK(!fakexr::persisted(u));
  IWN_CHECK_EQ(fakexr::live_handles(), 0);  // the released anchor's space went once the erase was done
  IWN_CHECK_EQ(fakexr::runtime().destroyed_dead, 0);
}

IWN_TEST(Anchors, AFailedCreationDestroysTheSpaceTheRuntimeDelivers) {
  fakexr::reset();
  fakexr::runtime().create_result = XR_ERROR_RUNTIME_FAILURE;  // no 6DoF tracking
  Anchors a;
  XrPosef pose{{0, 0, 0, 1}, {0, 0, 0}};
  for (int i = 0; i < 3; ++i) IWN_CHECK(!a.run(a.anchors.create(pose)).ok);
  IWN_CHECK_EQ(fakexr::live_handles(), 0);
}

IWN_TEST(Anchors, ARestoreAndAnEraseOfOneUuidAtOnceShareNoHandle) {
  fakexr::reset();
  std::string uuid;
  {
    Anchors a;
    uuid = a.run(a.anchors.persist(a.created())).uuid;
    a.anchors.end_session();
  }
  Anchors b;
  const uint32_t restore = b.anchors.restore(uuid);
  const uint32_t erase = b.anchors.erase(uuid);
  const AnchorResult erased = b.run(erase);
  const AnchorResult restored = b.run(restore);
  IWN_CHECK(erased.ok);
  IWN_CHECK(restored.ok);
  // the restored anchor keeps its (single) space until the page lets it go; nothing is destroyed twice
  b.anchors.locate(2000);
  IWN_CHECK_EQ(fakexr::runtime().located_dead, 0);
  b.anchors.destroy(restored.anchor);
  b.run(0);
  IWN_CHECK_EQ(fakexr::live_handles(), 0);
  IWN_CHECK_EQ(fakexr::runtime().destroyed_dead, 0);
  // an unknown UUID
  IWN_CHECK(b.run(b.anchors.erase("11111111-2222-3333-4444-555555555555")).error.find("no persisted anchor") !=
            std::string::npos);
}
