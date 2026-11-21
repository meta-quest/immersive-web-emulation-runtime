#include "raster.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>

namespace iwn::canvas2d {

namespace {
constexpr int kShift = 8;
constexpr int kOne = 1 << kShift;  // 256 sub-pixel units per pixel
constexpr int64_t kFullArea2 = int64_t(2) * kOne * kOne;  // twice the area of one pixel, in sub-pixel units

// Callers pass clipped device coordinates; the clamp keeps the conversion defined for anything else.
inline int ToFixed(double v) {
  constexpr double kLim = double(1 << 30);
  double f = v * kOne;
  if (!(f > -kLim)) f = -kLim;
  if (f > kLim) f = kLim;
  return static_cast<int>(std::lround(f));
}

// Clamps to [0, 1]; NaN becomes 0.
inline double Unit(double t) { return t > 0 ? (t < 1 ? t : 1.0) : 0.0; }

inline uint8_t FoldCoverage(int64_t v2, FillRule rule) {
  int64_t a = v2 < 0 ? -v2 : v2;
  if (rule == FillRule::kEvenOdd) {
    a %= 2 * kFullArea2;
    if (a > kFullArea2) a = 2 * kFullArea2 - a;
  }
  if (a >= kFullArea2) return 255;
  return static_cast<uint8_t>((a * 255 + kFullArea2 / 2) / kFullArea2);
}
}  // namespace

void Rasterizer::Reset(const IntRect& clip) {
  clip_ = clip;
  edges_.clear();
  cell_estimate_ = 0;
  nonfinite_ = false;
  right_dropped_ = false;
  banded_ = false;
  active_.clear();
  cells_.clear();
  sorted_.clear();
  left_cover_.clear();
  cur_valid_ = false;
  open_ = false;
  finished_ = false;
  bounds_ = IntRect{};
  left_active_ = false;
}

void Rasterizer::Trim(size_t max_bytes) {
  auto trim = [max_bytes](auto& v) {
    if (v.capacity() * sizeof(v[0]) > max_bytes) {
      v.clear();
      v.shrink_to_fit();
    }
  };
  trim(edges_);
  trim(active_);
  trim(cells_);
  trim(sorted_);
  trim(row_start_);
  trim(row_buf_);
  trim(left_full_);
  trim(left_part_);
  trim(left_cover_);
  trim(dense_cover_);
  trim(dense_area_);
  finished_ = false;
  banded_ = false;
}

void Rasterizer::MoveTo(double x, double y) {
  ClosePath();
  start_x_ = last_x_ = x;
  start_y_ = last_y_ = y;
  open_ = true;
}

void Rasterizer::LineTo(double x, double y) {
  if (!open_) {
    MoveTo(x, y);
    return;
  }
  AddEdge(last_x_, last_y_, x, y);
  last_x_ = x;
  last_y_ = y;
}

void Rasterizer::ClosePath() {
  if (open_ && (last_x_ != start_x_ || last_y_ != start_y_)) AddEdge(last_x_, last_y_, start_x_, start_y_);
  last_x_ = start_x_;
  last_y_ = start_y_;
  open_ = false;
}

void Rasterizer::AddPolygon(const double* xy, int count) {
  if (count < 3) return;
  ClosePath();
  for (int i = 0; i < count; i++) {
    int j = (i + 1) % count;
    AddEdge(xy[2 * i], xy[2 * i + 1], xy[2 * j], xy[2 * j + 1]);
  }
}

void Rasterizer::AddEdge(double x0, double y0, double x1, double y1) {
  if (clip_.Empty()) return;
  if (!(std::isfinite(x0) && std::isfinite(y0) && std::isfinite(x1) && std::isfinite(y1))) {
    // A path with a NaN or infinite vertex (coordinates beyond float range, a transform that overflows) is not drawn
    // at all, as in Skia/Chrome. Dropping just this edge would leave the contour open and fill out to the clip edge.
    nonfinite_ = true;
    return;
  }
  if (y0 == y1) return;
  // Canonical direction: top to bottom, with the winding sign kept separately, so an edge and its reverse are walked
  // identically and cancel exactly.
  int sign = 1;
  if (y0 > y1) {
    std::swap(x0, x1);
    std::swap(y0, y1);
    sign = -1;
  }
  const double cy0 = clip_.y0, cy1 = clip_.y1;
  if (y1 <= cy0 || y0 >= cy1) return;
  // Boundary intercepts as a convex combination with t in [0, 1]: stays finite for any finite endpoints. (A slope
  // (x1 - x0) / (y1 - y0) overflows to infinity for |dx| ~ 1e308 over a sub-pixel dy, and the clipped x would be inf.)
  // Halved operands keep the differences themselves from overflowing.
  auto lerp_at_y = [](double xa, double ya, double xb, double yb, double y) {
    double t = (0.5 * y - 0.5 * ya) / (0.5 * yb - 0.5 * ya);
    t = Unit(t);
    return xa * (1 - t) + xb * t;
  };
  {
    const double ox0 = x0, oy0 = y0, ox1 = x1, oy1 = y1;
    if (y0 < cy0) {
      x0 = lerp_at_y(ox0, oy0, ox1, oy1, cy0);
      y0 = cy0;
    }
    if (y1 > cy1) {
      x1 = lerp_at_y(ox0, oy0, ox1, oy1, cy1);
      y1 = cy1;
    }
  }
  if (!(y1 > y0)) return;

  // Horizontal: left of the clip collapses onto a vertical edge at clip.x0 (same effect on visible pixels); right of
  // the clip contributes nothing visible and is dropped.
  const double cx0 = clip_.x0, cx1 = clip_.x1;
  double xs[4] = {x0, 0, 0, x1}, ys[4] = {y0, 0, 0, y1};
  int n = 1;
  auto split_at = [&](double xb) {
    if ((x0 < xb && x1 > xb) || (x0 > xb && x1 < xb)) {
      double t = Unit((0.5 * xb - 0.5 * x0) / (0.5 * x1 - 0.5 * x0));
      xs[n] = xb;
      ys[n] = y0 * (1 - t) + y1 * t;
      n++;
    }
  };
  if (x0 <= x1) {
    split_at(cx0);
    split_at(cx1);
  } else {
    split_at(cx1);
    split_at(cx0);
  }
  xs[n] = x1;
  ys[n] = y1;
  for (int i = 0; i < n; i++) {
    double ax = xs[i], ay = ys[i], bx = xs[i + 1], by = ys[i + 1];
    // Defence in depth: rows must stay inside the clip rows (ToFixed of anything else is unusable).
    if (!(ay >= cy0 && ay <= cy1 && by >= cy0 && by <= cy1)) continue;
    if (!(std::isfinite(ax) && std::isfinite(bx))) continue;
    double mid = 0.5 * (ax + bx);
    if (mid >= cx1) {
      right_dropped_ = true;
      continue;
    }
    if (mid <= cx0) {
      // Left of the clip: a vertical edge at clip.x0. Accumulated per row (O(1) per edge) instead of walking a cell
      // per row: huge stroke pieces (round joins of an enormous lineWidth) have many such edges spanning the canvas.
      int fy0 = ToFixed(ay), fy1 = ToFixed(by);
      if (fy0 != fy1) AddLeftCover(fy0, fy1, sign);
      continue;
    } else {
      ax = std::clamp(ax, cx0, cx1);
      bx = std::clamp(bx, cx0, cx1);
    }
    int fy0 = ToFixed(ay), fy1 = ToFixed(by);
    if (fy0 == fy1) continue;
    AddEdgeFixed(ToFixed(ax), fy0, ToFixed(bx), fy1, sign);
  }
}

// Vertical edge at clip.x0 from fy0 to fy1 (24.8, fy0 < fy1, inside the clip rows): the cover it adds to each row's
// cell at clip.x0 (area 0: the edge is on the cell's left boundary). Full rows go into a difference array.
void Rasterizer::AddLeftCover(int fy0, int fy1, int sign) {
  const int rows = clip_.y1 - clip_.y0;
  if (!left_active_) {
    left_full_.assign(rows + 1, 0);
    left_part_.assign(rows + 1, 0);
    left_active_ = true;
  }
  finished_ = false;
  auto row_of = [&](int ey) { return std::clamp(ey - clip_.y0, 0, rows); };
  int ey0 = fy0 >> kShift, ey1 = fy1 >> kShift;
  if (ey0 == ey1) {
    left_part_[row_of(ey0)] += int64_t(fy1 - fy0) * sign;
    return;
  }
  left_part_[row_of(ey0)] += int64_t(kOne - (fy0 - (ey0 << kShift))) * sign;
  if (ey1 > ey0 + 1) {
    left_full_[row_of(ey0 + 1)] += int64_t(kOne) * sign;
    left_full_[row_of(ey1)] -= int64_t(kOne) * sign;
  }
  int bot = fy1 - (ey1 << kShift);
  if (bot) left_part_[row_of(ey1)] += int64_t(bot) * sign;
}

// Records (x0, y0) -> (x1, y1) in 24.8, y0 < y1, inside the clip rows.
void Rasterizer::AddEdgeFixed(int x0, int y0, int x1, int y1, int sign) {
  if (y0 == y1) return;
  if (y0 > y1) {
    std::swap(x0, x1);
    std::swap(y0, y1);
    sign = -sign;
  }
  finished_ = false;
  edges_.push_back(Edge{x0, y0, x1, y1, sign});
  // Cells the walk makes: one per row spanned plus one per column crossed.
  cell_estimate_ += double((y1 - 1) >> kShift) - double(y0 >> kShift) + 1 +
                    double(std::abs(int64_t(x1) - x0) >> kShift) + 1;
}

// Rows top to bottom, starting mid-edge when r0 cuts it. x at a row boundary is computed from the edge's endpoints,
// so a banded walk produces exactly the cells of a whole one.
void Rasterizer::WalkEdge(const Edge& e, int r0, int r1) {
  const int ylo = std::max(e.y0, r0 * kOne), yhi = std::min(e.y1, r1 * kOne);
  if (ylo >= yhi) return;
  const int64_t dx = int64_t(e.x1) - e.x0, dy = int64_t(e.y1) - e.y0;
  auto x_at = [&](int y) {
    return y == e.y0 ? e.x0 : y == e.y1 ? e.x1 : e.x0 + static_cast<int>(dx * (y - e.y0) / dy);
  };
  int ey = ylo >> kShift;
  int xcur = x_at(ylo), ycur = ylo;
  for (;;) {
    int row_top = ey << kShift;
    int ynext = row_top + kOne;
    if (ynext >= yhi) {
      RowSegment(ey, xcur, ycur - row_top, x_at(yhi), yhi - row_top, e.sign);
      break;
    }
    int xn = x_at(ynext);
    RowSegment(ey, xcur, ycur - row_top, xn, kOne, e.sign);
    xcur = xn;
    ycur = ynext;
    ey++;
  }
}

// One row: from (x0, fy0) to (x1, fy1), fy in [0, 256], fy0 < fy1. Walks the cells it crosses.
void Rasterizer::RowSegment(int ey, int x0, int fy0, int x1, int fy1, int sign) {
  if (fy0 == fy1) return;
  // A cell's sums stay far from int overflow: before they could, the cell is flushed and a new one started for the
  // same pixel (the sweep adds up cells of the same pixel in 64 bits). One piece adds at most 256 * 512 to area.
  constexpr int kCellLimit = 1 << 29;
  auto piece = [&](int ex, int fxa, int fxb, int ya, int yb) {
    int d = (yb - ya) * sign;
    if (d == 0) return;
    SetCell(ex, ey);
    if (cur_.area > kCellLimit || cur_.area < -kCellLimit || cur_.cover > kCellLimit || cur_.cover < -kCellLimit) {
      FlushCell();
      SetCell(ex, ey);
    }
    cur_.cover += d;
    cur_.area += d * (fxa + fxb);
  };
  if (x0 == x1) {
    int ex = x0 >> kShift;
    int fx = x0 - (ex << kShift);
    piece(ex, fx, fx, fy0, fy1);
    return;
  }
  const int64_t ddx = int64_t(x1) - x0, ddy = fy1 - fy0;
  if (x1 > x0) {
    int ex = x0 >> kShift;
    int x = x0, y = fy0;
    for (;;) {
      int base = ex << kShift;
      int bx = base + kOne;
      if (x1 <= bx) {
        piece(ex, x - base, x1 - base, y, fy1);
        break;
      }
      int yb = fy0 + static_cast<int>(ddy * (bx - x0) / ddx);
      piece(ex, x - base, kOne, y, yb);
      x = bx;
      y = yb;
      ex++;
    }
  } else {
    int ex = x0 >> kShift;
    if ((x0 & (kOne - 1)) == 0) ex--;
    int x = x0, y = fy0;
    for (;;) {
      int base = ex << kShift;
      if (x1 >= base) {
        piece(ex, x - base, x1 - base, y, fy1);
        break;
      }
      int yb = fy0 + static_cast<int>(ddy * (x0 - base) / (-ddx));
      piece(ex, x - base, 0, y, yb);
      x = base;
      y = yb;
      ex--;
    }
  }
}

void Rasterizer::SetCell(int ex, int ey) {
  if (cur_valid_ && cur_.x == ex && cur_.y == ey) return;
  FlushCell();
  cur_ = Cell{ex, ey, 0, 0};
  cur_valid_ = true;
}

void Rasterizer::FlushCell() {
  if (cur_valid_ && (cur_.cover != 0 || cur_.area != 0)) cells_.push_back(cur_);
  cur_valid_ = false;
}

void Rasterizer::BuildBand(int r0, int r1) {
  cells_.clear();
  sorted_.clear();
  if (banded_) {
    while (active_next_ < edges_.size() && (edges_[active_next_].y0 >> kShift) < r1) {
      active_.push_back(static_cast<uint32_t>(active_next_++));
    }
    size_t keep = 0;
    for (uint32_t idx : active_) {
      const Edge& e = edges_[idx];
      WalkEdge(e, r0, r1);
      if (((e.y1 - 1) >> kShift) >= r1) active_[keep++] = idx;
    }
    active_.resize(keep);
  } else {
    for (const Edge& e : edges_) WalkEdge(e, r0, r1);
  }
  FlushCell();
  if (!left_cover_.empty()) {
    for (int y = r0; y < r1; y++) {
      int64_t v = left_cover_[y - clip_.y0];
      while (v != 0) {  // in int-sized pieces (the sweep adds them up in 64 bits)
        int64_t part = std::clamp<int64_t>(v, -(int64_t(1) << 30), int64_t(1) << 30);
        cells_.push_back(Cell{clip_.x0, y, static_cast<int>(part), 0});
        v -= part;
      }
    }
  }
  // Defence in depth: cells outside the band rows (none are expected) would index row_start_ out of range.
  cells_.erase(std::remove_if(cells_.begin(), cells_.end(), [&](const Cell& c) { return c.y < r0 || c.y >= r1; }),
               cells_.end());
  const int rows = r1 - r0;
  row_start_.assign(rows + 1, 0);
  if (cells_.empty()) return;
  for (const Cell& c : cells_) row_start_[c.y - r0 + 1]++;
  for (int r = 0; r < rows; r++) row_start_[r + 1] += row_start_[r];
  sorted_.resize(cells_.size());
  {
    std::vector<uint32_t> fill(row_start_.begin(), row_start_.end() - 1);
    for (const Cell& c : cells_) sorted_[fill[c.y - r0]++] = c;
  }
  cells_.clear();
  for (int r = 0; r < rows; r++) {
    uint32_t b = row_start_[r], e = row_start_[r + 1];
    if (e - b > 1 && !DenseRow(e - b)) {
      std::sort(sorted_.begin() + b, sorted_.begin() + e, [](const Cell& p, const Cell& q) { return p.x < q.x; });
    }
  }
}

void Rasterizer::Finish() {
  ClosePath();
  FlushCell();
  finished_ = true;
  banded_ = false;
  sorted_.clear();
  cells_.clear();
  bounds_ = IntRect{};
  const int rows = clip_.y1 - clip_.y0;
  left_cover_.clear();
  bool any_left = false;
  if (left_active_ && rows > 0 && !nonfinite_) {
    left_cover_.assign(rows, 0);
    int64_t run = 0;
    for (int r = 0; r < rows; r++) {
      run += left_full_[r];
      left_cover_[r] = run + left_part_[r];
      any_left |= left_cover_[r] != 0;
    }
  }
  left_active_ = false;
  if (!any_left) left_cover_.clear();
  if (rows <= 0 || nonfinite_ || (edges_.empty() && left_cover_.empty())) {
    edges_.clear();
    left_cover_.clear();
    return;
  }
  size_t width = static_cast<size_t>(std::max(0, clip_.x1 - clip_.x0)) + 1;
  if (row_buf_.size() < width) row_buf_.resize(width);

  if (cell_estimate_ + rows <= static_cast<double>(band_cells_)) {
    // Small shape (the usual case): all cells at once, kept for any number of sweeps; exact bounds from the cells.
    BuildBand(clip_.y0, clip_.y1);
    edges_.clear();
    left_cover_.clear();
    if (sorted_.empty()) return;
    int miny = clip_.y1, maxy = clip_.y0 - 1, minx = clip_.x1, maxx = clip_.x0 - 1;
    for (int r = 0; r < rows; r++) {
      uint32_t b = row_start_[r], e = row_start_[r + 1];
      if (b == e) continue;
      miny = std::min(miny, clip_.y0 + r);
      maxy = std::max(maxy, clip_.y0 + r);
      int64_t cover = 0;
      for (uint32_t i = b; i < e; i++) {  // dense rows are unsorted: scan
        cover += sorted_[i].cover;
        minx = std::min(minx, sorted_[i].x);
        maxx = std::max(maxx, sorted_[i].x);
      }
      if (cover != 0) maxx = clip_.x1 - 1;
    }
    if (maxy >= miny) {
      bounds_ = IntRect{std::max(minx, clip_.x0), miny, std::min(maxx + 1, clip_.x1), maxy + 1};
    }
    return;
  }

  // Large shape: edges sorted by top row, walked band by band in Sweep(). Bounds (conservative) from the edges.
  banded_ = true;
  std::sort(edges_.begin(), edges_.end(), [](const Edge& p, const Edge& q) { return p.y0 < q.y0; });
  int miny = clip_.y1, maxy = clip_.y0 - 1, minx = clip_.x1, maxx = clip_.x0 - 1;
  for (const Edge& e : edges_) {
    miny = std::min(miny, e.y0 >> kShift);
    maxy = std::max(maxy, (e.y1 - 1) >> kShift);
    minx = std::min(minx, std::min(e.x0, e.x1) >> kShift);
    maxx = std::max(maxx, std::max(e.x0, e.x1) >> kShift);
  }
  if (!left_cover_.empty()) {
    minx = clip_.x0;
    for (int r = 0; r < rows; r++) {
      if (left_cover_[r] == 0) continue;
      miny = std::min(miny, clip_.y0 + r);
      maxy = std::max(maxy, clip_.y0 + r);
    }
  }
  if (right_dropped_ || !left_cover_.empty()) maxx = clip_.x1 - 1;
  bounds_ = IntRect{std::max(minx, clip_.x0), std::max(miny, clip_.y0), std::min(maxx + 1, clip_.x1),
                    std::min(maxy + 1, clip_.y1)};
  if (bounds_.Empty()) {
    bounds_ = IntRect{};
    banded_ = false;
    return;
  }
  const int brows = bounds_.y1 - bounds_.y0;
  double per_row = cell_estimate_ / brows;
  band_rows_ = static_cast<int>(std::clamp(std::floor(double(band_cells_) / std::max(per_row, 1.0)), 1.0, double(brows)));
}

int Rasterizer::SweepRowDense(size_t begin, size_t end, FillRule rule, uint8_t* out, int* out_x0) {
  const int width = clip_.x1 - clip_.x0;
  if (dense_cover_.size() < static_cast<size_t>(width) + 1) {
    dense_cover_.assign(static_cast<size_t>(width) + 1, 0);
    dense_area_.assign(static_cast<size_t>(width) + 1, 0);
  }
  int lo = width, hi = -1;  // used columns, relative to clip.x0
  for (size_t i = begin; i < end; i++) {
    int cx = std::clamp(sorted_[i].x - clip_.x0, 0, width);  // cells lie in [clip.x0, clip.x1]
    dense_cover_[cx] += sorted_[i].cover;
    dense_area_[cx] += sorted_[i].area;
    lo = std::min(lo, cx);
    hi = std::max(hi, cx);
  }
  *out_x0 = clip_.x0 + lo;
  int64_t cover = 0;
  int x = lo;
  for (; x <= hi && x < width; x++) {
    const int64_t c = dense_cover_[x], area = dense_area_[x];
    out[x - lo] = FoldCoverage(cover * 2 * kOne + c * 2 * kOne - area, rule);
    cover += c;
  }
  if (cover != 0 && x < width) {
    uint8_t v = FoldCoverage(cover * 2 * kOne, rule);
    if (v != 0) {
      std::fill(out + (x - lo), out + (width - lo), v);
      x = width;
    }
  }
  std::fill(dense_cover_.begin() + lo, dense_cover_.begin() + hi + 1, 0);
  std::fill(dense_area_.begin() + lo, dense_area_.begin() + hi + 1, 0);
  return clip_.x0 + x;
}

int Rasterizer::SweepRow(int /*y*/, size_t begin, size_t end, FillRule rule, uint8_t* out, int* out_x0) {
  if (DenseRow(end - begin)) return SweepRowDense(begin, end, rule, out, out_x0);
  int start = std::max(sorted_[begin].x, clip_.x0);
  *out_x0 = start;
  int64_t cover = 0;
  int x = start;  // next pixel to write
  size_t i = begin;
  while (i < end) {
    int cx = sorted_[i].x;
    int64_t area = 0, c = 0;
    while (i < end && sorted_[i].x == cx) {
      area += sorted_[i].area;
      c += sorted_[i].cover;
      i++;
    }
    if (cx >= clip_.x1) break;
    if (cx > x) {
      uint8_t v = FoldCoverage(cover * 2 * kOne, rule);
      std::fill(out + (x - start), out + (cx - start), v);
      x = cx;
    }
    if (cx >= start) {
      out[cx - start] = FoldCoverage(cover * 2 * kOne + c * 2 * kOne - area, rule);
      x = cx + 1;
    }
    cover += c;
  }
  if (cover != 0 && x < clip_.x1) {
    uint8_t v = FoldCoverage(cover * 2 * kOne, rule);
    if (v != 0) {
      std::fill(out + (x - start), out + (clip_.x1 - start), v);
      x = clip_.x1;
    }
  }
  return x;
}

}  // namespace iwn::canvas2d
