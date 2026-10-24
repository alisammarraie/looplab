// Shared physical paths: the model and both views use these exact coordinates.
export function makePath(points) {
  let pts = points.filter(
      (p, i) =>
        !i ||
        Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-7,
    ),
    ends = [0];
  for (let i = 1; i < pts.length; i++)
    ends.push(
      ends.at(-1) +
        Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]),
    );
  return { points: pts, ends, length: ends.at(-1) || 0 };
}
export function pathPose(path, s) {
  s = Math.max(0, Math.min(path.length, s));
  let lo = 1,
    hi = path.ends.length - 1;
  while (lo < hi) {
    let mid = (lo + hi) >> 1;
    if (path.ends[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  let i = lo;
  let a = path.points[i - 1] || path.points[0],
    b = path.points[i] || a,
    d = path.ends[i] - path.ends[i - 1] || 1,
    t = (s - (path.ends[i - 1] || 0)) / d;
  return {
    point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    angle: Math.atan2(b[1] - a[1], b[0] - a[0]),
  };
}
export function pathNearest(path, p, min = 0, max = Infinity) {
  let best = { d: Infinity, s: 0 };
  let low = 1,
    high = path.ends.length - 1;
  while (low < high) {
    let mid = (low + high) >> 1;
    if (path.ends[mid] < min) low = mid + 1;
    else high = mid;
  }
  for (let i = low; i < path.points.length; i++) {
    if (path.ends[i - 1] > max) break;
    let a = path.points[i - 1],
      b = path.points[i],
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      len = path.ends[i] - path.ends[i - 1],
      lo = Math.max(0, (min - path.ends[i - 1]) / len),
      hi = Math.min(1, (max - path.ends[i - 1]) / len),
      t = Math.max(
        lo,
        Math.min(hi, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len)),
      );
    if (lo > hi) continue;
    let q = [a[0] + dx * t, a[1] + dy * t],
      d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < best.d) best = { d, s: path.ends[i - 1] + len * t, point: q };
  }
  return best;
}
export function slicePath(path, start = 0, end = path.length) {
  return makePath([
    pathPose(path, start).point,
    ...path.points.filter((p, i) => path.ends[i] > start && path.ends[i] < end),
    pathPose(path, end).point,
  ]);
}
export function lanePath(steps) {
  if (!steps.length) return makePath([]);
  let vectors = steps.map((s) => {
      let dx = s.b[0] - s.a[0],
        dy = s.b[1] - s.a[1],
        len = Math.hypot(dx, dy);
      return {
        u: [dx / len, dy / len],
        n: [(dy / len) * 0.75, (-dx / len) * 0.75],
        len,
      };
    }),
    first = steps[0].a,
    out = [[first[0] + vectors[0].n[0], first[1] + vectors[0].n[1]]];
  for (let i = 1; i < steps.length; i++) {
    let p = steps[i].a,
      a = vectors[i - 1],
      b = vectors[i],
      t = Math.min(8, a.len * 0.45, b.len * 0.45),
      A = p.map((v, k) => v - a.u[k] * t + a.n[k]),
      B = p.map((v, k) => v + b.u[k] * t + b.n[k]),
      C = A.map((v, k) => v + a.u[k] * t * 0.7),
      D = B.map((v, k) => v - b.u[k] * t * 0.7);
    out.push(A);
    let count = Math.max(3, Math.ceil(t * 2));
    for (let j = 1; j <= count; j++) {
      let f = j / count,
        g = 1 - f;
      out.push(
        A.map(
          (v, k) =>
            g * g * g * v +
            3 * g * g * f * C[k] +
            3 * g * f * f * D[k] +
            f * f * f * B[k],
        ),
      );
    }
  }
  let end = steps.at(-1).b,
    n = vectors.at(-1).n;
  out.push([end[0] + n[0], end[1] + n[1]]);
  return makePath(out);
}
export function bodiesOverlap(a, b, margin = 0) {
  let dx = b.point[0] - a.point[0],
    dy = b.point[1] - a.point[1];
  if (Math.hypot(dx, dy) > 4.3 + margin) return false;
  return [a.angle, a.angle + Math.PI / 2, b.angle, b.angle + Math.PI / 2].every(
    (t) => {
      let extent = (angle) =>
        2 * Math.abs(Math.cos(t - angle)) +
        0.6375 * Math.abs(Math.sin(t - angle));
      return (
        Math.abs(dx * Math.cos(t) + dy * Math.sin(t)) <
        extent(a.angle) + extent(b.angle) + margin
      );
    },
  );
}
