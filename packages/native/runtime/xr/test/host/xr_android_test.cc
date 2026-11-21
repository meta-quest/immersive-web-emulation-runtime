// Host tests for XR-thread code of src/android that makes OpenXR calls only, against the fake runtime of
// fake_openxr.h (which behaves as Meta's where it matters): the scene model (XR-AR-2, xr_scene.cc).
#include <cstring>
#include <string>
#include <vector>

#include "android/xr_scene.h"
#include "fake_openxr.h"
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
