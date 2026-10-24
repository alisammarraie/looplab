// Illustrative station and crossing operations; all geometry and timing are assumptions.
// Layout coordinates, phase times and road demand remain demonstration assumptions.
export const DEFAULT_OPERATIONS = {
  enabled: true,
  roadGreen: 20,
  podGreen: 12,
  amber: 3,
  clearance: 3,
  roadDemand: 300,
  pedDemand: 120,
  turnaround: 6,
  doorWarning: 2,
  stationMove: 8,
};
export const PHASE_LABELS = {
  "road-green": "Cars / pedestrians green",
  "road-amber": "Cars amber · pods held",
  "all-red": "All red · checking clearance",
  "pod-green": "Pods released · road red",
  "pod-clearance": "All red · clearing pods",
  fault: "Intrusion detected · all red",
};
export const SERVICE_LABELS = {
  idle: "Ready at platform",
  holding: "Waiting for a berth",
  entering: "Entering station",
  alighting: "Alighting · doors open",
  reversing: "Switch-back / direction change",
  boarding: "Boarding · doors open",
  closing: "Door warning / closing",
  ready: "Doors closed · waiting for berth / route",
  departing: "Departure route reserved",
  moving: "On guideway",
  advancing: "Advancing in FIFO queue",
  reserve: "Stored outside service",
};
function opRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function stationLayout(station, berths = 4) {
  let u = station.tangent || [1, 0],
    n = [-u[1], u[0]],
    type = station.stationType || "bypass",
    platforms = type === "bypass" || type === "terminus-double" ? 2 : 1,
    half = Math.max(12, (berths * 5) / 2 + 3),
    lead = half + 12;
  return {
    type,
    platforms,
    berths,
    capacity: (type === "bypass" ? 2 : 1) * berths,
    u,
    n,
    half,
    lead,
    world: (x, y) => {
      if (station.centerAt) {
        let q = station.centerAt(x),
          a = station.centerAt(x - 0.05),
          b = station.centerAt(x + 0.05),
          d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [q[0] - ((b[1] - a[1]) / d) * y, q[1] + ((b[0] - a[0]) / d) * y];
      }
      return [
        station.trackPoint[0] + u[0] * x + n[0] * y,
        station.trackPoint[1] + u[1] * x + n[1] * y,
      ];
    },
  };
}
export function berthLocal(station, slot, berths = 4) {
  let lane = Math.floor((slot || 0) / berths),
    direction = station.stationType === "bypass" ? (lane === 0 ? 1 : -1) : -1,
    x = direction * ((berths - 1) / 2 - ((slot || 0) % berths)) * 5,
    y = station.stationType === "bypass" ? -direction * 2.5 : 2.5;
  return { x, y, direction };
}
export function servicePose(station, pod, berths, time) {
  let l = stationLayout(station, berths),
    b = berthLocal(station, Math.max(0, pod.berth ?? 0), berths);
  return {
    point: pod.point || l.world(b.x, b.y),
    angle: pod.angle ?? Math.atan2(l.u[1] * b.direction, l.u[0] * b.direction),
    x: b.x,
    y: b.y,
    direction: b.direction,
  };
}
export function seedCrossings(net, count = 16) {
  let line =
      net.lines.find(
        (l) =>
          Math.hypot(
            l.points[0][0] - l.points.at(-1)[0],
            l.points[0][1] - l.points.at(-1)[1],
          ) < 5,
      ) || net.lines[0],
    segments = line.points
      .slice(1)
      .map((p, i) => ({
        a: line.points[i],
        b: p,
        len: Math.hypot(p[0] - line.points[i][0], p[1] - line.points[i][1]),
      })),
    total = segments.reduce((a, s) => a + s.len, 0);
  if (total < 100) return [];
  let result = [];
  for (let i = 0; i < count; i++) {
    let target = ((i + 0.4) * total) / count,
      chosen = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      let d = (target + attempt * 11) % total;
      for (let seg of segments) {
        if (d <= seg.len) {
          let t = d / seg.len,
            point = [
              seg.a[0] + t * (seg.b[0] - seg.a[0]),
              seg.a[1] + t * (seg.b[1] - seg.a[1]),
            ];
          chosen = {
            point,
            angle:
              Math.atan2(seg.b[1] - seg.a[1], seg.b[0] - seg.a[0]) +
              Math.PI / 2,
          };
          break;
        }
        d -= seg.len;
      }
      if (
        net.stations.every(
          (s) =>
            Math.hypot(
              s.trackPoint[0] - chosen.point[0],
              s.trackPoint[1] - chosen.point[1],
            ) > 80,
        ) &&
        net.nodes
          .filter((n) => n.adj.length > 2)
          .every(
            (n) =>
              Math.hypot(n.p[0] - chosen.point[0], n.p[1] - chosen.point[1]) >
              70,
          ) &&
        result.every(
          (c) =>
            Math.hypot(
              ...net.project(c.coord).map((v, j) => v - chosen.point[j]),
            ) > 70,
        )
      )
        break;
    }
    result.push({
      id: `X${String(i + 1).padStart(2, "0")}`,
      name: `CROSS ${String(i + 1).padStart(2, "0")}`,
      coord: net.unproject(chosen.point),
      roadAngle: (chosen.angle * 180) / Math.PI,
      enabled: true,
      confirmed: false,
    });
  }
  return result;
}
export function locateCrossings(net, configs) {
  return configs
    .filter((c) => c.enabled !== false)
    .map((c, i) => {
      let p = net.project(c.coord),
        best = null;
      for (let e of net.edges) {
        let dx = e.b[0] - e.a[0],
          dy = e.b[1] - e.a[1],
          t = Math.max(
            0,
            Math.min(
              1,
              ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / (e.len * e.len),
            ),
          ),
          q = [e.a[0] + t * dx, e.a[1] + t * dy],
          d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (!best || d < best.d) best = { e, t, q, d };
      }
      if (!best || best.d > 100)
        throw Error(
          `${c.name || c.id}: crossing is more than 100 m from the guideway.`,
        );
      if (
        net.nodes.some(
          (n) =>
            n.adj.length > 2 &&
            Math.hypot(n.p[0] - best.q[0], n.p[1] - best.q[1]) < 55,
        )
      )
        throw Error(
          `${c.name || c.id}: move this crossing at least 55 m from a branch switch to clear the demonstration routing zone.`,
        );
      if (
        net.stations.some(
          (s) =>
            Math.hypot(
              s.trackPoint[0] - best.q[0],
              s.trackPoint[1] - best.q[1],
            ) <
            stationLayout(s, 4).lead + 40,
        )
      )
        throw Error(
          `${c.name || c.id}: move this crossing outside the station approach zone (at least 65 m from the stop).`,
        );
      let angle = Number.isFinite(c.roadAngle)
        ? (c.roadAngle * Math.PI) / 180
        : Math.atan2(best.e.b[1] - best.e.a[1], best.e.b[0] - best.e.a[0]) +
          Math.PI / 2;
      return {
        ...c,
        name: c.name || c.id || `CROSS ${i + 1}`,
        id: c.id || `X${i + 1}`,
        point: best.q,
        edgeId: best.e.id,
        trackAngle: Math.atan2(
          best.e.b[1] - best.e.a[1],
          best.e.b[0] - best.e.a[0],
        ),
        offset: best.t * best.e.len,
        roadAngle: angle,
      };
    });
}
export class CrossingController {
  constructor(config, settings = {}, seed = 1) {
    Object.assign(this, config);
    this.settings = { ...DEFAULT_OPERATIONS, ...settings };
    this.random = opRandom(seed);
    this.phase = "road-green";
    this.phaseStart = 0;
    this.requests = new Set();
    this.granted = new Set();
    this.intrusion = false;
    this.cars = [];
    this.people = [];
    this.passedCars = 0;
    this.passedPeds = 0;
    this.passedPods = 0;
    this.nextCar = this.sample(this.settings.roadDemand);
    this.nextPed = this.sample(this.settings.pedDemand);
    this.serial = 0;
    this.waitSeconds = 0;
  }
  sample(rate) {
    return rate > 0
      ? (-Math.log(Math.max(1e-9, this.random())) * 3600) / rate
      : Infinity;
  }
  transition(phase, time) {
    this.phase = phase;
    this.phaseStart = time;
  }
  request(id) {
    this.requests.add(id);
  }
  release(id) {
    if (this.granted.delete(id)) this.passedPods++;
  }
  grant(id) {
    if (this.granted.has(id)) return !this.intrusion;
    if (this.phase !== "pod-green" || this.intrusion || this.granted.size)
      return false;
    if (this.roadOccupied()) return false;
    this.granted.add(id);
    return true;
  }
  roadOccupied() {
    return (
      this.cars.some((c) => Math.abs(c.pos) < 6.5) ||
      this.people.some((p) => Math.abs(p.pos) < 2.2)
    );
  }
  get roadSignal() {
    return this.intrusion
      ? "red"
      : this.phase === "road-green"
        ? "green"
        : this.phase === "road-amber"
          ? "amber"
          : "red";
  }
  get podSignal() {
    return !this.intrusion && this.phase === "pod-green" ? "green" : "red";
  }
  get pedestrianSignal() {
    return this.roadSignal === "green" ? "walk" : "wait";
  }
  update(time, dt) {
    while (time >= this.nextCar) {
      let dir = this.random() < 0.5 ? 1 : -1,
        tail = Math.min(
          -90,
          ...this.cars.filter((c) => c.dir === dir).map((c) => c.pos - 7),
        );
      this.cars.push({
        id: ++this.serial,
        dir,
        pos: tail,
        speed: 0,
        committed: false,
      });
      this.nextCar += this.sample(this.settings.roadDemand);
    }
    while (time >= this.nextPed) {
      this.people.push({
        id: ++this.serial,
        dir: this.random() < 0.5 ? 1 : -1,
        pos: -16,
        committed: false,
      });
      this.nextPed += this.sample(this.settings.pedDemand);
    }
    if (this.intrusion) this.transition("fault", time);
    else if (this.phase === "fault") this.transition("all-red", time);
    if (this.manualRequestUntil >= time) this.requests.add("manual");
    let elapsed = time - this.phaseStart;
    if (
      this.phase === "road-green" &&
      elapsed >= this.settings.roadGreen &&
      this.requests.size
    )
      this.transition("road-amber", time);
    else if (this.phase === "road-amber" && elapsed >= this.settings.amber)
      this.transition("all-red", time);
    else if (
      this.phase === "all-red" &&
      elapsed >= this.settings.clearance &&
      !this.roadOccupied() &&
      !this.granted.size
    )
      this.transition("pod-green", time);
    else if (this.phase === "pod-green" && elapsed >= this.settings.podGreen)
      this.transition("pod-clearance", time);
    else if (
      this.phase === "pod-clearance" &&
      elapsed >= this.settings.clearance &&
      !this.granted.size
    )
      this.transition("road-green", time);
    this.requests.clear();
    for (let dir of [-1, 1]) {
      let lane = this.cars
          .filter((c) => c.dir === dir)
          .sort((a, b) => b.pos - a.pos),
        leader = Infinity;
      for (let c of lane) {
        let allowed = this.roadSignal === "green" || c.committed,
          limit = allowed ? Infinity : -10 - c.pos;
        if (this.intrusion && Math.abs(c.pos) < 12) limit = 0;
        let gap = leader - c.pos - 6.8,
          remaining = Math.max(0, Math.min(limit, gap));
        c.speed = Math.min(
          30 / 3.6,
          c.speed + 1.4 * dt,
          Math.sqrt(2 * 1.8 * remaining),
        );
        let ds = Math.min(c.speed * dt, remaining);
        c.pos += ds;
        if (c.pos > -10 + 0.001) c.committed = true;
        if (c.speed < 0.1) this.waitSeconds += dt;
        leader = c.pos;
      }
    }
    let before = this.cars.length;
    this.cars = this.cars.filter((c) => c.pos < 95);
    this.passedCars += before - this.cars.length;
    for (let p of this.people) {
      let allowed = this.pedestrianSignal === "walk" || p.committed;
      if (!this.intrusion) {
        p.pos += Math.min(
          1.25 * dt,
          allowed ? Infinity : Math.max(0, -4 - p.pos),
        );
        if (p.pos > -4 + 0.001) p.committed = true;
      }
    }
    before = this.people.length;
    this.people = this.people.filter((p) => p.pos < 16);
    this.passedPeds += before - this.people.length;
  }
}
