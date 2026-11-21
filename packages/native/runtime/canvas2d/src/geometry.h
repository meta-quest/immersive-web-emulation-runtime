/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Path flattening, stroking and dashing.
//
// Strokes follow HTML's "trace a path" in user space: the path is mapped to user space, flattened with a tolerance
// that is kFlattenTolerance device pixels after the user->device transform, dashed by arc length, and offset into
// pieces (one quad per segment, a wedge per join, a cap per open end). Every piece is emitted as a closed polygon with positive
// orientation in device space, so the nonzero fill of all pieces is their union: the stroke region. Points shared by
// neighbouring pieces are computed once, so their common edges cancel exactly in the rasterizer.
#pragma once

#include <vector>

#include "iwn/canvas2d/types.h"
#include "raster.h"

namespace iwn::canvas2d {

// Curves are flattened into chords within this distance of the curve (device pixels). Chords of a convex curve lie
// inside it (on average 2/3 of the chord's sagitta), which biases every curved edge inward; WalkFlattened moves
// interior points outward by that amount (estimated from the curve's second derivative), so the polyline crosses
// the curve and the covered area matches. With that, 0.06 px gives edge pixels within ~1/255 of analytic coverage on
// average (0.2 px without the correction was ~20/255 too light on curved edges).
constexpr double kFlattenTolerance = 0.06;  // device pixels

struct Polyline {
  std::vector<double> xy;         // x0 y0 x1 y1 ...
  std::vector<uint8_t> corner;    // per point: 1 = a path vertex (lineJoin applies), 0 = inside a flattened curve
  bool closed = false;
  bool had_segment = false;       // the subpath had at least one segment (a lone moveTo draws nothing)
  size_t size() const { return xy.size() / 2; }
};

// Maps `path` with `m` and flattens curves so the result stays within `tolerance` (in the mapped space).
void FlattenPath(PathView path, const Matrix& m, double tolerance, std::vector<Polyline>* out);

// Fills: maps with `m`, flattens at kFlattenTolerance and feeds the rasterizer.
void AddPathToRasterizer(PathView path, const Matrix& m, Rasterizer* r, double tolerance = kFlattenTolerance);

struct StrokeParams {
  double width = 1;
  LineCap cap = LineCap::kButt;
  LineJoin join = LineJoin::kMiter;
  double miter_limit = 10;
  const float* dash = nullptr;  // even count (JS duplicates odd lists, HTML setLineDash); all zero = no dashing
  int dash_count = 0;
  double dash_offset = 0;
  double tolerance = kFlattenTolerance;  // flattening tolerance, device pixels
  // Device-space box outside of which nothing is drawn (StrokeToRasterizer sets it to the rasterizer's clip box).
  // Dashes whose pieces cannot reach it are skipped by arithmetic instead of being generated.
  bool cull = false;
  double cull_x0 = 0, cull_y0 = 0, cull_x1 = 0, cull_y1 = 0;
};

// Strokes `path`: `path_to_user` maps its points to user space, `user_to_device` is the current transform. Adds the
// stroke polygons (device space) to `r`. Returns the coverage multiplier for hairlines: strokes thinner than one
// device pixel along both user axes are drawn one device pixel wide with coverage scaled by their mean device width
// (HTML: thin lines must not vanish); anything thicker in either direction is stroked with its true geometry.
// Returns 0 when nothing is drawn (singular transform).
double StrokeToRasterizer(PathView path, const Matrix& path_to_user, const Matrix& user_to_device,
                          const StrokeParams& params, Rasterizer* r);

// Same polygons, collected (device space) instead of rasterized; used by isPointInStroke.
void StrokeToPolygons(PathView path, const Matrix& path_to_user, const Matrix& user_to_device,
                      const StrokeParams& params, std::vector<std::vector<double>>* polys);

// Winding test of a point against a path (flattened in device space).
bool PointInPath(PathView path, const Matrix& m, double x, double y, FillRule rule);
bool PointInPolygons(const std::vector<std::vector<double>>& polys, double x, double y);

// Bounding box of the path mapped by m (control points included). Returns false for an empty path.
bool PathBounds(PathView path, const Matrix& m, double* x0, double* y0, double* x1, double* y1);

}  // namespace iwn::canvas2d
