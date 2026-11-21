# FreeType 2.14.2 (FreeType License / GPLv2 dual; we use the FTL), the upstream freetype.org sources, built minimal:
# TrueType + CFF drivers, sfnt (WOFF via bundled zlib, WOFF2 via Brotli), no hinting, no renderers.
if(NOT TARGET iwn_freetype)
  set(_ft ${IWN_FREETYPE_DIR})
  add_library(iwn_freetype STATIC
    ${_ft}/src/base/ftsystem.c
    ${_ft}/src/base/ftinit.c
    ${_ft}/src/base/ftdebug.c
    ${_ft}/src/base/ftbase.c
    ${_ft}/src/base/ftbbox.c
    ${_ft}/src/base/ftbitmap.c
    ${_ft}/src/base/ftmm.c
    ${_ft}/src/base/ftcolor.c
    ${_ft}/src/truetype/truetype.c
    ${_ft}/src/sfnt/sfnt.c
    ${_ft}/src/cff/cff.c
    ${_ft}/src/psaux/psaux.c
    ${_ft}/src/pshinter/pshinter.c
    ${_ft}/src/psnames/psnames.c
    ${_ft}/src/gzip/ftgzip.c)
  target_include_directories(iwn_freetype SYSTEM PUBLIC ${_ft}/include ${CMAKE_CURRENT_LIST_DIR}/config)
  target_compile_definitions(iwn_freetype
    PUBLIC "FT_CONFIG_MODULES_H=<iwn_ftmodule.h>" "FT_CONFIG_OPTIONS_H=<iwn_ftoption.h>"
    PRIVATE FT2_BUILD_LIBRARY)
  if(IWN_CANVAS2D_WOFF2)
    target_compile_definitions(iwn_freetype PUBLIC IWN_FT_USE_BROTLI)
    target_link_libraries(iwn_freetype PRIVATE iwn_brotlidec)
  endif()
  set_target_properties(iwn_freetype PROPERTIES POSITION_INDEPENDENT_CODE ON C_VISIBILITY_PRESET hidden)
  if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(iwn_freetype PRIVATE -w -Os)
  endif()
endif()
