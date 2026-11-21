/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Anti-aliased scanline polygon rasterizer with exact area coverage.
//
// Technique: the classic sparse "cell" rasterizer (described publicly for libart, FreeType's smooth rasterizer and
// font-rs): every edge, in 24.8 fixed point, is walked through the pixel cells it crosses; each cell accumulates the
// signed height the edge spans in it ("cover") and the signed area to its left ("area"). A per-row sweep turns the
// running sum of covers plus each cell's area into the integral of the winding number over the pixel, which the fill
// rule folds into a coverage value. Written from that description; no code from those projects.
//
// Why our own instead of FreeType's gray rasterizer: FT_Outline caps a path at 65,535 points and 26.6 coordinates,
// and canvas paths (polylines, text runs, flattened arcs) exceed that. This one takes doubles, clips to the target
// box first, and has no size limit.
//
// Edges are recorded first (20 bytes each) and walked into cells in Finish(), or, when that would make more than
// kBandCells cells (long polylines whose segments span many rows), band by band during Sweep().
//
// Edges are canonicalised (walked top to bottom), so the same segment added twice with opposite directions cancels
// exactly; the stroker relies on that to union its pieces seamlessly.
#pragma once

#include <algorithm>
#include <cstdint>
#include <vector>

#include "iwn/canvas2d/types.h"

namespace iwn::canvas2d {

class Rasterizer {
 public:
  // Starts a new shape clipped to `clip` (device pixels). Keeps allocated memory.
  void Reset(const IntRect& clip);

  void MoveTo(double x, double y);
  void LineTo(double x, double y);
  void ClosePath();  // closes the current contour (contours are also closed implicitly on MoveTo / Sweep)

  // Adds a closed polygon.
  void AddPolygon(const double* xy, int count);

  // False when the shape certainly has no coverage. (After Finish() of a large, banded shape: true whenever it has
  // edges, even if they cancel.)
  bool HasCoverage() const {
    if (!finished_) return !edges_.empty() || left_active_;
    return banded_ ? true : !sorted_.empty();
  }

  // Bounding box of rows/columns that may have coverage, clipped to the clip box. Valid after Finish().
  IntRect Bounds() const { return bounds_; }
  // The clip box passed to Reset().
  IntRect Clip() const { return clip_; }

  // Releases buffers whose capacity exceeds max_bytes (after an unusually large shape).
  void Trim(size_t max_bytes);

  // Closes the open contour and prepares the sweep. Must be called before Sweep().
  void Finish();

  // Calls row(y, x0, x1, coverage) for each row with coverage, top to bottom, where coverage[i] is the 0..255
  // coverage of pixel x0 + i, for x in [x0, x1). Pixels may have coverage 0 inside the range. May be called again.
  template <class RowFn>
  void Sweep(FillRule rule, RowFn&& row);

  // Cells one band may hold (16 bytes each, plus as many for sorting). Shapes whose edges would make more cells are
  // swept in horizontal bands, so memory stays bounded by this instead of growing with edges x rows. Public for tests.
  static constexpr size_t kBandCells = size_t(1) << 21;
  void set_band_cells_for_test(size_t n) { band_cells_ = n; }
  void set_dense_min_cells_for_test(size_t n) { dense_min_cells_ = n; }

 private:
  struct Cell {
    int x, y;
    int cover;  // sum of dy (1/256 px units)
    int area;   // sum of dy * (fx_in + fx_out)
  };
  // An edge in 24.8 fixed point, inside the clip rows, walked top to bottom (y0 < y1); sign is its winding direction.
  struct Edge {
    int x0, y0, x1, y1;
    int sign;
  };

  void AddEdge(double x0, double y0, double x1, double y1);
  void AddEdgeFixed(int x0, int y0, int x1, int y1, int sign);  // records an edge (24.8, inside the clip rows)
  void AddLeftCover(int fy0, int fy1, int sign);
  // Walks the part of edge e within rows [r0, r1) (absolute pixel rows) into cells.
  void WalkEdge(const Edge& e, int r0, int r1);
  void RowSegment(int ey, int x0, int fy0, int x1, int fy1, int sign);
  void SetCell(int ex, int ey);
  void FlushCell();
  // Cells of rows [r0, r1), sorted by row (row_start_, relative to r0) then x, into sorted_.
  void BuildBand(int r0, int r1);
  int SweepRow(int y, size_t begin, size_t end, FillRule rule, uint8_t* out, int* out_x0);
  // Rows with many cells are not sorted: their cells are summed into per-column accumulators instead (O(cells +
  // width) rather than O(cells log cells)). Same result as the sorted sweep.
  bool DenseRow(size_t n) const { return n >= dense_min_cells_ && n * 4 > static_cast<size_t>(clip_.x1 - clip_.x0); }
  int SweepRowDense(size_t begin, size_t end, FillRule rule, uint8_t* out, int* out_x0);

  IntRect clip_;
  IntRect bounds_;
  std::vector<Edge> edges_;
  double cell_estimate_ = 0;  // cells walking every edge would produce
  bool nonfinite_ = false;    // a vertex was NaN or infinite: the shape is not drawn (as Skia, Chrome)
  bool right_dropped_ = false;  // edges right of the clip were dropped: winding may run on to clip.x1
  bool banded_ = false;
  int band_rows_ = 0;
  size_t band_cells_ = kBandCells;
  size_t dense_min_cells_ = 64;
  size_t active_next_ = 0;  // banded sweep: next edge (sorted by top row) not yet active
  std::vector<uint32_t> active_;
  std::vector<Cell> cells_;
  std::vector<uint32_t> row_start_;
  std::vector<Cell> sorted_;
  std::vector<uint8_t> row_buf_;
  std::vector<int64_t> dense_cover_, dense_area_;  // per column (clip.x0 .. clip.x1), zero between rows
  Cell cur_{0, 0, 0, 0};
  bool cur_valid_ = false;
  double start_x_ = 0, start_y_ = 0, last_x_ = 0, last_y_ = 0;
  bool open_ = false;
  bool finished_ = false;
  // Cover of edges left of the clip, per clip row (see AddLeftCover); after Finish(), left_cover_ holds the totals.
  std::vector<int64_t> left_full_;
  std::vector<int64_t> left_part_;
  std::vector<int64_t> left_cover_;
  bool left_active_ = false;
};

template <class RowFn>
void Rasterizer::Sweep(FillRule rule, RowFn&& row) {
  if (!finished_) Finish();
  if (bounds_.Empty()) return;
  if (!banded_) {
    if (sorted_.empty()) return;
    int rows = clip_.y1 - clip_.y0;
    for (int r = 0; r < rows; r++) {
      uint32_t b = row_start_[r], e = row_start_[r + 1];
      if (b == e) continue;
      int x0 = 0;
      int x1 = SweepRow(clip_.y0 + r, b, e, rule, row_buf_.data(), &x0);
      if (x1 > x0) row(clip_.y0 + r, x0, x1, row_buf_.data());
    }
    return;
  }
  active_.clear();
  active_next_ = 0;
  for (int r0 = bounds_.y0; r0 < bounds_.y1; r0 += band_rows_) {
    int r1 = std::min(bounds_.y1, r0 + band_rows_);
    BuildBand(r0, r1);
    for (int r = 0; r < r1 - r0; r++) {
      uint32_t b = row_start_[r], e = row_start_[r + 1];
      if (b == e) continue;
      int x0 = 0;
      int x1 = SweepRow(r0 + r, b, e, rule, row_buf_.data(), &x0);
      if (x1 > x0) row(r0 + r, x0, x1, row_buf_.data());
    }
  }
  sorted_.clear();
}

}  // namespace iwn::canvas2d
