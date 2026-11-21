#pragma once

#include <mutex>

struct FT_LibraryRec_;

namespace iwn::canvas2d {

// FreeType is not thread-safe per library: every FreeType call holds this mutex.
std::mutex& FtMutex();
FT_LibraryRec_* FtLibrary();

}  // namespace iwn::canvas2d
