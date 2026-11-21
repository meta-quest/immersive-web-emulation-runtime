# Brotli 1.2.0 decoder (MIT, github.com/google/brotli), for WOFF2 fonts.
if(NOT TARGET iwn_brotlidec)
  set(_br ${IWN_BROTLI_DIR}/c)
  add_library(iwn_brotlidec STATIC
    ${_br}/common/constants.c
    ${_br}/common/context.c
    ${_br}/common/dictionary.c
    ${_br}/common/platform.c
    ${_br}/common/shared_dictionary.c
    ${_br}/common/transform.c
    ${_br}/dec/bit_reader.c
    ${_br}/dec/decode.c
    ${_br}/dec/huffman.c
    ${_br}/dec/prefix.c
    ${_br}/dec/state.c
    ${_br}/dec/static_init.c)
  target_include_directories(iwn_brotlidec SYSTEM PUBLIC ${_br}/include)
  set_target_properties(iwn_brotlidec PROPERTIES POSITION_INDEPENDENT_CODE ON C_VISIBILITY_PRESET hidden)
  if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(iwn_brotlidec PRIVATE -w -Os)
  endif()
endif()
