import {
  stationLayout,
  berthLocal,
  servicePose,
  SERVICE_LABELS,
  PHASE_LABELS,
} from "./operations.mjs";
export function drawPod(
  ctx,
  screen,
  point,
  angle,
  scale,
  {
    empty = false,
    doors = false,
    id = null,
    warning = false,
    selected = false,
    capacity = 8,
    load = 0,
    doorSide = -1,
  } = {},
) {
  let p = screen(point),
    length = Math.max(9, 4 * scale),
    width = Math.max(5, 1.275 * scale);
  let front = screen([point[0] + Math.cos(angle), point[1] + Math.sin(angle)]),
    screenAngle = Math.atan2(front[1] - p[1], front[0] - p[0]);
  ctx.save();
  ctx.translate(...p);
  ctx.rotate(screenAngle);
  ctx.shadowColor = "#173b2920";
  ctx.shadowBlur = selected ? 9 : 2;
  ctx.fillStyle = empty ? "#fafdf5" : "#286a54";
  ctx.strokeStyle = selected ? "#e5a23d" : "#174f3b";
  ctx.lineWidth = selected ? 2 : 1;
  ctx.beginPath();
  ctx.roundRect(
    -length / 2,
    -width / 2,
    length,
    width,
    Math.max(1, width * 0.25),
  );
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  if (scale > 2) {
    ctx.fillStyle = empty ? "#bbd6d1" : "#a9d0c3";
    for (let k of [-1, 1]) {
      ctx.fillRect(
        k * length * 0.31 - length * 0.09,
        -width * 0.36,
        length * 0.18,
        width * 0.72,
      );
    }
    ctx.fillStyle = empty ? "#b2c5b0" : "#8eb49a";
    for (let x of [-0.15, 0.15])
      for (let y of [-0.22, 0.22]) {
        ctx.beginPath();
        ctx.roundRect(
          x * length - length * 0.06,
          y * width - width * 0.1,
          length * 0.12,
          width * 0.2,
          0.5,
        );
        ctx.fill();
      }
    ctx.strokeStyle = warning ? "#e8a22c" : doors ? "#b1e5a1" : "#b6d8bc";
    ctx.lineWidth = Math.max(1, scale * 0.12);
    ctx.beginPath();
    ctx.moveTo(
      -0.435 * scale,
      doorSide * (width / 2 + (doors ? 0.4 * scale : 0)),
    );
    ctx.lineTo(
      0.435 * scale,
      doorSide * (width / 2 + (doors ? 0.4 * scale : 0)),
    );
    ctx.stroke();
    if (doors) {
      ctx.fillStyle = "#e3d78d";
      ctx.fillRect(
        -0.5 * scale,
        doorSide * (width / 2 + 0.38 * scale),
        scale,
        0.3 * scale,
      );
    }
    if (load && scale > 5) {
      ctx.fillStyle = "#f8f5df";
      let n = Math.min(capacity, load, 8);
      for (let j = 0; j < n; j++) {
        ctx.beginPath();
        ctx.arc(
          ((j % 4) - 1.5) * 0.48 * scale,
          (j < 4 ? -0.12 : 0.18) * scale,
          0.1 * scale,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }
    if (id !== null && scale > 5) {
      ctx.rotate(-screenAngle);
      ctx.font = `600 ${Math.min(12, scale * 1.5)}px sans-serif`;
      ctx.fillStyle = "#254a3e";
      ctx.textAlign = "center";
      ctx.fillText(`P${String(id + 1).padStart(2, "0")}`, 0, width / 2 + 12);
    }
  }
  ctx.restore();
}
function path(ctx, screen, pts, color, width) {
  ctx.beginPath();
  pts.forEach((p, i) =>
    i ? ctx.lineTo(...screen(p)) : ctx.moveTo(...screen(p)),
  );
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}
export function drawStationPlan(
  ctx,
  screen,
  station,
  sim,
  scale,
  { labels = true, showIds = false } = {},
) {
  let l = stationLayout(station, sim.p.berths),
    h = l.half,
    world = l.world;
  function polygon(points, fill, stroke = null) {
    let outline = [];
    for (let i = 0; i < points.length; i++) {
      let a = points[i],
        b = points[(i + 1) % points.length],
        n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
      for (let j = 0; j < n; j++)
        outline.push([
          a[0] + ((b[0] - a[0]) * j) / n,
          a[1] + ((b[1] - a[1]) * j) / n,
        ]);
    }
    ctx.beginPath();
    outline
      .map((p) => screen(world(...p)))
      .forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }
  let platforms =
    l.type === "bypass" || l.type === "terminus-double" ? [-4.7, 4.7] : [4.7];
  for (let y of platforms) {
    polygon(
      [
        [-h, y - 1.2],
        [h, y - 1.2],
        [h, y + 1.2],
        [-h, y + 1.2],
      ],
      "#e0d7bdde",
      "#b1a98e",
    );
    let edge = y < 0 ? y + 1.05 : y - 1.05;
    path(
      ctx,
      screen,
      [world(-h, edge), world(h, edge)],
      "#dfb75a",
      Math.max(1, 0.18 * scale),
    );
    polygon(
      [
        [-h + 0.8, y - 0.95],
        [h - 0.8, y - 0.95],
        [h - 0.8, y + 0.95],
        [-h + 0.8, y + 0.95],
      ],
      "#e8eee780",
      "#bac6b7",
    );
    if (scale > 4) {
      for (let x of [-h + 1.5, h - 1.5]) {
        let q = screen(world(x, y));
        ctx.fillStyle = "#f6f9ec";
        ctx.beginPath();
        ctx.arc(...q, 0.4 * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#7b8f77";
        ctx.font = `${Math.max(8, scale * 1.2)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText("♿", q[0], q[1] + 3);
        ctx.textAlign = "left";
      }
    }
  }
  let track = (points) => {
    let samples = [];
    for (let i = 1; i < points.length; i++) {
      let a = points[i - 1],
        b = points[i],
        n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
      for (let j = 0; j < n; j++)
        samples.push([
          a[0] + ((b[0] - a[0]) * j) / n,
          a[1] + ((b[1] - a[1]) * j) / n,
        ]);
    }
    samples.push(points.at(-1));
    let pts = samples.map((p) => world(...p));
    path(ctx, screen, pts, "#fffef4", Math.max(2, 1.6 * scale));
    path(ctx, screen, pts, "#8b9b86", Math.max(1, 0.2 * scale));
  };
  if (l.type === "bypass") {
    for (let sign of [-1, 1])
      track([
        [-l.lead, 0.75 * sign],
        [-h - 3, 2.5 * sign],
        [h + 3, 2.5 * sign],
        [l.lead, 0.75 * sign],
      ]);
    if (labels && scale > 3) {
      for (let [text, x, y] of [
        ["FIFO A → · front at right", 0, -7],
        ["← FIFO B · front at left", 0, 7],
      ]) {
        let q = screen(world(x, y));
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#526e50";
        ctx.fillText(text, ...q);
        ctx.textAlign = "left";
      }
    }
  } else {
    track([
      [-l.lead, -0.75],
      [-h - 3, -0.75],
      [-h + 1, l.type === "terminus-double" ? -2.5 : -0.75],
      [h - 2, l.type === "terminus-double" ? -2.5 : 0],
      [h + 8, 0],
    ]);
    track([
      [h + 8, 0],
      [h + 3, 2.5],
      [-h - 3, 2.5],
      [-l.lead, 0.75],
    ]);
    let stop = screen(world(h + 8, 0));
    ctx.strokeStyle = "#8b4d41";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(stop[0] - 3, stop[1] - 5);
    ctx.lineTo(stop[0] + 3, stop[1] + 5);
    ctx.stroke();
    if (labels && scale > 3) {
      for (let [text, x, y] of [
        ["Reserved reversal drawer", h + 6, -4],
        ["← FIFO departure · front at left", 0, 7],
        ...(l.type === "terminus-double"
          ? [["Arrival / alighting →", 0, -7]]
          : []),
      ]) {
        let q = screen(world(x, y));
        ctx.font = "10px sans-serif";
        ctx.fillStyle = "#657d59";
        ctx.textAlign = "center";
        ctx.fillText(text, ...q);
        ctx.textAlign = "left";
      }
    }
  }
  let ps = sim.pods.filter(
    (p) =>
      p.station === station.id &&
      !["moving", "departing", "reserve"].includes(p.state),
  );
  for (let pod of ps) {
    let pose = servicePose(station, pod, sim.p.berths, sim.time);
    drawPod(ctx, screen, pose.point, pose.angle, scale, {
      empty: pod.load.length === 0,
      doors: !pod.doorsClosed,
      id: showIds ? pod.id : null,
      warning: pod.state === "closing" && Math.floor(sim.time * 3) % 2 === 0,
      load: pod.load.reduce((a, g) => a + g.n, 0),
      capacity: sim.p.capacity,
      doorSide:
        station.stationType !== "bypass" &&
        berthLocal(station, pod.berth, sim.p.berths).y <= 0
          ? 1
          : -1,
    });
    if (["boarding", "alighting"].includes(pod.state) && scale > 2) {
      let b = berthLocal(station, pod.berth, sim.p.berths),
        side = l.type === "bypass" ? (b.y < 0 ? -1 : 1) : -1,
        total = pod.load.reduce((a, g) => a + g.n, 0);
      for (let j = 0; j < Math.min(total, 8); j++) {
        let progress = Math.max(
          0,
          Math.min(
            1,
            ((sim.time - pod.phaseStart) / (sim.p.dwell / 2)) * 1.4 -
              (j / Math.max(1, total)) * 0.4,
          ),
        );
        if (pod.state === "alighting") progress = 1 - progress;
        let ox = ((j % 2) - 0.5) * 0.45,
          oy = side * (0.8 + (1 - progress) * 2),
          q = screen([
            pod.point[0] + l.u[0] * ox + l.n[0] * oy,
            pod.point[1] + l.u[1] * ox + l.n[1] * oy,
          ]);
        ctx.fillStyle = "#b28b4d";
        ctx.beginPath();
        ctx.arc(...q, Math.max(1.4, 0.2 * scale), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // Passenger dots are a count-limited view of the actual queue; the label preserves the full total.
  let st = sim.stations[station.id],
    count = st.queue.reduce((a, g) => a + g.n, 0);
  for (let i = 0; i < Math.min(count, 32); i++) {
    let x = -h + 2 + (i % 12) * 1.3,
      y =
        platforms[Math.floor(i / 12) % platforms.length] +
        (Math.floor(i / 12) % 2 ? 0.3 : -0.25),
      p = screen(world(x, y));
    ctx.fillStyle = "#ba8c50";
    ctx.beginPath();
    ctx.arc(...p, Math.max(1.2, 0.22 * scale), 0, Math.PI * 2);
    ctx.fill();
  }
  if (labels && scale > 3) {
    let p = screen(world(0, l.type === "bypass" ? -10 : platforms[0] - 4.5));
    ctx.font = "600 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#385847";
    ctx.fillText(`${station.name} · ${count} waiting`, ...p);
    ctx.textAlign = "left";
  }
}
export function drawCrossing(
  ctx,
  screen,
  cross,
  sim,
  scale,
  { labels = true } = {},
) {
  let angle = cross.roadAngle,
    u = [Math.cos(angle), Math.sin(angle)],
    n = [-u[1], u[0]],
    world = (x, y) => [
      cross.point[0] + u[0] * x + n[0] * y,
      cross.point[1] + u[1] * x + n[1] * y,
    ];
  function line(pts, color, width) {
    path(
      ctx,
      screen,
      pts.map((p) => world(...p)),
      color,
      width,
    );
  }
  // Demonstration road corridor and sidewalks; drawn only in close views.
  line(
    [
      [-90, 0],
      [90, 0],
    ],
    "#f6f4eada",
    Math.max(8, 10 * scale),
  );
  line(
    [
      [-90, 0],
      [90, 0],
    ],
    "#c7ccc6d9",
    Math.max(6, 6.4 * scale),
  );
  ctx.setLineDash([4 * scale, 4 * scale]);
  line(
    [
      [-90, 0],
      [90, 0],
    ],
    "#faf7e5",
    Math.max(0.8, 0.12 * scale),
  );
  ctx.setLineDash([]);
  line(
    [
      [-10, -3.2],
      [-10, -0.2],
    ],
    "#fffef5",
    Math.max(1, 0.35 * scale),
  );
  line(
    [
      [10, 0.2],
      [10, 3.2],
    ],
    "#fffef5",
    Math.max(1, 0.35 * scale),
  );
  for (let x = -3; x <= 3; x += 1.3)
    line(
      [
        [x, 3.5],
        [x, 6.3],
      ],
      "#fefef5",
      Math.max(1, 0.65 * scale),
    );
  let ta = cross.trackAngle ?? angle + Math.PI / 2,
    tu = [Math.cos(ta), Math.sin(ta)],
    tn = [-tu[1], tu[0]];
  for (let side of [-1, 1]) {
    let cp = [
      cross.point[0] + tn[0] * side * 0.75,
      cross.point[1] + tn[1] * side * 0.75,
    ];
    path(
      ctx,
      screen,
      [
        [cp[0] - tu[0] * 10, cp[1] - tu[1] * 10],
        [cp[0] + tu[0] * 10, cp[1] + tu[1] * 10],
      ],
      "#647d59",
      Math.max(1, 0.16 * scale),
    );
  }
  for (let car of cross.cars) {
    if (Math.abs(car.pos) > 95) continue;
    let p = screen(world(car.pos * car.dir, -1.6 * car.dir));
    ctx.save();
    ctx.translate(...p);
    let f = screen(world((car.pos + 1) * car.dir, -1.6 * car.dir));
    ctx.rotate(Math.atan2(f[1] - p[1], f[0] - p[0]));
    ctx.fillStyle = ["#829cab", "#ba9e89", "#b4bd98"][car.id % 3];
    ctx.strokeStyle = "#566a70";
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.roundRect(
      -2.2 * scale,
      -0.9 * scale,
      4.4 * scale,
      1.8 * scale,
      Math.max(1, 0.35 * scale),
    );
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#dce7e6";
    ctx.fillRect(-0.8 * scale, -0.7 * scale, 1.3 * scale, 1.4 * scale);
    ctx.restore();
  }
  for (let person of cross.people) {
    let p = screen(world(person.pos * person.dir, 5));
    ctx.fillStyle = "#ae8a4f";
    ctx.beginPath();
    ctx.arc(...p, Math.max(1.6, 0.25 * scale), 0, Math.PI * 2);
    ctx.fill();
  }
  function signal(x, y, color, vertical = true) {
    let p = screen(world(x, y)),
      r = Math.max(2, Math.min(5, 0.32 * scale));
    ctx.fillStyle = "#243a32";
    ctx.beginPath();
    ctx.roundRect(p[0] - r * 1.5, p[1] - r * 4, r * 3, r * 8, r * 0.8);
    ctx.fill();
    for (let [i, name] of ["red", "amber", "green"].entries()) {
      ctx.beginPath();
      ctx.arc(p[0], p[1] + (i - 1) * r * 2.2, r, 0, Math.PI * 2);
      ctx.fillStyle =
        color === name
          ? { red: "#f06a56", amber: "#f4bf49", green: "#8fc877" }[name]
          : "#43524a";
      ctx.fill();
    }
  }
  signal(-10, -4, cross.roadSignal);
  signal(10, 4, cross.roadSignal);
  for (let x of [-4, 4]) {
    let q = screen(world(x, 6.8));
    ctx.fillStyle = "#31483b";
    ctx.fillRect(q[0] - 4, q[1] - 5, 8, 10);
    ctx.fillStyle = cross.pedestrianSignal === "walk" ? "#99c77c" : "#ee8065";
    ctx.beginPath();
    ctx.arc(q[0], q[1] - 1, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  let p = screen(world(0, -7));
  ctx.fillStyle = cross.podSignal === "green" ? "#70a954" : "#d5674f";
  ctx.beginPath();
  ctx.arc(...p, Math.max(3, scale * 0.5), 0, Math.PI * 2);
  ctx.fill();
  if (cross.intrusion) {
    let q = screen(cross.point);
    ctx.fillStyle = "#d46b4be0";
    ctx.font = "bold 20px sans-serif";
    ctx.fillText("⚠", q[0] - 9, q[1] + 6);
  }
  if (labels) {
    let q = screen(world(0, 12));
    ctx.font = "600 11px sans-serif";
    ctx.fillStyle = "#4a6252";
    ctx.textAlign = "center";
    ctx.fillText(`${cross.name} · ${PHASE_LABELS[cross.phase]}`, q[0], q[1]);
    ctx.font = "9px sans-serif";
    ctx.fillText(
      cross.confirmed
        ? "User-confirmed location"
        : "Illustrative location / road geometry",
      q[0],
      q[1] + 15,
    );
    ctx.textAlign = "left";
  }
}
export class DetailInspector {
  constructor(canvas, body, getSim) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.body = body;
    this.getSim = getSim;
    this.target = null;
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(canvas);
  }
  select(kind, id) {
    this.target = { kind, id };
    this.draw();
  }
  draw() {
    let sim = this.getSim();
    if (!this.target || !sim || !this.canvas.offsetWidth) return;
    let r = this.canvas.getBoundingClientRect(),
      d = devicePixelRatio || 1,
      w = r.width,
      h = r.height;
    this.canvas.width = w * d;
    this.canvas.height = h * d;
    let c = this.ctx;
    c.setTransform(d, 0, 0, d, 0, 0);
    c.fillStyle = "#f3f5ed";
    c.fillRect(0, 0, w, h);
    let item =
      this.target.kind === "station"
        ? sim.stations[this.target.id]
        : sim.crossings.find((x) => x.id === this.target.id);
    if (!item) return;
    let point = item.trackPoint || item.point,
      scale =
        this.target.kind === "station"
          ? Math.min((w - 60) / (sim.p.berths * 5 + 40), (h - 25) / 20)
          : Math.min((w - 40) / 90, (h - 25) / 32);
    let u =
        this.target.kind === "station"
          ? item.tangent
          : [Math.cos(item.roadAngle), Math.sin(item.roadAngle)],
      n = [-u[1], u[0]],
      screen = (p) => [
        w / 2 + ((p[0] - point[0]) * u[0] + (p[1] - point[1]) * u[1]) * scale,
        h / 2 - ((p[0] - point[0]) * n[0] + (p[1] - point[1]) * n[1]) * scale,
      ];
    if (this.target.kind === "station") {
      if (item.stationType === "bypass")
        for (let y of [-0.75, 0.75])
          path(
            c,
            screen,
            [item.layout.world(-80, y), item.layout.world(80, y)],
            "#a9b99d",
            Math.max(2, 1.2 * scale),
          );
      drawStationPlan(c, screen, item, sim, scale, { showIds: true });
      for (let pod of sim.pods.filter((p) =>
        ["moving", "departing"].includes(p.state),
      )) {
        let dx = pod.point[0] - point[0],
          dy = pod.point[1] - point[1];
        if (Math.hypot(dx, dy) < 80) {
          drawPod(c, screen, pod.point, pod.angle, scale, { empty: pod.empty });
        }
      }
    } else {
      drawCrossing(c, screen, item, sim, scale, { labels: false });
      let roadN = [Math.cos(item.trackAngle), Math.sin(item.trackAngle)],
        trackNormal = [-roadN[1], roadN[0]];
      for (let shift of [-0.75, 0.75]) {
        let center = [
          point[0] + trackNormal[0] * shift,
          point[1] + trackNormal[1] * shift,
        ];
        path(
          c,
          screen,
          [
            [center[0] - roadN[0] * 60, center[1] - roadN[1] * 60],
            [center[0] + roadN[0] * 60, center[1] + roadN[1] * 60],
          ],
          "#658558",
          Math.max(2, 0.3 * scale),
        );
      }
      for (let p of sim.pods.filter((p) =>
        ["moving", "departing"].includes(p.state),
      ))
        if (Math.hypot(p.point[0] - point[0], p.point[1] - point[1]) < 60) {
          drawPod(c, screen, p.point, p.angle, scale, { empty: p.empty });
        }
    }
  }
}
