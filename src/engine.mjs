import {
  makePath,
  pathPose,
  pathNearest,
  slicePath,
  lanePath,
  bodiesOverlap,
} from "./motion.mjs";
import {
  DEFAULT_OPERATIONS,
  stationLayout,
  servicePose,
  locateCrossings,
  CrossingController,
} from "./operations.mjs";
// Geometry and deterministic operations model. Distances use a local metric projection.
export const DEFAULTS = {
  fleet: 50,
  capacity: 8,
  speed: 32,
  dwell: 30,
  hold: 20,
  headway: 3,
  acceleration: 0.8,
  demand: 1500,
  groupSize: 1,
  mode: "shared",
  crossing: 0,
  seed: 42,
  berths: 5,
  reposition: true,
};
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function projection(a, b, p) {
  let dx = b[0] - a[0],
    dy = b[1] - a[1];
  let t = Math.max(
    0,
    Math.min(
      1,
      ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1),
    ),
  );
  let q = [a[0] + t * dx, a[1] + t * dy];
  return { t, q, d: distance(p, q) };
}
export function normalize(data) {
  let lines = [],
    stops = [],
    ignored = 0;
  const walk = (g, props = {}) => {
    if (!g) return;
    let name = String(
      props.name || props.Name || props.NAME || props.title || "",
    );
    if (g.type === "LineString")
      lines.push({
        name: name || `Track ${lines.length + 1}`,
        coords: g.coordinates,
      });
    else if (g.type === "MultiLineString")
      g.coordinates.forEach((c, i) =>
        walk(
          { type: "LineString", coordinates: c },
          { ...props, name: `${name || "Track"} ${i + 1}` },
        ),
      );
    else if (g.type === "Point")
      stops.push({
        name: name || `Stop ${stops.length + 1}`,
        coord: g.coordinates,
        stationType: props.stationType,
      });
    else if (g.type === "MultiPoint")
      g.coordinates.forEach((c, i) =>
        walk(
          { type: "Point", coordinates: c },
          { ...props, name: `${name || "Stop"} ${i + 1}` },
        ),
      );
    else if (g.type === "GeometryCollection")
      g.geometries.forEach((x) => walk(x, props));
    else ignored++;
  };
  if (data.type === "FeatureCollection")
    data.features.forEach((f) => walk(f.geometry, f.properties || {}));
  else if (data.type === "Feature") walk(data.geometry, data.properties || {});
  else walk(data);
  if (!lines.length)
    throw Error(
      "No track found. Include at least one LineString or MultiLineString.",
    );
  let count = 0;
  for (let l of lines) {
    if (!Array.isArray(l.coords) || l.coords.length < 2)
      throw Error("Each track needs at least two coordinates.");
    for (let p of l.coords) {
      count++;
      if (
        !Array.isArray(p) ||
        !Number.isFinite(p[0]) ||
        !Number.isFinite(p[1]) ||
        Math.abs(p[0]) > 180 ||
        Math.abs(p[1]) > 85
      )
        throw Error(
          "Coordinates must be WGS84 longitude, latitude (within ±85° latitude).",
        );
    }
  }
  for (let s of stops)
    if (
      !s.coord ||
      !Number.isFinite(s.coord[0]) ||
      !Number.isFinite(s.coord[1]) ||
      Math.abs(s.coord[0]) > 180 ||
      Math.abs(s.coord[1]) > 85
    )
      throw Error("Invalid stop coordinates. Use WGS84 longitude, latitude.");
  if (lines.length > 500)
    throw Error(
      "Maximum 500 track lines. Merge adjacent segments before importing.",
    );
  if (count > 20000)
    throw Error(
      "This demonstrator supports up to 20,000 track vertices. Simplify the file first.",
    );
  if (stops.length > 100) throw Error("Maximum 100 stops per scenario.");
  return { lines, stops, ignored };
}
export function buildNetwork(input, { snap = 30, stationSnap = 100 } = {}) {
  const raw = normalize(input),
    origin = raw.lines[0].coords[0],
    cos = Math.cos((origin[1] * Math.PI) / 180),
    sx = 111195 * cos,
    sy = 111195;
  const project = (p) => [(p[0] - origin[0]) * sx, (p[1] - origin[1]) * sy],
    unproject = (p) => [origin[0] + p[0] / sx, origin[1] + p[1] / sy];
  let segments = [],
    lines = raw.lines.map((l, li) => ({
      ...l,
      points: l.coords.map(project),
      li,
    }));
  for (let l of lines)
    for (let i = 1; i < l.points.length; i++)
      if (distance(l.points[i - 1], l.points[i]) > 0.05)
        segments.push({
          a: l.points[i - 1],
          b: l.points[i],
          li: l.li,
          cuts: [0, 1],
        });
  if (!segments.length) throw Error("Track has no measurable length.");
  let warnings = [],
    connectors = [];
  function nearest(p, exclude = -1) {
    let best = null;
    for (let seg of segments) {
      if (seg.li === exclude) continue;
      let q = projection(seg.a, seg.b, p);
      if (!best || q.d < best.d) best = { ...q, seg };
    }
    return best;
  }
  // Connect line endpoints to nearby track segments. Crossings without endpoints stay grade-separated.
  for (let l of lines)
    for (let p of [l.points[0], l.points.at(-1)]) {
      let n = nearest(p, l.li);
      if (n && n.d <= snap) {
        n.seg.cuts.push(n.t);
        if (n.d > 0.05) connectors.push({ a: p, b: n.q });
      }
    }
  const stations = raw.stops.map((s, i) => {
    let p = project(s.coord),
      n = nearest(p);
    if (!n || n.d > stationSnap)
      throw Error(
        `“${s.name}” is ${Math.round(n?.d || 0)} m from track; increase the stop snap limit or correct the map.`,
      );
    n.seg.cuts.push(n.t);
    if (n.d > 5)
      warnings.push(`${s.name}: projected ${Math.round(n.d)} m to track.`);
    let line = lines[n.seg.li],
      closed = distance(line.points[0], line.points.at(-1)) < 5,
      tangent = [
        (n.seg.b[0] - n.seg.a[0]) / distance(n.seg.a, n.seg.b),
        (n.seg.b[1] - n.seg.a[1]) / distance(n.seg.a, n.seg.b),
      ];
    if (
      !closed &&
      distance(n.q, line.points[0]) < distance(n.q, line.points.at(-1))
    )
      tangent = tangent.map((v) => -v);
    let stationType = ["bypass", "terminus-single", "terminus-double"].includes(
      s.stationType,
    )
      ? s.stationType
      : closed
        ? "bypass"
        : "terminus-single";
    return {
      ...s,
      stationType,
      tangent,
      lineId: line.li,
      id: i,
      point: p,
      trackPoint: n.q,
      snapDistance: n.d,
      weight: 1,
      attraction: 1,
      enabled: true,
    };
  });
  let nodes = [],
    edges = [],
    buckets = new Map();
  function node(p) {
    let x = Math.floor(p[0] / 0.1),
      y = Math.floor(p[1] / 0.1);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        let ids = buckets.get(`${x + dx},${y + dy}`) || [];
        for (let id of ids) if (distance(nodes[id].p, p) < 0.08) return id;
      }
    let i = nodes.length,
      key = `${x},${y}`;
    nodes.push({ id: i, p, adj: [] });
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
    return i;
  }
  function edge(a, b, li) {
    let u = node(a),
      v = node(b),
      len = distance(a, b);
    if (u === v || len < 0.02) return;
    let e = { id: edges.length, u, v, len, li, a, b };
    edges.push(e);
    nodes[u].adj.push({ to: v, e });
    nodes[v].adj.push({ to: u, e });
  }
  for (let s of segments) {
    let ts = [...new Set(s.cuts)].sort((a, b) => a - b);
    for (let i = 1; i < ts.length; i++)
      edge(
        [
          s.a[0] + ts[i - 1] * (s.b[0] - s.a[0]),
          s.a[1] + ts[i - 1] * (s.b[1] - s.a[1]),
        ],
        [
          s.a[0] + ts[i] * (s.b[0] - s.a[0]),
          s.a[1] + ts[i] * (s.b[1] - s.a[1]),
        ],
        s.li,
      );
  }
  for (let c of connectors) edge(c.a, c.b, -1);
  for (let s of stations) {
    s.node = node(s.trackPoint);
    let path = makePath(lines[s.lineId].points),
      at = pathNearest(path, s.trackPoint).s,
      angle = pathPose(path, at).angle,
      sign =
        Math.cos(angle) * s.tangent[0] + Math.sin(angle) * s.tangent[1] >= 0
          ? 1
          : -1;
    s.orientation = sign;
    s.centerAt = (x) => {
      let v = at + x * sign;
      if (
        distance(lines[s.lineId].points[0], lines[s.lineId].points.at(-1)) <
        0.05
      )
        v = ((v % path.length) + path.length) % path.length;
      if (v < 0) {
        let a = pathPose(path, 0);
        return [
          a.point[0] + Math.cos(a.angle) * v,
          a.point[1] + Math.sin(a.angle) * v,
        ];
      }
      if (v > path.length) {
        let a = pathPose(path, path.length);
        return [
          a.point[0] + Math.cos(a.angle) * (v - path.length),
          a.point[1] + Math.sin(a.angle) * (v - path.length),
        ];
      }
      return pathPose(path, v).point;
    };
  }
  if (!stations.length)
    warnings.push(
      "No stop points found. Add at least two stops with the map editor.",
    );
  const routes = stations.map((from) =>
    shortestRoutes(nodes, from.node, stations),
  );
  for (let i = 0; i < stations.length; i++)
    for (let j = i + 1; j < stations.length; j++)
      if (!routes[i][j])
        throw Error(
          `No track connection between “${stations[i].name}” and “${stations[j].name}”. Add a connecting line or increase the endpoint snap limit.`,
        );
  if (
    stations.length > 1 &&
    routes.some((r, i) => r.some((p, j) => i !== j && p && p.length < 1))
  )
    throw Error(
      "Two stops project to the same track location. Move or remove one of them.",
    );
  let points = lines.flatMap((l) => l.points);
  const bounds = [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1])),
  ];
  if (raw.ignored)
    warnings.push(
      `${raw.ignored} non-track/non-stop geometries ignored (such as polygons).`,
    );
  return {
    raw,
    input,
    lines,
    nodes,
    edges,
    stations,
    routes,
    bounds,
    origin,
    project,
    unproject,
    length: edges.reduce((a, e) => a + e.len, 0),
    warnings,
    snap,
    stationSnap,
  };
}
function shortestRoutes(nodes, start, stations) {
  let dist = new Float64Array(nodes.length).fill(Infinity),
    prev = [],
    heap = [];
  dist[start] = 0;
  function push(v) {
    heap.push(v);
    let i = heap.length - 1;
    while (i > 0) {
      let p = (i - 1) >> 1;
      if (heap[p][0] <= v[0]) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = v;
  }
  function pop() {
    let top = heap[0],
      last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (true) {
        let l = i * 2 + 1,
          r = l + 1;
        if (l >= heap.length) break;
        let c = r < heap.length && heap[r][0] < heap[l][0] ? r : l;
        if (heap[c][0] >= last[0]) break;
        heap[i] = heap[c];
        i = c;
      }
      heap[i] = last;
    }
    return top;
  }
  push([0, start]);
  while (heap.length) {
    let [best, u] = pop();
    if (best !== dist[u]) continue;
    for (let { to, e } of nodes[u].adj)
      if (dist[to] > best + e.len) {
        dist[to] = best + e.len;
        prev[to] = { from: u, edge: e };
        push([dist[to], to]);
      }
  }
  return stations.map((st) => {
    let end = st.node;
    if (start === end) return { steps: [], length: 0 };
    if (!Number.isFinite(dist[end])) return null;
    let steps = [],
      u = end;
    while (u !== start) {
      let x = prev[u];
      steps.unshift({
        edge: x.edge,
        from: x.from,
        to: u,
        key: `${x.edge.id}:${x.from}`,
        a: nodes[x.from].p,
        b: nodes[u].p,
      });
      u = x.from;
    }
    return { steps, length: dist[end] };
  });
}
function routeSign(step, station) {
  if (step.edge.li === station.lineId)
    return (step.from === step.edge.u ? 1 : -1) * (station.orientation || 1);
  return (step.b[0] - step.a[0]) * station.tangent[0] +
    (step.b[1] - step.a[1]) * station.tangent[1] >=
    0
    ? 1
    : -1;
}
// Direction-constrained routing prohibits instant reversals on running tracks.
function directionalRoute(net, from, to, departure, arrival = null) {
  let source = net.stations[from],
    target = net.stations[to],
    heap = [{ node: source.node, last: -1, cost: 0, steps: [] }],
    best = new Map();
  const sign = routeSign;
  while (heap.length) {
    heap.sort((a, b) => b.cost - a.cost);
    let x = heap.pop(),
      key = `${x.node}:${x.last}`;
    if ((best.get(key) ?? Infinity) < x.cost) continue;
    if (
      x.node === target.node &&
      x.steps.length &&
      (!arrival || sign(x.steps.at(-1), target) === arrival)
    )
      return { steps: x.steps, length: x.cost };
    for (let { to: n, e } of net.nodes[x.node].adj) {
      if (e.id === x.last) continue;
      let step = {
        edge: e,
        from: x.node,
        to: n,
        key: `${e.id}:${x.node}`,
        a: net.nodes[x.node].p,
        b: net.nodes[n].p,
      };
      if (!x.steps.length && sign(step, source) !== departure) continue;
      let cost = x.cost + e.len,
        k = `${n}:${e.id}`;
      if (cost >= (best.get(k) ?? Infinity)) continue;
      best.set(k, cost);
      heap.push({ node: n, last: e.id, cost, steps: [...x.steps, step] });
    }
  }
  return null;
}
function stationPaths(st, berths) {
  let l = st.layout,
    h = l.half,
    L = l.lead,
    B = (berths - 1) * 2.5,
    world = l.world,
    paths = [];
  for (let lane = 0; lane < (st.stationType === "bypass" ? 2 : 1); lane++) {
    let dir = st.stationType === "bypass" ? (lane === 0 ? 1 : -1) : -1,
      points =
        st.stationType === "bypass"
          ? [
              [-L * dir, -0.75 * dir],
              [-(h + 3) * dir, -2.5 * dir],
              [(h + 3) * dir, -2.5 * dir],
              [L * dir, -0.75 * dir],
            ]
          : [
              [h + 8, 0],
              [h + 3, 2.5],
              [-h - 3, 2.5],
              [-L, 0.75],
            ];
    // Sample the curved host alignment so a station path joins the same physical guideway.
    let sampled = [];
    for (let i = 1; i < points.length; i++) {
      let a = points[i - 1],
        b = points[i],
        n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
      for (let j = 0; j < n; j++) {
        let t = j / n;
        sampled.push(world(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
      }
    }
    sampled.push(world(...points.at(-1)));
    let path = makePath(sampled),
      front = pathNearest(
        path,
        world(dir * B, st.stationType === "bypass" ? -dir * 2.5 : 2.5),
      ).s;
    paths.push({ path, front, dir, queue: [], lane });
  }
  return paths;
}
export class Simulation {
  constructor(
    network,
    params = {},
    stationSettings = null,
    od = null,
    operations = {},
  ) {
    this.net = network;
    this.p = { ...DEFAULTS, ...params };
    this.operations = { ...DEFAULT_OPERATIONS, ...operations };
    this.crossings = this.operations.enabled
      ? locateCrossings(network, operations.crossings || []).map(
          (c, i) =>
            new CrossingController(
              c,
              this.operations,
              this.p.seed + 12345 + i * 97,
            ),
        )
      : [];
    this.rand = rng(this.p.seed);
    this.time = 0;
    this.generated = 0;
    this.served = 0;
    this.boarded = 0;
    this.trips = 0;
    this.emptyTrips = 0;
    this.waits = [];
    this.rides = [];
    this.km = 0;
    this.emptyKm = 0;
    this.od = od;
    this.history = [];
    this.log = [];
    this.routeCache = new Map();
    this.junctions = new Map();
    this.controlNodes = network.nodes
      .filter((n) => {
        if (n.adj.length > 2) return true;
        if (
          n.adj.length !== 2 ||
          network.nodes.some((j) => j.adj.length > 2 && distance(j.p, n.p) < 25)
        )
          return false;
        let [a, b] = n.adj.map((x) =>
            network.nodes[x.to].p.map((v, i) => v - n.p[i]),
          ),
          la = Math.hypot(...a),
          lb = Math.hypot(...b),
          theta = Math.acos(
            Math.max(-1, Math.min(1, -(a[0] * b[0] + a[1] * b[1]) / (la * lb))),
          );
        return (
          theta > 0.025 && Math.min(la, lb) / (2 * Math.sin(theta / 2)) < 20
        );
      })
      .reduce((list, n) => {
        if (n.adj.length > 2 || !list.some((x) => distance(x.p, n.p) < 25))
          list.push(n);
        return list;
      }, []);
    this.departureLog = [];
    this.advanceRemainder = 0;
    this.stations = network.stations.map((s, i) => {
      let st = {
        ...s,
        ...(stationSettings?.[i] || {}),
        queue: [],
        nextArrival: Infinity,
        departures: 0,
        served: 0,
        doorObstruction: false,
        throats: [null, null],
      };
      st.layout = stationLayout(st, this.p.berths);
      st.platforms = stationPaths(st, this.p.berths);
      st.slots = Array(st.layout.capacity).fill(null);
      return st;
    });
    this.stations.forEach((s) => (s.nextArrival = this.arrival(s, 0)));
    this.pods = [];
    for (let i = 0; i < this.p.fleet; i++) {
      let pod = {
        id: i,
        station: 0,
        state: "reserve",
        speed: 0,
        load: [],
        point: network.nodes[0].p,
        angle: 0,
        ready: 0,
        doorsClosed: true,
        berth: null,
      };
      for (let k = 0; k < this.stations.length; k++) {
        let st = this.stations[(i + k) % this.stations.length],
          platform = st.platforms.find((p) => p.queue.length < this.p.berths);
        if (platform) {
          pod.station = st.id;
          pod.lane = platform.lane;
          pod.serviceS = platform.front - platform.queue.length * 5;
          pod.state = "idle";
          platform.queue.push(i);
          Object.assign(pod, pathPose(platform.path, pod.serviceS));
          break;
        }
      }
      this.pods.push(pod);
    }
    this.controlNodes = this.controlNodes.filter(
      (n) =>
        !this.stations.some(
          (st) => distance(n.p, st.trackPoint) < st.layout.lead + 20,
        ),
    );
    for (let st of this.stations)
      this.controlNodes.push({
        id: `station-${st.id}`,
        p: st.trackPoint,
        points: [-st.layout.lead, 0, st.layout.lead].map((x) =>
          st.layout.world(x, 0),
        ),
        station: st.id,
      });
    this.syncSlots();
    this.nextSample = 0;
  }
  syncSlots() {
    for (let st of this.stations) {
      st.slots.fill(null);
      for (let platform of st.platforms)
        platform.queue.forEach((id, i) => {
          st.slots[platform.lane * this.p.berths + i] = id;
          this.pods[id].berth = platform.lane * this.p.berths + i;
        });
    }
  }
  arrival(s, base = this.time) {
    let total = this.stations.reduce(
        (a, s) => a + (s.enabled ? s.weight : 0),
        0,
      ),
      rate =
        (this.p.demand * (s.enabled ? s.weight : 0)) /
        (total || 1) /
        this.p.groupSize /
        3600;
    return rate > 0
      ? base - Math.log(Math.max(1e-10, this.rand())) / rate
      : Infinity;
  }
  destination(from) {
    let ws = this.stations.map((s, i) =>
        i === from || !s.enabled
          ? 0
          : this.od
            ? Number(this.od[from]?.[i] || 0)
            : s.attraction,
      ),
      sum = ws.reduce((a, b) => a + b, 0);
    if (!sum) return -1;
    let r = this.rand() * sum;
    for (let i = 0; i < ws.length; i++) {
      r -= ws[i];
      if (r <= 0 && ws[i]) return i;
    }
    return ws.findLastIndex((x) => x > 0);
  }
  event(text) {
    this.log.unshift({ t: this.time, text });
    this.log.length = Math.min(30, this.log.length);
  }
  direction(station, dest) {
    let step = this.net.routes[station]?.[dest]?.steps[0],
      u = this.stations[station].tangent;
    if (!step) return 1;
    return routeSign(step, this.stations[station]);
  }
  getRoute(from, dest, lane, arrivalLane = null) {
    let dep =
        this.stations[from].stationType === "bypass"
          ? lane === 0
            ? 1
            : -1
          : -1,
      arr =
        this.stations[dest].stationType === "bypass"
          ? arrivalLane === null
            ? null
            : arrivalLane === 0
              ? 1
              : -1
          : 1,
      key = `${from}:${dest}:${dep}:${arr}`;
    if (!this.routeCache.has(key))
      this.routeCache.set(
        key,
        directionalRoute(this.net, from, dest, dep, arr),
      );
    return this.routeCache.get(key);
  }
  compatible(pod, dest) {
    let st = this.stations[pod.station];
    return (
      st.stationType !== "bypass" ||
      pod.lane === (this.direction(st.id, dest) > 0 ? 0 : 1)
    );
  }
  head(pod) {
    return this.stations[pod.station].platforms[pod.lane]?.queue[0] === pod.id;
  }
  step(dt = 0.25) {
    this.time += dt;
    for (let c of this.crossings) c.update(this.time, dt);
    for (let s of this.stations)
      while (s.nextArrival <= this.time) {
        let at = s.nextArrival,
          dest = this.destination(s.id);
        if (dest >= 0) {
          s.queue.push({ n: this.p.groupSize, dest, arrived: at });
          this.generated += this.p.groupSize;
        }
        s.nextArrival = this.arrival(s, at);
      }
    for (let pod of this.pods) {
      if (pod.state === "reserve") continue;
      if (pod.path) {
        this.travel(pod, dt);
        continue;
      }
      let st = this.stations[pod.station],
        platform = st.platforms[pod.lane];
      // Followers advance in order, with doors closed; they cannot pass the queue head.
      if (["idle", "advancing"].includes(pod.state)) {
        let index = platform.queue.indexOf(pod.id),
          desired = platform.front - index * 5,
          target = desired,
          ahead = index > 0 ? this.pods[platform.queue[index - 1]] : null;
        if (ahead) target = Math.min(target, ahead.serviceS - 5);
        for (let p of this.pods)
          if (
            p !== pod &&
            p.state === "departing" &&
            p.origin === st.id &&
            p.originLane === pod.lane &&
            p.localDepartureS !== undefined
          )
            target = Math.min(target, p.localDepartureS - 5);
        if (pod.serviceS < desired - 0.001) {
          pod.state = "advancing";
          if (pod.serviceS < target - 0.001)
            this.localMove(pod, platform.path, target, dt);
          else pod.speed = 0;
          continue;
        }
        pod.speed = 0;
        pod.state = "idle";
      }
      if (pod.state === "alighting") {
        if (this.time < pod.ready) continue;
        pod.load = [];
        pod.doorsClosed = true;
        if (st.stationType !== "bypass" && !pod.atDeparturePlatform) {
          this.toDrawer(pod);
          continue;
        }
        pod.state = "idle";
        continue;
      }
      if (pod.state === "reversing") {
        if (this.time < pod.ready) continue;
        this.joinTerminalQueue(pod);
        continue;
      }
      if (pod.state === "closing") {
        if (st.doorObstruction) {
          pod.doorsClosed = false;
          pod.ready = this.time + this.operations.doorWarning;
          pod.waitReason = "Door obstruction · departure held";
          continue;
        }
        if (this.time < pod.ready || !this.head(pod)) continue;
        pod.doorsClosed = true;
        pod.state = "ready";
        pod.waitReason = "Waiting for a receiving berth";
        continue;
      }
      if (pod.state === "ready") {
        if (st.doorObstruction) {
          pod.doorsClosed = false;
          pod.state = "closing";
          pod.ready = this.time + this.operations.doorWarning;
        }
        continue;
      }
      if (pod.state === "boarding") {
        this.collect(pod, st);
        let n = pod.load.reduce((a, g) => a + g.n, 0);
        if (
          (n >= this.p.capacity || this.time >= pod.release) &&
          this.time >= pod.ready
        )
          this.start(pod, pod.dest, false);
        continue;
      }
      if (
        pod.state === "idle" &&
        this.head(pod) &&
        Math.abs(pod.serviceS - platform.front) < 0.01
      ) {
        let request = st.queue.find((g) => this.compatible(pod, g.dest));
        if (request) {
          pod.state = "boarding";
          pod.dest = request.dest;
          pod.release =
            this.time + (this.p.mode === "shared" ? this.p.hold : 0);
          pod.ready = this.time + this.p.dwell / 2;
          pod.phaseStart = this.time;
          pod.load = [];
          pod.doorsClosed = false;
          this.collect(pod, st);
        }
      }
    }
    this.dispatchReady();
    if (
      this.p.reposition &&
      Math.floor((this.time - dt) / 5) !== Math.floor(this.time / 5)
    )
      this.rebalance();
    this.syncSlots();
    if (this.time >= this.nextSample) {
      this.history.push({
        t: this.time,
        served: this.served,
        queue: this.queueCount(),
        active: this.pods.filter((p) => p.path).length,
      });
      this.nextSample += 30;
    }
  }
  safeDistance(pod, path, at, ds) {
    if (ds <= 0) return 0;
    let nearby = this.pods.filter(
      (p) =>
        p !== pod &&
        p.state !== "reserve" &&
        distance(p.point, pod.point) < ds + 8,
    );
    if (!nearby.length) return ds;
    let clear = (d) => {
      let pose = pathPose(path, at + d);
      return !nearby.some((p) => bodiesOverlap(pose, p, 0.025));
    };
    let last = 0;
    for (let i = 1, n = Math.max(1, Math.ceil(ds / 0.5)); i <= n; i++) {
      let next = (ds * i) / n;
      if (!clear(next)) {
        let lo = last,
          hi = next;
        for (let k = 0; k < 12; k++) {
          let mid = (lo + hi) / 2;
          if (clear(mid)) lo = mid;
          else hi = mid;
        }
        pod.waitReason = "Physical pod clearance hold";
        pod.speed = 0;
        return lo;
      }
      last = next;
    }
    return ds;
  }
  localMove(pod, path, target, dt) {
    let cap = Math.min(
        this.p.speed / 3.6,
        Math.max(0.5, 25 / this.operations.stationMove),
      ),
      ds = Math.max(0, target - pod.serviceS);
    pod.speed = Math.min(
      cap,
      pod.speed + this.p.acceleration * dt,
      Math.sqrt(2 * this.p.acceleration * ds),
    );
    let move = this.safeDistance(
      pod,
      path,
      pod.serviceS,
      Math.min(ds, pod.speed * dt),
    );
    pod.serviceS += move;
    if (move > 1e-8) Object.assign(pod, pathPose(path, pod.serviceS));
    this.addDistance(pod, move);
  }
  collect(pod, s) {
    if (this.p.mode === "private" && pod.load.length) return;
    let used = pod.load.reduce((a, g) => a + g.n, 0);
    for (let i = 0; i < s.queue.length; ) {
      let g = s.queue[i];
      if (g.dest === pod.dest && used + g.n <= this.p.capacity) {
        pod.load.push(g);
        used += g.n;
        s.queue.splice(i, 1);
        if (this.p.mode === "private") break;
      } else i++;
    }
  }
  start(pod, dest, empty, arrivalLane = null) {
    if (
      !this.head(pod) ||
      Math.abs(
        pod.serviceS - this.stations[pod.station].platforms[pod.lane].front,
      ) > 0.01 ||
      pod.state === "advancing" ||
      (!empty && !this.compatible(pod, dest))
    )
      return false;
    if (!this.getRoute(pod.station, dest, pod.lane, arrivalLane)) return false;
    pod.pendingTrip = { dest, empty, arrivalLane };
    pod.state = "closing";
    pod.phaseStart = this.time;
    pod.ready = this.time + this.operations.doorWarning;
    pod.empty = empty;
    return true;
  }
  receiving(pod) {
    let t = pod.pendingTrip;
    if (!t) return null;
    let r = this.getRoute(pod.station, t.dest, pod.lane, t.arrivalLane);
    if (!r) return null;
    let st = this.stations[t.dest],
      last = r.steps.at(-1),
      dir = routeSign(last, st);
    return {
      station: st,
      lane: st.stationType === "bypass" ? (dir >= 0 ? 0 : 1) : 0,
    };
  }
  incomingBookings(id, lane) {
    return this.pods.filter(
      (p) =>
        p.bookedArrival &&
        p.dest === id &&
        p.targetLane === lane &&
        !this.stations[id].platforms[lane].queue.includes(p.id),
    ).length;
  }
  dispatchReady() {
    let eligible = (p) =>
      p.state === "ready" &&
      p.doorsClosed &&
      p.ready <= this.time &&
      this.head(p) &&
      !this.stations[p.station].doorObstruction;
    for (let pass = 0; pass < this.pods.length; pass++) {
      let ready = this.pods.filter(eligible),
        free = ready.find((p) => {
          let r = this.receiving(p);
          return (
            r &&
            r.station.platforms[r.lane].queue.length +
              this.incomingBookings(r.station.id, r.lane) <
              this.p.berths
          );
        });
      if (free) {
        let t = free.pendingTrip;
        this.launch(free, t.dest, t.empty, t.arrivalLane);
        continue;
      }
      // A full initial fleet can exchange berths in a closed cycle. All departures
      // commit in this same simulation tick, then each keeps its receiving berth booked.
      let cycle = null;
      for (let first of ready) {
        let chain = [],
          seen = new Map(),
          p = first;
        while (p && eligible(p)) {
          if (seen.has(p.id)) {
            cycle = chain.slice(seen.get(p.id));
            break;
          }
          seen.set(p.id, chain.length);
          chain.push(p);
          let r = this.receiving(p);
          if (!r) break;
          p = this.pods[r.station.platforms[r.lane].queue[0]];
        }
        if (cycle) break;
      }
      if (cycle) {
        for (let p of cycle) {
          let t = p.pendingTrip;
          this.launch(p, t.dest, t.empty, t.arrivalLane);
        }
        continue;
      }
      // An unrequested front pod clears a full destination by exchanging with the
      // waiting origin, rather than leaving an arriving pod stranded on the guideway.
      if (this.p.reposition)
        for (let p of ready) {
          let r = this.receiving(p),
            head = r && this.pods[r.station.platforms[r.lane].queue[0]];
          if (
            head?.state === "idle" &&
            !r.station.queue.some((g) => this.compatible(head, g.dest))
          )
            this.start(head, p.station, true, p.lane);
        }
      break;
    }
  }
  launch(pod, dest, empty, arrivalLane = null) {
    if (!pod.doorsClosed)
      throw Error("Departure interlock: pod doors must be closed.");
    let route = this.getRoute(pod.station, dest, pod.lane, arrivalLane);
    if (!route || !route.steps.length) return false;
    let origin = this.stations[pod.station],
      target = this.stations[dest],
      platform = origin.platforms[pod.lane],
      running = lanePath(route.steps),
      last = route.steps.at(-1),
      dir = routeSign(last, target),
      targetLane = target.stationType === "bypass" ? (dir > 0 ? 0 : 1) : 0,
      departure = slicePath(platform.path, pod.serviceS),
      entry = target.layout.world(-dir * target.layout.lead, -dir * 0.75),
      a = pathNearest(running, departure.points.at(-1)),
      b = pathNearest(running, entry),
      middle = slicePath(running, a.s, b.s);
    if (b.s <= a.s) return false;
    // Exact joins are part of the trajectory, never display-only jumps.
    let path = makePath([...departure.points, ...middle.points, entry]);
    pod.origin = origin.id;
    pod.originLane = pod.lane;
    pod.dest = dest;
    pod.targetLane = targetLane;
    pod.bookedArrival = true;
    pod.route = route;
    pod.path = path;
    pod.pathS = 0;
    pod.departureEnd = departure.length;
    pod.departureBase = pod.serviceS;
    pod.localDepartureS = pod.serviceS;
    pod.state = "departing";
    pod.speed = 0;
    pod.empty = empty;
    pod.depart = this.time;
    pod.delayUntil =
      this.time +
      (this.crossings.length ? 0 : (route.length / 1000) * this.p.crossing);
    pod.waitReason = "";
    platform.queue.shift();
    pod.berth = null;
    pod.crossingMarks = this.crossings
      .map((c) => ({ c, ...pathNearest(path, c.point) }))
      .filter((m) => m.d < 3 && m.s > 1 && m.s < path.length - 1);
    pod.reservedNodes = new Set();
    this.setNodeMarks(pod);
    if (empty) this.emptyTrips++;
    else {
      let n = pod.load.reduce((a, g) => a + g.n, 0);
      this.boarded += n;
      this.trips++;
      origin.departures++;
      for (let g of pod.load)
        for (let j = 0; j < g.n; j++) this.waits.push(this.time - g.arrived);
      this.event(
        `Pod ${String(pod.id + 1).padStart(2, "0")} · ${origin.name} → ${target.name} · ${n} pax`,
      );
    }
    this.departureLog.push({
      t: this.time,
      id: pod.id,
      station: origin.id,
      lane: pod.lane,
    });
    return true;
  }
  addDistance(pod, ds) {
    this.km += ds / 1000;
    if (!pod.load.length) this.emptyKm += ds / 1000;
  }
  setNodeMarks(pod) {
    pod.nodeMarks = this.controlNodes.flatMap((n) => {
      let marks = (n.points || [n.p])
        .map((p) => pathNearest(pod.path, p))
        .filter((m) => m.d < 4);
      return marks.length
        ? [
            {
              node: n.id,
              s: Math.min(...marks.map((m) => m.s)),
              end: Math.max(...marks.map((m) => m.s)),
              station: n.station,
            },
          ]
        : [];
    });
  }
  clearNodes(pod) {
    for (let n of pod.reservedNodes || [])
      if (this.junctions.get(n) === pod.id) this.junctions.delete(n);
    pod.reservedNodes = new Set();
  }
  firstAt(pod, kind, id, d) {
    if (kind === "node" && String(id).startsWith("station-")) {
      let exits = this.pods
        .filter((p) => p.state === "departing" && `station-${p.origin}` === id)
        .sort((a, b) => a.depart - b.depart || a.id - b.id);
      if (exits.length) return exits[0].id === pod.id;
    }
    for (let other of this.pods) {
      if (other === pod || !other.path) continue;
      for (let m of kind === "crossing"
        ? other.crossingMarks || []
        : other.nodeMarks || []) {
        if ((kind === "crossing" ? m.c.id : m.node) !== id) continue;
        let od = m.s - other.pathS;
        if (
          kind === "node" &&
          id === `station-${other.dest}` &&
          !other.tripStage &&
          !this.canEnter(other)
        )
          continue;
        if (
          od >= -10 &&
          (od < d - 1e-6 || (Math.abs(od - d) < 1e-6 && other.id < pod.id))
        )
          return false;
      }
    }
    return true;
  }
  travel(pod, dt) {
    let st = this.stations[pod.station];
    if (this.time < pod.delayUntil) return;
    for (let n of pod.reservedNodes || []) {
      let m = pod.nodeMarks?.find((m) => m.node === n),
        p = this.controlNodes.find((x) => x.id === n)?.p;
      if (
        !m &&
        p &&
        distance(p, pod.point) > 40 &&
        this.junctions.get(n) === pod.id
      )
        this.junctions.delete(n);
    }
    pod.waitReason = "";
    let stop = pod.path.length - pod.pathS;
    for (let m of pod.crossingMarks || []) {
      let d = m.s - pod.pathS,
        c = m.c;
      if (d < -12) {
        c.release(pod.id);
        continue;
      }
      if (d < 110 && d > 0) c.request(pod.id);
      if (c.granted.has(pod.id)) {
        if (c.intrusion) {
          stop = 0;
          pod.waitReason = `${c.name} · intrusion emergency hold`;
        }
        continue;
      }
      if (d < -10) continue;
      if (d < 15 && this.firstAt(pod, "crossing", c.id, d) && c.grant(pod.id))
        continue;
      stop = Math.min(stop, Math.max(0, d - 10));
      if (d < 25) pod.waitReason = `${c.name} · waiting for pod permission`;
    }
    for (let m of pod.nodeMarks || []) {
      let d = m.s - pod.pathS;
      if (m.end - pod.pathS < -(m.station === undefined ? 35 : 20)) {
        if (this.junctions.get(m.node) === pod.id)
          this.junctions.delete(m.node);
        continue;
      }
      let clearance = m.station === undefined ? 35 : 20;
      if (d > clearance + 20) continue;
      let owner = this.junctions.get(m.node),
        fullApproach =
          m.node === `station-${pod.dest}` &&
          !pod.tripStage &&
          !this.canEnter(pod);
      if (owner === pod.id && fullApproach && d > 0) {
        this.junctions.delete(m.node);
        owner = undefined;
      }
      if (
        pod.state === "departing" &&
        m.node === `station-${pod.origin}` &&
        owner !== undefined &&
        owner !== pod.id
      ) {
        let other = this.pods[owner],
          mark = other.nodeMarks?.find((x) => x.node === m.node);
        if (
          other.state !== "departing" &&
          mark &&
          mark.s - other.pathS > 8 &&
          this.firstAt(pod, "node", m.node, d)
        ) {
          this.junctions.set(m.node, pod.id);
          pod.reservedNodes.add(m.node);
          owner = pod.id;
        }
      }
      if (
        !fullApproach &&
        String(m.node).startsWith("station-") &&
        owner !== undefined &&
        owner !== pod.id
      ) {
        let leader = this.pods[owner],
          q = leader?.path
            ? pathNearest(
                leader.path,
                pod.point,
                leader.pathS,
                leader.pathS + 80,
              )
            : null;
        if (
          q &&
          q.d < 1.35 &&
          q.s > leader.pathS + 0.01 &&
          Math.cos(pod.angle - leader.angle) > 0.5
        ) {
          this.junctions.set(m.node, pod.id);
          pod.reservedNodes.add(m.node);
          owner = pod.id;
        }
      }
      if (
        owner === undefined &&
        !fullApproach &&
        d < clearance + 6 &&
        this.firstAt(pod, "node", m.node, d)
      ) {
        this.junctions.set(m.node, pod.id);
        pod.reservedNodes.add(m.node);
      } else if (owner !== pod.id) {
        stop = Math.min(stop, Math.max(0, d - clearance));
        pod.waitReason = "Switch route occupied";
      }
    }
    // Compare physical trajectories, including waiting station approaches and merging pods.
    for (let other of this.pods) {
      if (other === pod || other.state === "reserve") continue;
      if (
        Math.hypot(
          other.point[0] - pod.point[0],
          other.point[1] - pod.point[1],
        ) > 100
      )
        continue;
      let q = pathNearest(
        pod.path,
        other.point,
        Math.max(0, pod.pathS - 1),
        pod.pathS + 100,
      );
      if (
        q.d < 1.35 &&
        Math.cos(other.angle - pathPose(pod.path, q.s).angle) > 0.25 &&
        (q.s > pod.pathS + 0.01 ||
          (Math.abs(q.s - pod.pathS) < 0.01 && other.id < pod.id))
      ) {
        let gap = Math.max(
          0,
          q.s - pod.pathS - Math.max(5, pod.speed * this.p.headway),
        );
        if (gap < stop) {
          stop = gap;
          pod.waitReason = "Pod ahead · separation hold";
        }
      }
    }
    if (!pod.tripStage && !this.canEnter(pod)) {
      stop = Math.min(stop, Math.max(0, pod.path.length - pod.pathS - 12));
      if (stop < 30)
        pod.waitReason = "Platform full · waiting before entry switch";
    }
    let local = pod.state !== "moving",
      cap = Math.min(
        this.p.speed / 3.6,
        local ? Math.max(0.5, 25 / this.operations.stationMove) : Infinity,
      ),
      remaining = pod.path.length - pod.pathS;
    // Do not brake at the through-to-siding state boundary; stop at the actual queue/drawer.
    if (pod.tripStage === "approach" && !this.canEnter(pod)) {
      stop = 0;
      pod.waitReason = "Platform full or arrival route occupied";
    }
    pod.speed = Math.min(
      cap,
      pod.speed + this.p.acceleration * dt,
      Math.sqrt(2 * this.p.acceleration * Math.max(0, stop)),
    );
    let ds = this.safeDistance(
      pod,
      pod.path,
      pod.pathS,
      Math.max(0, Math.min(pod.speed * dt, stop, remaining)),
    );
    pod.pathS += ds;
    this.addDistance(pod, ds);
    if (ds > 1e-8) Object.assign(pod, pathPose(pod.path, pod.pathS));
    if (pod.state === "departing") {
      pod.localDepartureS = pod.departureBase + pod.pathS;
      if (pod.pathS >= pod.departureEnd) {
        pod.state = "moving";
        delete pod.localDepartureS;
      }
    }
    if (pod.pathS < pod.path.length - 1e-5) return;
    pod.speed = 0;
    for (let m of pod.crossingMarks || []) m.c.release(pod.id);
    if (!pod.tripStage) {
      pod.station = pod.dest;
      pod.lane = pod.targetLane;
      pod.state = "holding";
      pod.tripStage = "approach";
      pod.crossingMarks = [];
      this.beginEntry(pod);
    } else if (pod.tripStage === "entry") {
      pod.path = null;
      pod.tripStage = null;
      this.finishArrival(pod);
    } else if (pod.tripStage === "terminal-queue") {
      pod.path = null;
      pod.tripStage = null;
      pod.serviceS = pod.entryServiceTarget;
      Object.assign(
        pod,
        pathPose(this.stations[pod.station].platforms[0].path, pod.serviceS),
      );
      pod.state = "idle";
      pod.atDeparturePlatform = true;
      st.throats[0] = null;
      if (st.stationType === "terminus-single" && !pod.empty) this.unload(pod);
    } else if (pod.tripStage === "drawer") {
      pod.path = null;
      pod.tripStage = null;
      pod.state = "reversing";
      pod.ready = this.time + this.operations.turnaround;
      pod.phaseStart = this.time;
    } else if (pod.tripStage === "approach") this.beginEntry(pod);
  }
  canEnter(pod) {
    let st = this.stations[pod.dest],
      platform = st.platforms[pod.targetLane];
    let tail = this.pods[platform.queue.at(-1)],
      space =
        !tail ||
        tail.serviceS >= platform.front - (this.p.berths - 2) * 5 - 0.001;
    return (
      space &&
      platform.queue.length < this.p.berths &&
      (st.throats[pod.targetLane] === null ||
        st.throats[pod.targetLane] === pod.id)
    );
  }
  beginEntry(pod) {
    if (!this.canEnter(pod)) return;
    let st = this.stations[pod.dest],
      platform = st.platforms[pod.targetLane];
    st.throats[pod.targetLane] = pod.id;
    pod.state = "entering";
    pod.atDeparturePlatform = false;
    pod.phaseStart = this.time;
    pod.tripStage = "entry";
    pod.pathS = 0;
    if (st.stationType === "bypass") {
      pod.serviceS = 0;
      let tail = this.pods[platform.queue.at(-1)],
        at = Math.min(
          platform.front - platform.queue.length * 5,
          tail ? tail.serviceS - 5 : Infinity,
        );
      platform.queue.push(pod.id);
      pod.bookedArrival = false;
      pod.path = makePath([
        pod.point,
        ...slicePath(platform.path, 0, at).points,
      ]);
      pod.entryServiceTarget = at;
    } else {
      let h = st.layout.half,
        L = st.layout.lead,
        end = st.stationType === "terminus-double" ? [h - 2, -2.5] : [h + 8, 0],
        pts = [
          pod.point,
          st.layout.world(-h - 3, -0.75),
          st.layout.world(
            -h + 1,
            st.stationType === "terminus-double" ? -2.5 : -0.75,
          ),
          st.layout.world(...end),
        ];
      pod.path = makePath(pts);
    }
    this.setNodeMarks(pod);
    pod.ready =
      this.time +
      pod.path.length / Math.max(0.5, 25 / this.operations.stationMove);
  }
  unload(pod) {
    let st = this.stations[pod.station],
      n = pod.load.reduce((a, g) => a + g.n, 0);
    this.served += n;
    st.served += n;
    for (let j = 0; j < n; j++) this.rides.push(this.time - pod.depart);
    pod.state = "alighting";
    pod.doorsClosed = false;
    pod.phaseStart = this.time;
    pod.ready = this.time + this.p.dwell / 2;
  }
  finishArrival(pod) {
    this.clearNodes(pod);
    let st = this.stations[pod.station];
    if (st.stationType === "bypass") {
      pod.serviceS = pod.entryServiceTarget;
      st.throats[pod.lane] = null;
      if (pod.empty) pod.state = "idle";
      else this.unload(pod);
    } else if (st.stationType === "terminus-single") this.toDrawer(pod);
    else if (pod.empty) this.toDrawer(pod);
    else this.unload(pod);
  }

  toDrawer(pod) {
    let st = this.stations[pod.station],
      drawer = st.layout.world(st.layout.half + 8, 0);
    if (distance(pod.point, drawer) < 0.01) {
      pod.state = "reversing";
      pod.phaseStart = this.time;
      pod.ready = this.time + this.operations.turnaround;
    } else {
      pod.path = makePath([pod.point, drawer]);
      pod.pathS = 0;
      pod.tripStage = "drawer";
      pod.state = "entering";
      pod.crossingMarks = [];
      pod.nodeMarks = [];
    }
  }
  joinTerminalQueue(pod) {
    let st = this.stations[pod.station],
      platform = st.platforms[0];
    if (platform.queue.length >= this.p.berths) return;
    let tail = this.pods[platform.queue.at(-1)],
      target = Math.min(
        platform.front - platform.queue.length * 5,
        tail ? tail.serviceS - 5 : Infinity,
      );
    platform.queue.push(pod.id);
    pod.bookedArrival = false;
    let drawer = st.layout.world(st.layout.half + 8, 0),
      path = slicePath(platform.path, 0, target);
    pod.path = makePath([pod.point, drawer, ...path.points]);
    pod.pathS = 0;
    pod.tripStage = "terminal-queue";
    pod.state = "entering";
    pod.speed = 0;
    pod.crossingMarks = [];
    pod.nodeMarks = [];
    pod.entryServiceTarget = target;
  }
  rebalance() {
    let local = (id, lane) => this.stations[id].platforms[lane].queue.length,
      incoming = (id, lane) =>
        this.pods.filter(
          (p) =>
            ((p.path && p.dest === id && p.targetLane === lane) ||
              (["closing", "ready"].includes(p.state) &&
                p.pendingTrip?.empty &&
                p.pendingTrip.dest === id &&
                p.pendingTrip.arrivalLane === lane)) &&
            !this.stations[id].platforms[lane].queue.includes(p.id),
        ).length;
    let heads = this.stations.flatMap((st) =>
      st.platforms.map((p) => this.pods[p.queue[0]]).filter(Boolean),
    );
    for (let st of this.stations) {
      if (!st.enabled) continue;
      for (let platform of st.platforms) {
        let lane = platform.lane,
          demand = st.queue
            .filter(
              (g) =>
                st.stationType !== "bypass" ||
                (this.direction(st.id, g.dest) > 0 ? 0 : 1) === lane,
            )
            .reduce((a, g) => a + g.n, 0),
          stock = local(st.id, lane) + incoming(st.id, lane),
          desired = Math.min(
            this.p.berths,
            Math.ceil(demand / this.p.capacity) + 1,
          );
        if (stock >= desired) continue;
        let choices = heads
          .filter(
            (p) =>
              p.state === "idle" &&
              p.station !== st.id &&
              !this.stations[p.station].queue.some((g) =>
                this.compatible(p, g.dest),
              ),
          )
          .map((p) => ({ p, r: this.getRoute(p.station, st.id, p.lane, lane) }))
          .filter((x) => x.r)
          .sort((a, b) => a.r.length - b.r.length);
        for (let { p } of choices) {
          if (local(st.id, lane) + incoming(st.id, lane) >= desired) break;
          if (
            !demand &&
            this.stations[p.station].platforms[p.lane].queue.length <= 1
          )
            continue;
          this.start(p, st.id, true, lane);
        }
      }
    }
    // Stock-balancing heuristic: release the FIRST pod of a full, unrequested platform, toward a low-stock platform.
    for (let st of this.stations)
      for (let platform of st.platforms) {
        let pod = this.pods[platform.queue[0]];
        if (
          !pod ||
          pod.state !== "idle" ||
          platform.queue.length < this.p.berths ||
          st.queue.some((g) => this.compatible(pod, g.dest))
        )
          continue;
        let choices = this.stations
          .filter((s) => s.id !== st.id && s.enabled)
          .flatMap((s) =>
            s.platforms.map((p) => ({
              id: s.id,
              lane: p.lane,
              stock: local(s.id, p.lane) + incoming(s.id, p.lane),
              r: this.getRoute(st.id, s.id, pod.lane, p.lane),
            })),
          )
          .filter((x) => x.r && x.stock < this.p.berths - 1)
          .sort((a, b) => a.stock - b.stock || a.r.length - b.r.length);
        if (choices[0]) this.start(pod, choices[0].id, true, choices[0].lane);
      }
  }
  advance(seconds) {
    this.advanceRemainder += seconds;
    let n = Math.floor((this.advanceRemainder + 1e-9) / 0.25);
    this.advanceRemainder -= n * 0.25;
    for (let i = 0; i < n; i++) this.step(0.25);
  }
  queueCount() {
    return this.stations.reduce(
      (a, s) => a + s.queue.reduce((b, g) => b + g.n, 0),
      0,
    );
  }
  stats() {
    let sorted = [...this.waits].sort((a, b) => a - b),
      mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    return {
      elapsed: this.time,
      generated: this.generated,
      served: this.served,
      boarded: this.boarded,
      waiting: this.queueCount(),
      boarding: this.pods
        .filter((p) => ["boarding", "closing", "ready"].includes(p.state))
        .reduce((a, p) => a + p.load.reduce((x, g) => x + g.n, 0), 0),
      onboard: this.pods
        .filter((p) => (p.path || p.state === "reversing") && !p.empty)
        .reduce((a, p) => a + p.load.reduce((x, g) => x + g.n, 0), 0),
      throughput: this.time ? (this.served / this.time) * 3600 : 0,
      meanWait: mean(this.waits),
      p95Wait: sorted.length ? sorted[Math.ceil(0.95 * sorted.length) - 1] : 0,
      meanRide: mean(this.rides),
      load: this.trips ? this.boarded / this.trips : 0,
      trips: this.trips,
      emptyTrips: this.emptyTrips,
      km: this.km,
      emptyKm: this.emptyKm,
      moving: this.pods.filter((p) => p.path || p.state === "advancing").length,
      reserve: this.pods.filter((p) => p.state === "reserve").length,
      roadPassed: this.crossings.reduce((a, c) => a + c.passedCars, 0),
      roadWaiting: this.crossings.reduce(
        (a, c) => a + c.cars.filter((x) => x.speed < 0.1).length,
        0,
      ),
    };
  }
}
