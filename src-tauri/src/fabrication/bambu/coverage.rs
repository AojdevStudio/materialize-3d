//! Bed rasters that compare where a tool extruded on layer 1 with where its parts touch
//! the plate. Every mask samples pixel centres on one bed-aligned grid, so masks from the
//! 3MF and from the G-code line up pixel for pixel.

use super::{Bbox, ExtrusionSegment};

/// One plate-contact triangle in bed XY.
pub(super) type Triangle = [[f64; 2]; 3];

/// A window of the bed sampled at `px_per_mm`. Pixel `(col, row)` samples the bed point at
/// its centre, `(min_x + (col + 0.5) / px_per_mm, min_y + (row + 0.5) / px_per_mm)`.
pub(super) struct Grid {
    min_x: f64,
    min_y: f64,
    px_per_mm: f64,
    width: usize,
    height: usize,
}

/// Row-major, one entry per grid pixel.
type Mask = Vec<bool>;

/// How well one tool's layer-1 extrusion matches its parts' plate contact.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct ToolCoverage {
    /// Share of the footprint core (the footprint eroded by the band) that the tool's
    /// extrusion covers. `None` when the core is empty.
    pub recall: Option<f64>,
    /// Share of the tool's extruded pixels farther than the band from its footprint.
    /// `None` when the tool extruded nothing.
    pub spill: Option<f64>,
}

impl Grid {
    /// Grid over `bbox` grown by `margin_mm` on every side. `None` when that window would
    /// need more than `max_pixels`.
    pub fn covering(
        bbox: &Bbox,
        margin_mm: f64,
        px_per_mm: f64,
        max_pixels: usize,
    ) -> Option<Self> {
        let min_x = bbox.min_x - margin_mm;
        let min_y = bbox.min_y - margin_mm;
        let cells = |span: f64| {
            let cells = ((span + 2.0 * margin_mm) * px_per_mm).ceil();
            // Rejected before the cast when it would not fit comfortably.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            (cells.is_finite() && cells >= 1.0 && cells <= max_pixels as f64)
                .then_some(cells as usize)
        };
        let width = cells(bbox.max_x - bbox.min_x)?;
        let height = cells(bbox.max_y - bbox.min_y)?;
        (width.checked_mul(height)? <= max_pixels).then_some(Self {
            min_x,
            min_y,
            px_per_mm,
            width,
            height,
        })
    }

    fn mask(&self) -> Mask {
        vec![false; self.width * self.height]
    }

    /// Indices `i` in `0..len` whose sample `origin + (i + 0.5) / px_per_mm` lies in `[lo, hi]`.
    fn samples_within(&self, origin: f64, len: usize, lo: f64, hi: f64) -> std::ops::Range<usize> {
        let first = ((lo - origin) * self.px_per_mm - 0.5).ceil().max(0.0);
        let last = ((hi - origin) * self.px_per_mm - 0.5).floor() + 1.0;
        // Both ends are clamped into 0..=len before the cast.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let clamp = |v: f64| v.clamp(0.0, len as f64) as usize;
        clamp(first)..clamp(last).max(clamp(first))
    }

    fn row_y(&self, row: usize) -> f64 {
        #[allow(clippy::cast_precision_loss)]
        let row = row as f64;
        self.min_y + (row + 0.5) / self.px_per_mm
    }

    fn fill_span(&self, mask: &mut Mask, row: usize, (lo, hi): (f64, f64)) {
        let cols = self.samples_within(self.min_x, self.width, lo, hi);
        mask[row * self.width + cols.start..row * self.width + cols.end].fill(true);
    }

    /// Sets every pixel whose centre lies inside the convex polygon `points`.
    fn fill_convex(&self, mask: &mut Mask, points: &[[f64; 2]]) {
        let (lo, hi) = points
            .iter()
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| {
                (lo.min(p[1]), hi.max(p[1]))
            });
        for row in self.samples_within(self.min_y, self.height, lo, hi) {
            if let Some(span) = convex_span(points, self.row_y(row)) {
                self.fill_span(mask, row, span);
            }
        }
    }

    /// Sets every pixel within `radius` of the segment `a`-`b`: the bead one extrusion lays.
    fn fill_capsule(&self, mask: &mut Mask, a: [f64; 2], b: [f64; 2], radius: f64) {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let length = dx.hypot(dy);
        let side = (length > 0.0).then(|| {
            let (nx, ny) = (-dy / length * radius, dx / length * radius);
            [
                [a[0] + nx, a[1] + ny],
                [b[0] + nx, b[1] + ny],
                [b[0] - nx, b[1] - ny],
                [a[0] - nx, a[1] - ny],
            ]
        });
        let rows = self.samples_within(
            self.min_y,
            self.height,
            a[1].min(b[1]) - radius,
            a[1].max(b[1]) + radius,
        );
        for row in rows {
            let y = self.row_y(row);
            // The capsule is convex, so its row span is the hull of its pieces' spans.
            let span = [disk_span(a, radius, y), disk_span(b, radius, y)]
                .into_iter()
                .chain(side.map(|quad| convex_span(&quad, y)))
                .flatten()
                .reduce(|(lo, hi), (l, h)| (lo.min(l), hi.max(h)));
            if let Some(span) = span {
                self.fill_span(mask, row, span);
            }
        }
    }

    /// Squared distance, in pixels, from every pixel to the nearest set pixel of `mask`
    /// (infinite when none is set). Exact Euclidean transform (Felzenszwalb and Huttenlocher).
    fn squared_distance(&self, mask: &Mask) -> Vec<f64> {
        let mut dist: Vec<f64> = mask
            .iter()
            .map(|&set| if set { 0.0 } else { f64::INFINITY })
            .collect();
        let mut line = Vec::new();
        let mut out = Vec::new();
        let mut envelope = Envelope::default();
        for col in 0..self.width {
            line.clear();
            line.extend((0..self.height).map(|row| dist[row * self.width + col]));
            out.resize(line.len(), 0.0);
            envelope.transform(&line, &mut out);
            for (row, value) in out.iter().enumerate() {
                dist[row * self.width + col] = *value;
            }
        }
        for row in dist.chunks_mut(self.width) {
            line.clear();
            line.extend_from_slice(row);
            envelope.transform(&line, row);
        }
        dist
    }
}

/// x-interval where the horizontal line at `y` crosses the convex polygon `points`.
fn convex_span(points: &[[f64; 2]], y: f64) -> Option<(f64, f64)> {
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for (i, p) in points.iter().enumerate() {
        let q = points[(i + 1) % points.len()];
        if y < p[1].min(q[1]) || y > p[1].max(q[1]) {
            continue;
        }
        let xs = if p[1] == q[1] {
            (p[0], q[0])
        } else {
            let x = p[0] + (y - p[1]) / (q[1] - p[1]) * (q[0] - p[0]);
            (x, x)
        };
        lo = lo.min(xs.0.min(xs.1));
        hi = hi.max(xs.0.max(xs.1));
    }
    (lo <= hi).then_some((lo, hi))
}

fn disk_span(center: [f64; 2], radius: f64, y: f64) -> Option<(f64, f64)> {
    let dy = y - center[1];
    let reach = (radius * radius - dy * dy).sqrt();
    (reach >= 0.0).then_some((center[0] - reach, center[0] + reach))
}

/// Scratch space for the 1D squared-distance transform: the lower envelope of the parabolas
/// rooted at each finite sample.
#[derive(Default)]
struct Envelope {
    roots: Vec<usize>,
    /// `bounds[k]` is where parabola `roots[k]` starts to be the lowest.
    bounds: Vec<f64>,
}

impl Envelope {
    fn transform(&mut self, f: &[f64], out: &mut [f64]) {
        self.roots.clear();
        self.bounds.clear();
        #[allow(clippy::cast_precision_loss)]
        let at = |i: usize| i as f64;
        for (q, fq) in f.iter().enumerate() {
            if !fq.is_finite() {
                continue;
            }
            let height = fq + at(q) * at(q);
            loop {
                let Some((&p, &start)) = self.roots.last().zip(self.bounds.last()) else {
                    self.roots.push(q);
                    self.bounds.push(f64::NEG_INFINITY);
                    break;
                };
                let meet = (height - (f[p] + at(p) * at(p))) / (2.0 * (at(q) - at(p)));
                if meet <= start {
                    self.roots.pop();
                    self.bounds.pop();
                } else {
                    self.roots.push(q);
                    self.bounds.push(meet);
                    break;
                }
            }
        }
        if self.roots.is_empty() {
            out.fill(f64::INFINITY);
            return;
        }
        let mut k = 0;
        for (q, value) in out.iter_mut().enumerate() {
            while k + 1 < self.roots.len() && self.bounds[k + 1] <= at(q) {
                k += 1;
            }
            let p = self.roots[k];
            *value = (at(q) - at(p)).powi(2) + f[p];
        }
    }
}

/// Rasterizes one tool's plate contact and layer-1 beads on `grid` and scores them.
/// `band_mm` is how far extrusion may stray from the footprint edge either way (the tool's
/// line width): recall ignores footprint within the band of its edge, and spill ignores
/// extrusion within the band outside it.
///
/// Beads rasterize conservatively: a pixel counts as extruded when a bead reaches within
/// half a pixel of its centre. Neighbouring arachne walls nominally overlap by about 0.04 mm,
/// less than half a 0.1 mm pixel, so centre sampling alone reads their joins as pinholes
/// (1.8% of the proven navy lettering's core, the size of a small missing letter).
pub(super) fn measure(
    grid: &Grid,
    contact: &[Triangle],
    segments: &[ExtrusionSegment],
    band_mm: f64,
) -> ToolCoverage {
    let mut footprint = grid.mask();
    for triangle in contact {
        grid.fill_convex(&mut footprint, triangle);
    }
    let mut extruded = grid.mask();
    for s in segments {
        let radius = s.width_mm / 2.0 + 0.5 / grid.px_per_mm;
        grid.fill_capsule(&mut extruded, [s.x0, s.y0], [s.x1, s.y1], radius);
    }
    let band_sq = (band_mm * grid.px_per_mm).powi(2);

    let outside: Mask = footprint.iter().map(|&inside| !inside).collect();
    let to_outside = grid.squared_distance(&outside);
    let (mut core, mut core_covered) = (0_u32, 0_u32);
    for ((&inside, &depth), &hit) in footprint.iter().zip(&to_outside).zip(&extruded) {
        if inside && depth > band_sq {
            core += 1;
            core_covered += u32::from(hit);
        }
    }

    let to_footprint = grid.squared_distance(&footprint);
    let (mut laid, mut stray) = (0_u32, 0_u32);
    for (&hit, &distance) in extruded.iter().zip(&to_footprint) {
        if hit {
            laid += 1;
            stray += u32::from(distance > band_sq);
        }
    }

    let ratio = |part: u32, whole: u32| (whole > 0).then(|| f64::from(part) / f64::from(whole));
    ToolCoverage {
        recall: ratio(core_covered, core),
        spill: ratio(stray, laid),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid() -> Grid {
        let bbox = Bbox {
            min_x: 0.0,
            max_x: 10.0,
            min_y: 0.0,
            max_y: 10.0,
        };
        Grid::covering(&bbox, 2.0, 10.0, 1_000_000).expect("grid")
    }

    fn count(mask: &Mask) -> usize {
        mask.iter().filter(|&&set| set).count()
    }

    #[test]
    fn rasterized_areas_match_the_geometry() {
        let grid = grid();
        let mut square = grid.mask();
        grid.fill_convex(&mut square, &[[1.0, 1.0], [9.0, 1.0], [9.0, 9.0]]);
        grid.fill_convex(&mut square, &[[1.0, 1.0], [9.0, 9.0], [1.0, 9.0]]);
        assert_eq!(count(&square), 80 * 80, "8 mm square at 10 px/mm");

        let mut bead = grid.mask();
        grid.fill_capsule(&mut bead, [2.0, 3.0], [8.0, 5.0], 1.0);
        let expected = 40.0_f64.sqrt() * 2.0 + std::f64::consts::PI;
        #[allow(clippy::cast_precision_loss)]
        let area = count(&bead) as f64 / 100.0;
        assert!(
            (area - expected).abs() < 0.01 * expected,
            "{area} vs {expected}"
        );
    }

    #[test]
    fn distance_transform_is_euclidean() {
        let grid = grid();
        let mut dot = grid.mask();
        dot[20 * grid.width + 30] = true;
        let dist = grid.squared_distance(&dot);
        assert_eq!(dist[20 * grid.width + 30], 0.0);
        assert_eq!(dist[24 * grid.width + 33], 25.0);
        assert_eq!(dist[20 * grid.width + 100], 70.0 * 70.0);
        assert!(grid
            .squared_distance(&grid.mask())
            .iter()
            .all(|d| d.is_infinite()));
    }
}
