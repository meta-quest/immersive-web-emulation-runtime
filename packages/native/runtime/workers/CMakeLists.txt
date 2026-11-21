# runtime/workers: Worker, MessageChannel/MessagePort and structured clone across isolates (spec 05, WRK-*).
#
# Targets:
#   iwn_workers_core        V8-free: port hub (entangled ports, queues, transfer), policy (config, limits, URL checks,
#                           script fetch, thread names). Android + host.
#   iwn_workers             the V8 binding (iwn_register_workers): worker threads with their own isolate and event
#                           loop, the cross-isolate serializer, module loading in workers. Android only.
#   iwn_workers_core_tests  host unit tests (ctest).
#
# Part of runtime/ (one add_subdirectory(workers) line in runtime/CMakeLists.txt). The registry finds the module by
# its target name (iwn_workers -> globalThis.__iwn.workers, iwn_register_workers).

add_library(iwn_workers_core STATIC
  src/core/port_hub.cc
  src/core/policy.cc
)
target_include_directories(iwn_workers_core PUBLIC include)
target_link_libraries(iwn_workers_core PUBLIC iwn_core_base)
target_compile_options(iwn_workers_core PRIVATE ${IWN_WARNINGS})

if(IWN_ANDROID)
  add_library(iwn_workers STATIC
    src/v8/binding.cc
    src/v8/register.cc
    src/v8/serializer.cc
    src/v8/worker_runtime.cc
    src/v8/worker_modules.cc
    src/v8/script_cache.cc
  )
  target_include_directories(iwn_workers PRIVATE src
    # iwn/loop_hooks.h + iwn/loop_hooks_registry.h: the per-isolate loop contract shared with net/storage/image.
    ${CMAKE_CURRENT_SOURCE_DIR}/../net/include)
  target_link_libraries(iwn_workers PUBLIC iwn_workers_core iwn_core iwn::v8)
  # libv8android.so has no RTTI: classes deriving from V8 interfaces (ValueSerializer::Delegate) need -fno-rtti.
  target_compile_options(iwn_workers PRIVATE ${IWN_WARNINGS} -fno-rtti)
  target_compile_definitions(iwn_workers PRIVATE IWN_RUNTIME_VERSION="${IWN_RUNTIME_VERSION}")
  # ImageBitmap transfer tokens that are never delivered are discarded through the image module's registry.
  if(TARGET iwn_image_core)
    target_link_libraries(iwn_workers PRIVATE iwn_image_core)
    target_compile_definitions(iwn_workers PRIVATE IWN_WORKERS_HAVE_IMAGE=1)
  endif()
endif()

iwn_add_host_test(iwn_workers_core_tests
  SOURCES
    test/host/port_hub_test.cc
    test/host/policy_test.cc
  LIBS iwn_workers_core)
