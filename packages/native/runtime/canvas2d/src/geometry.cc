#include "geometry.h"

#include <algorithm>
#include <cmath>

namespace iwn::canvas2d {

namespace {

constexpr int kMaxCurveSegments = 1000;
constexpr double kMaxDashPieces = 1e6;  // as Skia's dasher limit
// Work bound for one dashed stroke: polygon vertices the visible dashes would emit. Above it the dashes are drawn as
// their average coverage (see StrokeImpl). A fully dashed 4096 px canvas grid stays well below it.
constexpr double kMaxDashVertices = 4e6;
// Work bound for one dashed stroke: raster rows its pieces span (the rasterizer stores a cell per edge per row).
constexpr double kMaxDashRows = 8e6;

int QuadSegments(double x0, double y0, double x1, double y1, double x2, double y2, double tol) {
  double ddx = x0 - 2 * x1 + x2, ddy = y0 - 2 * y1 + y2;
  double dd = std::sqrt(ddx * ddx + ddy * ddy);
  double n = std::ceil(std::sqrt(dd / (4 * tol)));
  if (!(n >= 1)) return 1;
  return n > kMaxCurveSegments ? kMaxCurveSegments : static_cast<int>(n);
}

int CubicSegments(double x0, double y0, double x1, double y1, double x2, double y2, double x3, double y3,
                  double tol) {
  double ax = x0 - 2 * x1 + x2, ay = y0 - 2 * y1 + y2;
  double bx = x1 - 2 * x2 + x3, by = y1 - 2 * y2 + y3;
  double dd = std::sqrt(std::max(ax * ax + ay * ay, bx * bx + by * by));
  double n = std::ceil(std::sqrt(3 * dd / (4 * tol)));
  if (!(n >= 1)) return 1;
  return n > kMaxCurveSegments ? kMaxCurveSegments : static_cast<int>(n);
}

// Walks a path, mapping points with m and flattening curves; calls move(x, y), line(x, y, is_vertex), close().
template <class Move, class Line, class Close>
void WalkFlattened(PathView path, const Matrix& m, double tol, Move&& move, Line&& line, Close&& close,
                   bool tangent_ends = false) {
  // For strokes: a point very close to each curve end makes the end segments follow the curve's tangent, so caps
  // and joins at curve ends are oriented like the true curve's (no wedge gaps or overhangs).
  constexpr double kEps = 1e-3;
  const float* p = path.data;
  const float* end = path.data + path.length;
  double cx = 0, cy = 0;  // current point (mapped)
  double sx = 0, sy = 0;  // subpath start
  bool have = false;
  while (p < end) {
    int verb = static_cast<int>(p[0]);
    switch (verb) {
      case kVerbMove: {
        if (p + 3 > end) return;
        m.Map(p[1], p[2], &cx, &cy);
        sx = cx;
        sy = cy;
        have = true;
        move(cx, cy);
        p += 3;
        break;
      }
      case kVerbLine: {
        if (p + 3 > end) return;
        double x, y;
        m.Map(p[1], p[2], &x, &y);
        if (!have) {
          sx = cx = x;
          sy = cy = y;
          have = true;
          move(x, y);
        } else {
          line(x, y, true);
          cx = x;
          cy = y;
        }
        p += 3;
        break;
      }
      case kVerbQuad: {
        if (p + 5 > end) return;
        double x1, y1, x2, y2;
        m.Map(p[1], p[2], &x1, &y1);
        m.Map(p[3], p[4], &x2, &y2);
        if (!have) {
          sx = cx = x1;
          sy = cy = y1;
          have = true;
          move(cx, cy);
        }
        int n = QuadSegments(cx, cy, x1, y1, x2, y2, tol);
        // Interior points are moved outward by 2/3 of the local chord sagitta (see kFlattenTolerance): the second
        // difference of a quadratic at step h is h^2 * B'' = 2 h^2 (P0 - 2 P1 + P2), the sagitta an eighth of it.
        const double h = 1.0 / n;
        const double qox = -(h * h / 6) * (cx - 2 * x1 + x2), qoy = -(h * h / 6) * (cy - 2 * y1 + y2);
        auto qa = [&](double t, bool interior) {
          double u = 1 - t;
          double x = u * u * cx + 2 * u * t * x1 + t * t * x2, y = u * u * cy + 2 * u * t * y1 + t * t * y2;
          if (interior) x += qox, y += qoy;
          line(x, y, false);
        };
        if (tangent_ends) qa(kEps / n, false);
        for (int i = 1; i < n; i++) qa(double(i) / n, true);
        if (tangent_ends) qa(1 - kEps / n, false);
        line(x2, y2, true);
        cx = x2;
        cy = y2;
        p += 5;
        break;
      }
      case kVerbCubic: {
        if (p + 7 > end) return;
        double x1, y1, x2, y2, x3, y3;
        m.Map(p[1], p[2], &x1, &y1);
        m.Map(p[3], p[4], &x2, &y2);
        m.Map(p[5], p[6], &x3, &y3);
        if (!have) {
          sx = cx = x1;
          sy = cy = y1;
          have = true;
          move(cx, cy);
        }
        int n = CubicSegments(cx, cy, x1, y1, x2, y2, x3, y3, tol);
        // Same outward correction as for quadratics, with B''(t) = 6 ((1 - t) A + t B).
        const double h = 1.0 / n;
        const double ax = cx - 2 * x1 + x2, ay = cy - 2 * y1 + y2, bx = x1 - 2 * x2 + x3, by = y1 - 2 * y2 + y3;
        auto ca = [&](double t, bool interior) {
          double u = 1 - t;
          double a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
          double x = a * cx + b * x1 + c * x2 + d * x3, y = a * cy + b * y1 + c * y2 + d * y3;
          if (interior) {
            x -= (h * h / 2) * (u * ax + t * bx);
            y -= (h * h / 2) * (u * ay + t * by);
          }
          line(x, y, false);
        };
        if (tangent_ends) ca(kEps / n, false);
        for (int i = 1; i < n; i++) ca(double(i) / n, true);
        if (tangent_ends) ca(1 - kEps / n, false);
        line(x3, y3, true);
        cx = x3;
        cy = y3;
        p += 7;
        break;
      }
      case kVerbClose: {
        if (have) {
          close();
          cx = sx;
          cy = sy;
          move(cx, cy);  // HTML: closePath starts a new subpath at the start point
        }
        p += 1;
        break;
      }
      default:
        return;  // malformed: stop
    }
  }
}

}  // namespace

void FlattenPath(PathView path, const Matrix& m, double tol, std::vector<Polyline>* out) {
  out->clear();
  Polyline cur;
  auto flush = [&]() {
    if (!cur.xy.empty()) out->push_back(std::move(cur));
    cur = Polyline();
  };
  WalkFlattened(
      path, m, tol,
      [&](double x, double y) {
        flush();
        cur.xy = {x, y};
        cur.corner = {1};
      },
      [&](double x, double y, bool vertex) {
        cur.xy.push_back(x);
        cur.xy.push_back(y);
        cur.corner.push_back(vertex ? 1 : 0);
        cur.had_segment = true;
      },
      [&]() { cur.closed = true; }, true);
  flush();
}

void AddPathToRasterizer(PathView path, const Matrix& m, Rasterizer* r, double tolerance) {
  WalkFlattened(
      path, m, tolerance, [&](double x, double y) { r->MoveTo(x, y); },
      [&](double x, double y, bool) { r->LineTo(x, y); }, [&]() { r->ClosePath(); });
  r->ClosePath();
}

namespace {

struct Dir {
  double x = 1, y = 0;
};

// User-space box (axis aligned) that contains everything a stroke piece needs to touch the device cull box.
struct UserBox {
  bool valid = false;
  double x0 = 0, y0 = 0, x1 = 0, y1 = 0;
};

// Parameter range [*t0, *t1] (fractions of the segment) of (x0, y0)->(x1, y1) inside `box` (Liang-Barsky). False when
// the segment misses the box. *enter / *exit (optional): the box edge that clips each end (0: x0, 1: x1, 2: y0,
// 3: y1), -1 when that end of the segment is inside the box.
bool ClipSegment(const UserBox& box, double x0, double y0, double x1, double y1, double* t0, double* t1,
                 int* enter = nullptr, int* exit = nullptr) {
  double a = 0, b = 1;
  int ea = -1, eb = -1;
  const double dx = x1 - x0, dy = y1 - y0;
  auto edge = [&](int id, double p, double q) {
    if (p == 0) return q >= 0;
    double r = q / p;
    if (p < 0) {
      if (r > b) return false;
      if (r > a) {
        a = r;
        ea = id;
      }
    } else {
      if (r < a) return false;
      if (r < b) {
        b = r;
        eb = id;
      }
    }
    return true;
  };
  if (!edge(0, -dx, x0 - box.x0) || !edge(1, dx, box.x1 - x0) || !edge(2, -dy, y0 - box.y0) ||
      !edge(3, dy, box.y1 - y0))
    return false;
  if (!(a <= b)) return false;
  *t0 = a;
  *t1 = b;
  if (enter) *enter = ea;
  if (exit) *exit = eb;
  return true;
}

// Where (x0, y0)->(x1, y1) crosses box edge `id` (see ClipSegment), interpolated from the endpoint nearer to that
// edge. A parameter t near 1 cannot locate a point on a segment ~1e37 long to better than ~1e21 units; the ratio from
// the near end can. Halved operands keep the difference of two huge coordinates finite.
void CrossEdge(const UserBox& box, int id, double x0, double y0, double x1, double y1, double* px, double* py) {
  const bool vertical_edge = id < 2;  // x = const
  const double v = id == 0 ? box.x0 : id == 1 ? box.x1 : id == 2 ? box.y0 : box.y1;
  double a0 = vertical_edge ? x0 : y0, a1 = vertical_edge ? x1 : y1;
  double b0 = vertical_edge ? y0 : x0, b1 = vertical_edge ? y1 : x1;
  if (std::fabs(v - a1) < std::fabs(v - a0)) {
    std::swap(a0, a1);
    std::swap(b0, b1);
  }
  double r = (0.5 * v - 0.5 * a0) / (0.5 * a1 - 0.5 * a0);  // in [0, 0.5] for a crossing
  r = r > 0 ? (r < 1 ? r : 1.0) : 0.0;
  double b = b0 + 2 * ((0.5 * b1 - 0.5 * b0) * r);
  *px = vertical_edge ? v : b;
  *py = vertical_edge ? b : v;
}

// The part of (x0, y0)->(x1, y1) inside `box`: from (sx, sy) to (ex, ey), with the lengths before and after it
// (head, tail). The same computation feeds the dash-count bound and the dash walk, so the bound covers the walk.
struct ClippedPart {
  double sx, sy, ex, ey;
  double walk;        // length from (sx, sy) to (ex, ey)
  double head, tail;  // lengths cut off before / after (0 when that end is inside)
  bool cut_start, cut_end;
};
bool ClipPart(const UserBox& box, double x0, double y0, double x1, double y1, double len, ClippedPart* out) {
  *out = ClippedPart{x0, y0, x1, y1, len, 0, 0, false, false};
  if (!box.valid) return true;
  double t0, t1;
  int enter = -1, exit = -1;
  if (!ClipSegment(box, x0, y0, x1, y1, &t0, &t1, &enter, &exit)) return false;
  if (enter >= 0 && t0 > 0) {
    CrossEdge(box, enter, x0, y0, x1, y1, &out->sx, &out->sy);
    out->head = t0 * len;
    out->cut_start = true;
  }
  if (exit >= 0 && t1 < 1) {
    CrossEdge(box, exit, x0, y0, x1, y1, &out->ex, &out->ey);
    out->tail = (1 - t1) * len;
    out->cut_end = true;
  }
  if (out->cut_start || out->cut_end) out->walk = std::hypot(out->ex - out->sx, out->ey - out->sy);
  return true;
}

// Splits polylines into dashes. HTML: the dash pattern restarts at each subpath; position starts at -offset.
// With a valid `cull` box, the parts of segments outside it advance the pattern arithmetically and emit nothing: a
// dash cut at the box edge gets a cap or a lost join there, which the box's margin keeps off screen.
void DashPolylines(const std::vector<Polyline>& in, const StrokeParams& sp, const UserBox& cull, size_t max_pieces,
                   std::vector<Polyline>* out, std::vector<Dir>* dot_dirs) {
  double total = 0;
  for (int i = 0; i < sp.dash_count; i++) total += sp.dash[i];
  out->clear();
  for (const Polyline& pl : in) {
    size_t n = pl.size();
    if (n == 0 || !pl.had_segment) continue;
    std::vector<double> xy = pl.xy;
    std::vector<uint8_t> corner = pl.corner;
    if (pl.closed) {
      xy.push_back(pl.xy[0]);
      xy.push_back(pl.xy[1]);
      corner.push_back(1);
      n++;
    }
    double phase = std::fmod(sp.dash_offset, total);
    if (phase < 0) phase += total;
    int idx = 0;
    // A dash that ends exactly at the start is passed over, but a zero-length "on" dash at the start is kept: HTML
    // places a point there, which round and square caps draw as a dot (setLineDash([0, n]) dotted lines).
    while (phase > sp.dash[idx] || (phase == sp.dash[idx] && phase > 0)) {
      phase -= sp.dash[idx];
      idx = (idx + 1) % sp.dash_count;
    }
    double remaining = sp.dash[idx] - phase;
    bool on = (idx % 2) == 0;
    Polyline cur;
    Dir cur_dir;
    auto start_piece = [&](double x, double y, Dir d) {
      cur = Polyline();
      cur.xy = {x, y};
      cur.corner = {1};
      cur.had_segment = true;
      cur_dir = d;
    };
    auto end_piece = [&]() {
      if (!cur.xy.empty()) {
        if (cur.size() == 1) {
          cur.xy.push_back(cur.xy[0]);
          cur.xy.push_back(cur.xy[1]);
          cur.corner.push_back(1);
        }
        out->push_back(std::move(cur));
        dot_dirs->push_back(cur_dir);
      }
      cur = Polyline();
    };
    auto next_dash = [&]() {
      on = !on;
      idx = (idx + 1) % sp.dash_count;
      remaining = sp.dash[idx];
    };
    // Moves `dist` along the pattern without emitting (an open dash ends at (x, y), where the skipped part starts).
    auto skip = [&](double x, double y, double dist) {
      if (on && !cur.xy.empty()) {
        cur.xy.push_back(x);
        cur.xy.push_back(y);
        cur.corner.push_back(1);
        end_piece();
      }
      if (!std::isfinite(dist)) return;  // no meaningful phase after an infinite length
      if (dist < remaining) {
        remaining -= dist;
        return;
      }
      dist -= remaining;
      next_dash();
      dist = std::fmod(dist, total);
      for (int guard = 0; dist >= remaining && guard < 2 * sp.dash_count; guard++) {
        dist -= remaining;
        next_dash();
      }
      remaining = std::max(0.0, remaining - dist);
    };
    for (size_t i = 0; i + 1 < n; i++) {
      double x0 = xy[2 * i], y0 = xy[2 * i + 1], x1 = xy[2 * i + 2], y1 = xy[2 * i + 3];
      double len = std::hypot(x1 - x0, y1 - y0);
      if (len == 0) continue;
      if (!std::isfinite(len)) {  // overflowing coordinates: nothing drawable, keep the pattern state
        skip(x0, y0, len);
        continue;
      }
      Dir d{(x1 - x0) / len, (y1 - y0) / len};
      // The walked part of the segment, from (sx, sy) to (ex, ey), in its own coordinates: positions along it start
      // at 0. (Measured from the segment start, a position of ~1e37 plus a dash length of ~100 does not move, and the
      // walk below would never end.)
      ClippedPart part;
      if (!ClipPart(cull, x0, y0, x1, y1, len, &part)) {
        skip(x0, y0, len);
        continue;
      }
      if (part.cut_start) skip(x0, y0, part.head);
      const double sx = part.sx, sy = part.sy, ex = part.ex, ey = part.ey, walk = part.walk;
      const bool cut_end = part.cut_end;
      if (on && cur.xy.empty()) start_piece(sx, sy, d);
      // Zero-length dashes at the walk's start (only possible at a subpath start, see the phase loop above).
      while (remaining == 0) {
        if (on) end_piece();
        next_dash();
        if (on) start_piece(sx, sy, d);
      }
      double pos = 0;
      while (walk - pos > remaining) {
        // Always advance: a dash shorter than the spacing of doubles at `pos` would otherwise loop forever. The
        // dash-count bound in StrokeImpl keeps `walk / period` (and so these steps) below kMaxDashPieces.
        if (out->size() >= max_pieces) return;  // defensive: the estimate in StrokeImpl already bounds this
        double npos = pos + remaining;
        pos = npos > pos ? npos : std::nextafter(pos, HUGE_VAL);
        double x = sx + d.x * pos, y = sy + d.y * pos;
        if (on) {
          cur.xy.push_back(x);
          cur.xy.push_back(y);
          cur.corner.push_back(1);
          end_piece();
        } else {
          start_piece(x, y, d);
        }
        next_dash();
        // Zero-length "on" dashes still produce a dot (round/square caps).
        while (remaining == 0) {
          if (on) {
            start_piece(x, y, d);
            end_piece();
          } else {
            start_piece(x, y, d);
          }
          next_dash();
        }
      }
      remaining = std::max(0.0, remaining - (walk - pos));
      if (on) {
        if (cur.xy.empty()) start_piece(sx + d.x * pos, sy + d.y * pos, d);
        cur.xy.push_back(ex);
        cur.xy.push_back(ey);
        cur.corner.push_back(cut_end ? 1 : corner[i + 1]);
      }
      if (cut_end) skip(ex, ey, part.tail);
    }
    if (on) end_piece();
  }
}

class PieceEmitter {
 public:
  PieceEmitter(const Matrix& m, Rasterizer* r, std::vector<std::vector<double>>* polys)
      : m_(m), r_(r), polys_(polys) {}
  // Same destination, different transform.
  PieceEmitter WithMatrix(const Matrix& m) const { return PieceEmitter(m, r_, polys_); }
  void Emit(const double* xy, int count) {
    if (count < 3) return;
    buf_.resize(2 * count);
    double area = 0;
    for (int i = 0; i < count; i++) m_.Map(xy[2 * i], xy[2 * i + 1], &buf_[2 * i], &buf_[2 * i + 1]);
    for (int i = 0; i < count; i++) {
      int j = (i + 1) % count;
      area += buf_[2 * i] * buf_[2 * j + 1] - buf_[2 * j] * buf_[2 * i + 1];
    }
    if (!(area != 0) || !std::isfinite(area)) return;
    if (area < 0) {
      for (int i = 0, j = count - 1; i < j; i++, j--) {
        std::swap(buf_[2 * i], buf_[2 * j]);
        std::swap(buf_[2 * i + 1], buf_[2 * j + 1]);
      }
    }
    if (r_) r_->AddPolygon(buf_.data(), count);
    if (polys_) polys_->push_back(buf_);
  }

 private:
  Matrix m_;
  Rasterizer* r_;
  std::vector<std::vector<double>>* polys_;
  std::vector<double> buf_;
};

class Stroker {
 public:
  Stroker(const StrokeParams& sp, double hw, double device_scale, PieceEmitter* em)
      : sp_(sp), hw_(hw), arc_step_(ArcStep(hw * device_scale, sp.tolerance)), em_(em) {}

  // Angle between arc points for a device radius r_dev: chords within `tol` of the arc, at most ~628 per circle.
  static double ArcStep(double r_dev, double tol) {
    double step = (r_dev > tol) ? 2 * std::acos(1 - tol / r_dev) : M_PI / 2;
    if (!(step > 0.01)) step = 0.01;
    return step;
  }

  void Stroke(const Polyline& in, Dir dot_dir) {
    // Drop repeated points.
    pts_.clear();
    corner_.clear();
    size_t n_in = in.size();
    for (size_t i = 0; i < n_in; i++) {
      double x = in.xy[2 * i], y = in.xy[2 * i + 1];
      if (!pts_.empty() && pts_[pts_.size() - 2] == x && pts_.back() == y) {
        corner_.back() = corner_.back() | in.corner[i];
        continue;
      }
      pts_.push_back(x);
      pts_.push_back(y);
      corner_.push_back(in.corner[i]);
    }
    bool closed = in.closed;
    size_t n = pts_.size() / 2;
    if (closed && n > 1 && pts_[0] == pts_[2 * n - 2] && pts_[1] == pts_[2 * n - 1]) {
      pts_.resize(2 * (n - 1));
      corner_.resize(n - 1);
      n--;
    }
    if (n == 0) return;
    if (n == 1) {
      if (in.had_segment) Dot(pts_[0], pts_[1], dot_dir);
      return;
    }
    if (closed && n == 2) closed = false;  // a closed two-point path is a line traced there and back
    size_t nseg = closed ? n : n - 1;
    seg_.resize(nseg);
    for (size_t i = 0; i < nseg; i++) {
      size_t j = (i + 1) % n;
      double x0 = pts_[2 * i], y0 = pts_[2 * i + 1], x1 = pts_[2 * j], y1 = pts_[2 * j + 1];
      double len = std::hypot(x1 - x0, y1 - y0);
      Seg& s = seg_[i];
      s.dx = (x1 - x0) / len;
      s.dy = (y1 - y0) / len;
      double nx = -s.dy * hw_, ny = s.dx * hw_;
      s.ls[0] = x0 + nx; s.ls[1] = y0 + ny;
      s.rs[0] = x0 - nx; s.rs[1] = y0 - ny;
      s.le[0] = x1 + nx; s.le[1] = y1 + ny;
      s.re[0] = x1 - nx; s.re[1] = y1 - ny;
      double hex[12] = {s.ls[0], s.ls[1], s.le[0], s.le[1], x1, y1, s.re[0], s.re[1], s.rs[0], s.rs[1], x0, y0};
      em_->Emit(hex, 6);
    }
    if (closed) {
      for (size_t k = 0; k < n; k++) Join(seg_[(k + n - 1) % n], seg_[k], k);
    } else {
      for (size_t k = 1; k + 1 < n; k++) Join(seg_[k - 1], seg_[k], k);
      const Seg& first = seg_[0];
      const Seg& last = seg_[nseg - 1];
      // Start cap faces backwards: from the right offset to the left offset around -d.
      Cap(pts_[0], pts_[1], -first.dx, -first.dy, first.rs, first.ls);
      Cap(pts_[2 * n - 2], pts_[2 * n - 1], last.dx, last.dy, last.le, last.re);
    }
  }

 private:
  struct Seg {
    double dx, dy;
    double ls[2], rs[2], le[2], re[2];
  };

  void Dot(double x, double y, Dir d) {
    if (sp_.cap == LineCap::kButt) return;
    if (sp_.cap == LineCap::kRound) {
      poly_.clear();
      int n = std::max(8, static_cast<int>(std::ceil(2 * M_PI / arc_step_)));
      for (int i = 0; i < n; i++) {
        double a = 2 * M_PI * i / n;
        poly_.push_back(x + hw_ * std::cos(a));
        poly_.push_back(y + hw_ * std::sin(a));
      }
      em_->Emit(poly_.data(), n);
      return;
    }
    double ux = d.x * hw_, uy = d.y * hw_, nx = -uy, ny = ux;
    double q[8] = {x - ux + nx, y - uy + ny, x + ux + nx, y + uy + ny, x + ux - nx, y + uy - ny, x - ux - nx, y - uy - ny};
    em_->Emit(q, 4);
  }

  // a and b are the offset points on either side of the end point (x, y); (dx, dy) points outwards.
  void Cap(double x, double y, double dx, double dy, const double* a, const double* b) {
    if (sp_.cap == LineCap::kButt) return;
    if (sp_.cap == LineCap::kSquare) {
      double ex = dx * hw_, ey = dy * hw_;
      double q[8] = {a[0], a[1], a[0] + ex, a[1] + ey, b[0] + ex, b[1] + ey, b[0], b[1]};
      em_->Emit(q, 4);
      return;
    }
    poly_.clear();
    poly_.push_back(a[0]);
    poly_.push_back(a[1]);
    Arc(x, y, a, b, dx, dy);
    poly_.push_back(b[0]);
    poly_.push_back(b[1]);
    em_->Emit(poly_.data(), static_cast<int>(poly_.size() / 2));
  }

  // Appends arc points strictly between a and b around centre (x, y), passing through the direction (mx, my).
  void Arc(double x, double y, const double* a, const double* b, double mx, double my) {
    double a0 = std::atan2(a[1] - y, a[0] - x);
    double a1 = std::atan2(b[1] - y, b[0] - x);
    double am = std::atan2(my, mx);
    // Sweep from a0 to a1 in the direction that passes am.
    double ccw = a1 - a0;
    while (ccw <= 0) ccw += 2 * M_PI;
    double to_m = am - a0;
    while (to_m < 0) to_m += 2 * M_PI;
    double sweep = (to_m <= ccw) ? ccw : ccw - 2 * M_PI;
    int n = static_cast<int>(std::ceil(std::fabs(sweep) / arc_step_));
    for (int i = 1; i < n; i++) {
      double t = a0 + sweep * i / n;
      poly_.push_back(x + hw_ * std::cos(t));
      poly_.push_back(y + hw_ * std::sin(t));
    }
  }

  void Join(const Seg& s0, const Seg& s1, size_t k) {
    double x = pts_[2 * k], y = pts_[2 * k + 1];
    double cross = s0.dx * s1.dy - s0.dy * s1.dx;
    double dot = s0.dx * s1.dx + s0.dy * s1.dy;
    if (std::fabs(cross) < 1e-12 && dot > 0) return;  // straight on
    const double* a;
    const double* b;
    if (cross > 0) {
      a = s0.re;
      b = s1.rs;
    } else {
      a = s0.le;
      b = s1.ls;
    }
    LineJoin join = corner_[k] ? sp_.join : LineJoin::kRound;
    double o0x = (a[0] - x) / hw_, o0y = (a[1] - y) / hw_;
    double o1x = (b[0] - x) / hw_, o1y = (b[1] - y) / hw_;
    double hx = (o0x + o1x) * 0.5, hy = (o0y + o1y) * 0.5;
    double hlen = std::hypot(hx, hy);
    if (join == LineJoin::kRound) {
      poly_.clear();
      poly_.push_back(x);
      poly_.push_back(y);
      poly_.push_back(a[0]);
      poly_.push_back(a[1]);
      double mx = hlen > 1e-9 ? hx : s0.dx, my = hlen > 1e-9 ? hy : s0.dy;
      Arc(x, y, a, b, mx, my);
      poly_.push_back(b[0]);
      poly_.push_back(b[1]);
      em_->Emit(poly_.data(), static_cast<int>(poly_.size() / 2));
      return;
    }
    if (join == LineJoin::kMiter && hlen > 1e-9 && 1.0 / hlen <= sp_.miter_limit) {
      double s = hw_ / (hlen * hlen);
      double q[8] = {x, y, a[0], a[1], x + hx * s, y + hy * s, b[0], b[1]};
      em_->Emit(q, 4);
      return;
    }
    double t[6] = {x, y, a[0], a[1], b[0], b[1]};
    em_->Emit(t, 3);
  }

  const StrokeParams& sp_;
  double hw_;
  double arc_step_;
  PieceEmitter* em_;
  std::vector<double> pts_;
  std::vector<uint8_t> corner_;
  std::vector<Seg> seg_;
  std::vector<double> poly_;
};

// Device-space copy of a user-space polyline (hairline strokes are built in device space).
void MapPolyline(const Matrix& m, Polyline* pl) {
  for (size_t i = 0; i < pl->size(); i++) m.Map(pl->xy[2 * i], pl->xy[2 * i + 1], &pl->xy[2 * i], &pl->xy[2 * i + 1]);
}

Dir MapDir(const Matrix& m, Dir d) {
  double x = m.a * d.x + m.c * d.y, y = m.b * d.x + m.d * d.y;
  double len = std::hypot(x, y);
  if (!(len > 0) || !std::isfinite(len)) return Dir{};
  return Dir{x / len, y / len};
}

double StrokeImpl(PathView path, const Matrix& path_to_user, const Matrix& user_to_device, const StrokeParams& sp,
                  PieceEmitter* em) {
  if (!user_to_device.Invertible() || !path_to_user.IsFinite()) return 0;
  if (!(sp.width > 0) || !std::isfinite(sp.width)) return 0;
  const Matrix& m = user_to_device;
  double scale = m.MaxScale();
  double tol_user = sp.tolerance / scale;
  double hw = sp.width * 0.5;
  double alpha = 1;
  // Hairline test as Skia's: the line width along each user axis, mapped to device. Only when the stroke is at most
  // one device pixel thick in BOTH directions is it drawn as a 1 px device-space line with coverage scaled by the
  // mean thickness (HTML: thin lines must not vanish). Otherwise the true geometry is stroked: under scale(0.1, 32) a
  // thin line is thin across x and thick across y, and no single user-space width describes both.
  const double wx = sp.width * std::hypot(m.a, m.b), wy = sp.width * std::hypot(m.c, m.d);
  const bool hairline = wx <= 1 && wy <= 1;
  if (hairline) {
    alpha = 0.5 * (wx + wy);
    hw = 0.5;  // device pixels
  }
  // How far a stroke piece reaches from its centre line (miter joins up to miter_limit * hw, square caps sqrt(2) * hw),
  // in user units, or in device pixels for hairlines.
  const double reach = hw * std::max({1.5, sp.join == LineJoin::kMiter ? sp.miter_limit : 1.0});
  bool dashing = false;
  UserBox cull;
  if (sp.dash && sp.dash_count > 0) {
    for (int i = 0; i < sp.dash_count; i++) dashing |= sp.dash[i] > 0;
  }
  // Dashes are placed by arc length: flatten finer so the polyline length tracks the curve's.
  std::vector<Polyline> lines;
  FlattenPath(path, path_to_user, dashing ? tol_user * 0.34 : tol_user, &lines);
  if (dashing) {
    // Bounded work: dash periods below half a device pixel along the path, or more dashes / vertices / raster rows
    // than the limits below, are drawn as an undashed stroke whose coverage is the pattern's average "on" fraction
    // (caps included). That is what the dashes average to on screen; it keeps one call from producing millions of
    // pieces.
    double period = 0, on = 0;
    int on_count = 0;
    for (int i = 0; i < sp.dash_count; i++) {
      period += sp.dash[i];
      if (i % 2 == 0) {
        on += sp.dash[i];
        on_count++;
      }
    }
    // Cull box in user space: the device box grown by 2 px (plus the reach for hairlines), mapped back (its bounding
    // box), grown by the reach for user-space strokes.
    if (sp.cull) {
      Matrix inv = m.Inverse();
      const double dm = 2 + (hairline ? reach : 0), um = hairline ? 0 : reach;
      double dx0 = sp.cull_x0 - dm, dy0 = sp.cull_y0 - dm, dx1 = sp.cull_x1 + dm, dy1 = sp.cull_y1 + dm;
      double cx[4], cy[4];
      inv.Map(dx0, dy0, &cx[0], &cy[0]);
      inv.Map(dx1, dy0, &cx[1], &cy[1]);
      inv.Map(dx1, dy1, &cx[2], &cy[2]);
      inv.Map(dx0, dy1, &cx[3], &cy[3]);
      cull.x0 = std::min({cx[0], cx[1], cx[2], cx[3]}) - um;
      cull.x1 = std::max({cx[0], cx[1], cx[2], cx[3]}) + um;
      cull.y0 = std::min({cy[0], cy[1], cy[2], cy[3]}) - um;
      cull.y1 = std::max({cy[0], cy[1], cy[2], cy[3]}) + um;
      cull.valid = std::isfinite(cull.x0) && std::isfinite(cull.x1) && std::isfinite(cull.y0) && std::isfinite(cull.y1);
    }
    // Length of the dashed path that can reach the cull box (user units, and the same parts' device length): what
    // the dash count and the work bounds are based on.
    double length = 0, dev_length = 0;
    auto add_seg = [&](double x0, double y0, double x1, double y1) {
      double len = std::hypot(x1 - x0, y1 - y0);
      ClippedPart part;
      if (len == 0 || !std::isfinite(len) || !ClipPart(cull, x0, y0, x1, y1, len, &part)) return;
      length += part.walk;
      const double ux = part.ex - part.sx, uy = part.ey - part.sy;
      dev_length += std::hypot(m.a * ux + m.c * uy, m.b * ux + m.d * uy);
    };
    for (const Polyline& pl : lines) {
      for (size_t i = 1; i < pl.size(); i++) add_seg(pl.xy[2 * i - 2], pl.xy[2 * i - 1], pl.xy[2 * i], pl.xy[2 * i + 1]);
      if (pl.closed && pl.size() > 1) add_seg(pl.xy[2 * pl.size() - 2], pl.xy[2 * pl.size() - 1], pl.xy[0], pl.xy[1]);
    }
    // Device pixels per user unit along the path (on average): the period's size on screen. MaxScale would keep a
    // pattern that is far below a pixel along a compressed axis.
    const double stretch = length > 0 ? dev_length / length : scale;
    // Each visible dash costs about one quad per segment plus its caps; round caps cost one arc point per arc step.
    double pieces = period > 0 ? length / period * on_count + on_count : 0;
    const double hw_dev = hairline ? hw : hw * scale;
    double per_piece = 6 + (sp.cap == LineCap::kRound ? 2 * M_PI / Stroker::ArcStep(hw_dev, sp.tolerance) : 8);
    // Raster rows the pieces span (the rasterizer's work and memory grow with edges x rows): each piece at most its
    // thickness plus a row of slack, plus the device length of the "on" parts.
    double rows = pieces * (2 * hw_dev + 2) + (period > 0 ? dev_length * (on / period) : 0);
    if (period * stretch < 0.5 || pieces > kMaxDashPieces || pieces * per_piece > kMaxDashVertices ||
        rows > kMaxDashRows || !std::isfinite(pieces) || !std::isfinite(rows)) {
      double cap_ext = sp.cap == LineCap::kButt ? 0 : 2 * (hairline ? hw / std::max(stretch, 1e-300) : hw) * on_count;
      double frac = period > 0 ? std::min(1.0, (on + cap_ext) / period) : 1.0;
      if (!std::isfinite(frac)) frac = 1.0;
      alpha *= frac;
      dashing = false;
      if (!(alpha > 0)) return 0;
    }
  }
  // Hairlines: pieces are built from device-space polylines and emitted untransformed.
  PieceEmitter dev_em = em->WithMatrix(Matrix::Identity());
  PieceEmitter* out = hairline ? &dev_em : em;
  Stroker stroker(sp, hw, hairline ? 1.0 : scale, out);
  if (dashing) {
    std::vector<Polyline> dashes;
    std::vector<Dir> dirs;
    DashPolylines(lines, sp, cull, static_cast<size_t>(2 * kMaxDashPieces), &dashes, &dirs);
    for (size_t i = 0; i < dashes.size(); i++) {
      if (hairline) {
        MapPolyline(m, &dashes[i]);
        dirs[i] = MapDir(m, dirs[i]);
      }
      stroker.Stroke(dashes[i], dirs[i]);
    }
  } else {
    for (Polyline& pl : lines) {
      if (hairline) MapPolyline(m, &pl);
      Dir d;
      stroker.Stroke(pl, d);
    }
  }
  return alpha;
}

}  // namespace

double StrokeToRasterizer(PathView path, const Matrix& path_to_user, const Matrix& user_to_device,
                          const StrokeParams& params, Rasterizer* r) {
  PieceEmitter em(user_to_device, r, nullptr);
  StrokeParams p = params;
  IntRect box = r->Clip();
  p.cull = true;
  p.cull_x0 = box.x0;
  p.cull_y0 = box.y0;
  p.cull_x1 = box.x1;
  p.cull_y1 = box.y1;
  return StrokeImpl(path, path_to_user, user_to_device, p, &em);
}

void StrokeToPolygons(PathView path, const Matrix& path_to_user, const Matrix& user_to_device,
                      const StrokeParams& params, std::vector<std::vector<double>>* polys) {
  PieceEmitter em(user_to_device, nullptr, polys);
  StrokeImpl(path, path_to_user, user_to_device, params, &em);
}

namespace {
int WindingOfPolygon(const double* xy, size_t n, double px, double py) {
  int w = 0;
  for (size_t i = 0; i < n; i++) {
    size_t j = (i + 1) % n;
    double x0 = xy[2 * i], y0 = xy[2 * i + 1], x1 = xy[2 * j], y1 = xy[2 * j + 1];
    if (y0 <= py) {
      if (y1 > py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) > 0) w++;
    } else {
      if (y1 <= py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) < 0) w--;
    }
  }
  return w;
}

// HTML (isPointInPath / isPointInStroke): points on the path itself are inside. True when (px, py) lies on an edge
// of the closed polygon, within a tiny tolerance for the rounding of flattening and transforms.
bool OnPolygonBoundary(const double* xy, size_t n, double px, double py) {
  constexpr double kEps = 1e-7;
  for (size_t i = 0; i < n; i++) {
    size_t j = (i + 1) % n;
    double x0 = xy[2 * i], y0 = xy[2 * i + 1], x1 = xy[2 * j], y1 = xy[2 * j + 1];
    if (px < std::min(x0, x1) - kEps || px > std::max(x0, x1) + kEps) continue;
    if (py < std::min(y0, y1) - kEps || py > std::max(y0, y1) + kEps) continue;
    double dx = x1 - x0, dy = y1 - y0;
    double len = std::hypot(dx, dy);
    if (len == 0) {
      if (std::fabs(px - x0) <= kEps && std::fabs(py - y0) <= kEps) return true;
      continue;
    }
    if (std::fabs(dx * (py - y0) - dy * (px - x0)) <= kEps * len) return true;
  }
  return false;
}
}  // namespace

bool PointInPath(PathView path, const Matrix& m, double x, double y, FillRule rule) {
  std::vector<Polyline> lines;
  FlattenPath(path, m, kFlattenTolerance, &lines);
  int w = 0;
  for (const Polyline& pl : lines) {
    if (pl.size() < 2) continue;
    if (OnPolygonBoundary(pl.xy.data(), pl.size(), x, y)) return true;
    w += WindingOfPolygon(pl.xy.data(), pl.size(), x, y);
  }
  return rule == FillRule::kEvenOdd ? (w & 1) != 0 : w != 0;
}

bool PointInPolygons(const std::vector<std::vector<double>>& polys, double x, double y) {
  for (const auto& p : polys) {
    if (OnPolygonBoundary(p.data(), p.size() / 2, x, y) || WindingOfPolygon(p.data(), p.size() / 2, x, y) != 0) return true;
  }
  return false;
}

bool PathBounds(PathView path, const Matrix& m, double* x0, double* y0, double* x1, double* y1) {
  bool any = false;
  double minx = 0, miny = 0, maxx = 0, maxy = 0;
  const float* p = path.data;
  const float* end = path.data + path.length;
  auto add = [&](float px, float py) {
    double x, y;
    m.Map(px, py, &x, &y);
    if (!any) {
      minx = maxx = x;
      miny = maxy = y;
      any = true;
    } else {
      minx = std::min(minx, x);
      maxx = std::max(maxx, x);
      miny = std::min(miny, y);
      maxy = std::max(maxy, y);
    }
  };
  while (p < end) {
    int verb = static_cast<int>(p[0]);
    int npts = verb == kVerbMove || verb == kVerbLine ? 1 : verb == kVerbQuad ? 2 : verb == kVerbCubic ? 3 : 0;
    if (verb < 0 || verb > kVerbClose || p + 1 + 2 * npts > end) break;
    for (int i = 0; i < npts; i++) add(p[1 + 2 * i], p[2 + 2 * i]);
    p += 1 + 2 * npts;
  }
  *x0 = minx;
  *y0 = miny;
  *x1 = maxx;
  *y1 = maxy;
  return any;
}

}  // namespace iwn::canvas2d
