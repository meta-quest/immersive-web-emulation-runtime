# HarfBuzz 14.0.0 (Old MIT, github.com/harfbuzz/harfbuzz): the amalgamated harfbuzz.cc with only the OpenType shaper
# and its own Unicode data; colour/bitmap/CFF/AAT tables are not needed for shaping (FreeType reads those) (no ICU, no glib, no FreeType integration: we hand it the font bytes directly).
if(NOT TARGET iwn_harfbuzz)
  add_library(iwn_harfbuzz STATIC ${IWN_HARFBUZZ_DIR}/src/harfbuzz.cc)
  target_include_directories(iwn_harfbuzz SYSTEM PUBLIC ${IWN_HARFBUZZ_DIR}/src)
  target_compile_definitions(iwn_harfbuzz PRIVATE
    HAVE_PTHREAD=1
    HB_DISABLE_DEPRECATED
    HB_NO_ATEXIT
    HB_NO_BUFFER_MESSAGE
    HB_NO_BUFFER_SERIALIZE
    HB_NO_BUFFER_VERIFY
    HB_NO_DRAW
    HB_NO_PAINT
    HB_NO_ERRNO
    HB_NO_GETENV
    HB_NO_MATH
    HB_NO_META
    HB_NO_MMAP
    HB_NO_OPEN
    HB_NO_SETLOCALE
    HB_NO_STYLE
    HB_NO_LAYOUT_COLLECT_GLYPHS
    HB_NO_LAYOUT_UNUSED
    HB_NO_FACE_COLLECT_UNICODES
    HB_NO_OT_FONT_GLYPH_NAMES
    HB_NO_SUBSET_LAYOUT
    HB_NO_AAT
    HB_NO_BEYOND_64K
    HB_NO_CFF
    HB_NO_BITMAP
    HB_NO_COLOR
    HB_OPTIMIZE_SIZE)
  set_target_properties(iwn_harfbuzz PROPERTIES POSITION_INDEPENDENT_CODE ON CXX_VISIBILITY_PRESET hidden)
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(iwn_harfbuzz PRIVATE -w -Os -fno-exceptions -fno-rtti -fno-threadsafe-statics)
  endif()
endif()
