import { drawPod, drawStationPlan, drawCrossing } from "./detail.mjs";
export class NetworkMap {
  constructor(canvas, onSelect) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onSelect = onSelect;
    this.zoom = 1;
    this.pan = [0, 0];
    this.basemap = "clean";
    this.opacity = 0.68;
    this.images = new Map();
    this.tileErrors = new Set();
    this.selected = -1;
    this.addMode = false;
    this.resize = new ResizeObserver(() => {
      this.size();
      this.draw();
    });
    this.resize.observe(canvas);
    let down = null;
    canvas.addEventListener("pointerdown", (e) => {
      down = { x: e.clientX, y: e.clientY, pan: [...this.pan] };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (down) {
        this.pan = [
          down.pan[0] + e.clientX - down.x,
          down.pan[1] + e.clientY - down.y,
        ];
        this.draw();
      }
    });
    canvas.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
        let rect = canvas.getBoundingClientRect(),
          p = [e.clientX - rect.left, e.clientY - rect.top];
        if (this.addMode) this.onAdd?.(this.world(p));
        else {
          let hit = this.net?.stations.find((s) => {
            let q = this.screen(s.trackPoint);
            return Math.hypot(p[0] - q[0], p[1] - q[1]) < 22;
          });
          let crossing =
            !hit &&
            this.sim?.crossings.find((c) => {
              let q = this.screen(c.point);
              return Math.hypot(p[0] - q[0], p[1] - q[1]) < 18;
            });
          this.selected = hit?.id ?? -1;
          if (crossing) this.onCrossing?.(crossing.id);
          else this.onSelect?.(hit?.id ?? -1, p);
        }
      }
      down = null;
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        let rect = canvas.getBoundingClientRect(),
          pos = [e.clientX - rect.left, e.clientY - rect.top],
          before = this.world(pos);
        this.zoom = Math.max(
          0.3,
          Math.min(250, this.zoom * Math.exp(-e.deltaY * 0.0015)),
        );
        let after = this.screen(before);
        this.pan[0] += pos[0] - after[0];
        this.pan[1] += pos[1] - after[1];
        this.draw();
      },
      { passive: false },
    );
  }
  size() {
    let r = this.canvas.getBoundingClientRect();
    this.w = r.width;
    this.h = r.height;
    let d = window.devicePixelRatio || 1;
    this.canvas.width = this.w * d;
    this.canvas.height = this.h * d;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  focusPoint(p, desiredScale = 8) {
    let base = this.scale() / this.zoom;
    this.zoom = Math.max(0.3, Math.min(250, desiredScale / base));
    let b = this.net.bounds;
    this.pan = [
      -(p[0] - (b[0] + b[2]) / 2) * this.scale(),
      (p[1] - (b[1] + b[3]) / 2) * this.scale(),
    ];
    this.draw();
  }
  setNetwork(net) {
    this.net = net;
    this.fit();
  }
  fit() {
    this.zoom = 1;
    this.pan = [0, 0];
    this.draw();
  }
  scale() {
    if (!this.net) return 1;
    let b = this.net.bounds;
    return (
      Math.min(
        (this.w - (this.w < 500 ? 65 : 190)) / Math.max(1, b[2] - b[0]),
        (this.h - 135) / Math.max(1, b[3] - b[1]),
      ) * this.zoom
    );
  }
  screen(p) {
    let b = this.net.bounds,
      s = this.scale();
    return [
      this.w / 2 + (p[0] - (b[0] + b[2]) / 2) * s + this.pan[0],
      this.h / 2 - (p[1] - (b[1] + b[3]) / 2) * s + this.pan[1],
    ];
  }
  world(p) {
    let b = this.net.bounds,
      s = this.scale();
    return [
      (p[0] - this.w / 2 - this.pan[0]) / s + (b[0] + b[2]) / 2,
      -(p[1] - this.h / 2 - this.pan[1]) / s + (b[1] + b[3]) / 2,
    ];
  }
  setBasemap(name) {
    this.basemap = ["clean", "satellite", "network"].includes(name)
      ? name
      : "clean";
    this.draw();
  }
  drawTiles() {
    let net = this.net,
      ctx = this.ctx,
      tl = net.unproject(this.world([0, 0])),
      br = net.unproject(this.world([this.w, this.h]));
    let meterPx = 1 / this.scale();
    let z = Math.max(
      3,
      Math.min(
        19,
        Math.round(
          Math.log2(
            (156543.03392 * Math.cos((net.origin[1] * Math.PI) / 180)) /
              meterPx,
          ),
        ),
      ),
    );
    let n = 2 ** z;
    let tile = (p) => [
      ((p[0] + 180) / 360) * n,
      ((1 -
        Math.asinh(
          Math.tan((Math.max(-85, Math.min(85, p[1])) * Math.PI) / 180),
        ) /
          Math.PI) /
        2) *
        n,
    ];
    let a = tile(tl),
      b = tile(br),
      count = 0,
      loaded = 0,
      failed = 0;
    for (let x = Math.floor(a[0]); x <= Math.floor(b[0]); x++)
      for (let y = Math.floor(a[1]); y <= Math.floor(b[1]); y++) {
        if (y < 0 || y >= n || ++count > 100) continue;
        let tx = ((x % n) + n) % n,
          key = `${this.basemap}/${z}/${tx}/${y}`,
          img = this.images.get(key);
        if (!img) {
          img = new Image();
          img.onload = () => {
            this.tileErrors.delete(key);
            this.draw();
          };
          img.onerror = () => {
            this.tileErrors.add(key);
            this.draw();
          };
          img.src =
            this.basemap === "satellite"
              ? `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${tx}`
              : `https://tile.openstreetmap.org/${z}/${tx}/${y}.png`;
          this.images.set(key, img);
          if (this.images.size > 350)
            this.images.delete(this.images.keys().next().value);
        }
        if (this.tileErrors.has(key)) failed++;
        if (img.complete && img.naturalWidth) {
          loaded++;
          let coord = (x, y) => [
            (x / n) * 360 - 180,
            (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
          ];
          let p = this.screen(net.project(coord(x, y))),
            q = this.screen(net.project(coord(x + 1, y + 1)));
          ctx.save();
          ctx.globalAlpha = this.opacity;
          ctx.filter =
            this.basemap === "clean"
              ? "grayscale(85%) saturate(45%) brightness(1.04)"
              : "saturate(65%)";
          let dpr = window.devicePixelRatio || 1,
            left = Math.round(p[0] * dpr) / dpr,
            top = Math.round(p[1] * dpr) / dpr;
          ctx.drawImage(
            img,
            left,
            top,
            Math.round(q[0] * dpr) / dpr - left,
            Math.round(q[1] * dpr) / dpr - top,
          );
          ctx.restore();
        }
      }
    this.tileState =
      failed && !loaded
        ? "unavailable"
        : loaded === count
          ? "ready"
          : failed
            ? "partial"
            : "loading";
  }
  draw() {
    let c = this.ctx,
      w = this.w,
      h = this.h;
    if (!w || !this.net) return;
    c.clearRect(0, 0, w, h);
    c.fillStyle = this.basemap === "network" ? "#edf0e7" : "#f2f2eb";
    c.fillRect(0, 0, w, h);
    if (this.basemap !== "network") this.drawTiles();
    else {
      c.strokeStyle = "#e3e8dc";
      c.lineWidth = 1;
      let grid = 100 * this.scale();
      while (grid < 35) grid *= 2;
      while (grid > 160) grid /= 2;
      let o = this.screen([0, 0]);
      for (let x = o[0] % grid; x < w; x += grid) {
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, h);
        c.stroke();
      }
      for (let y = o[1] % grid; y < h; y += grid) {
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(w, y);
        c.stroke();
      }
      c.fillStyle = "#9cab9110";
      c.font = "600 95px sans-serif";
      c.fillText("N E T W O R K", w * 0.12, h * 0.58);
    }
    let scale = this.scale(),
      detailed = scale >= 1.5;
    c.lineJoin = "round";
    c.lineCap = "round";
    for (let l of this.net.lines) {
      let draw = (points, color, width) => {
        c.beginPath();
        points
          .map((p) => this.screen(p))
          .forEach((p, i) => (i ? c.lineTo(...p) : c.moveTo(...p)));
        c.strokeStyle = color;
        c.lineWidth = width;
        c.stroke();
      };
      if (!detailed) {
        draw(l.points, "#ffffff", 11);
        draw(l.points, "#b9c8ac", 7);
        draw(l.points, "#64825a", 2);
      } else {
        draw(l.points, "#dce4d1c9", 3 * scale);
        for (let side of [-1, 1]) {
          let points = l.points.map((p, i) => {
            let a = l.points[Math.max(0, i - 1)],
              b = l.points[Math.min(l.points.length - 1, i + 1)],
              len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
            return [
              p[0] - ((b[1] - a[1]) / len) * 0.75 * side,
              p[1] + ((b[0] - a[0]) / len) * 0.75 * side,
            ];
          });
          draw(points, "#f7f7e8", 0.6 * scale);
          draw(points, "#647b5c", Math.max(0.8, 0.12 * scale));
        }
      }
    }
    for (let e of this.net.edges.filter((e) => e.li === -1)) {
      let a = this.screen(e.a),
        b = this.screen(e.b);
      c.beginPath();
      c.moveTo(...a);
      c.lineTo(...b);
      c.strokeStyle = "#b3a16e";
      c.lineWidth = 2;
      c.setLineDash([3, 3]);
      c.stroke();
      c.setLineDash([]);
    }
    if (this.sim) {
      for (let cross of this.sim.crossings) {
        let p = this.screen(cross.point);
        if (p[0] < -300 || p[0] > w + 300 || p[1] < -300 || p[1] > h + 300)
          continue;
        if (detailed)
          drawCrossing(c, (p) => this.screen(p), cross, this.sim, scale, {
            labels: p[0] > 180 && p[0] < w - 180 && p[1] > 90 && p[1] < h - 90,
          });
        else {
          c.fillStyle = "#fffef4";
          c.strokeStyle = "#87987e";
          c.lineWidth = 1;
          c.beginPath();
          c.roundRect(p[0] - 5, p[1] - 7, 10, 14, 3);
          c.fill();
          c.stroke();
          c.fillStyle =
            cross.roadSignal === "green"
              ? "#79a45e"
              : cross.roadSignal === "amber"
                ? "#d5aa4b"
                : "#d36e58";
          c.beginPath();
          c.arc(p[0], p[1] - 1, 2.7, 0, Math.PI * 2);
          c.fill();
        }
      }
      if (detailed)
        for (let st of this.sim.stations) {
          let p = this.screen(st.trackPoint);
          if (p[0] > -200 && p[0] < w + 200 && p[1] > -200 && p[1] < h + 200)
            drawStationPlan(c, (p) => this.screen(p), st, this.sim, scale);
        }
      for (let p of this.sim.pods) {
        if (!["moving", "departing"].includes(p.state)) continue;
        drawPod(
          c,
          (p) => this.screen(p),
          p.point,
          p.angle,
          detailed ? scale : 2.2,
          {
            empty: p.empty,
            id: null,
            capacity: this.sim.p.capacity,
            load: p.load.reduce((a, g) => a + g.n, 0),
          },
        );
      }
    }
    const labels = [];
    let mid = [
      (this.net.bounds[0] + this.net.bounds[2]) / 2,
      (this.net.bounds[1] + this.net.bounds[3]) / 2,
    ];
    for (let s of this.net.stations) {
      if (detailed) continue;
      let p = this.screen(s.trackPoint),
        q = this.sim?.stations[s.id]?.queue.reduce((a, g) => a + g.n, 0) || 0,
        selected = s.id === this.selected;
      c.beginPath();
      c.arc(...p, selected ? 12 : 9, 0, Math.PI * 2);
      c.fillStyle = selected ? "#d9e89b66" : "#fffefaaa";
      c.fill();
      c.beginPath();
      c.arc(...p, 4.5, 0, Math.PI * 2);
      c.fillStyle = q > 15 ? "#d8a344" : "#fffef9";
      c.fill();
      c.strokeStyle = "#4e7847";
      c.lineWidth = 2;
      c.stroke();
      c.font = '550 10px "DM Sans", sans-serif';
      let text = s.name,
        tw = c.measureText(text).width + 14,
        side = s.trackPoint[0] > mid[0] ? 1 : -1,
        tx = side > 0 ? p[0] + 15 : p[0] - tw - 15;
      tx = Math.max(8, Math.min(w - tw - 8, tx));
      let ty = p[1] - 11;
      for (
        let k = 0;
        k < 12 &&
        labels.some(
          (r) =>
            tx < r.x + r.w && tx + tw > r.x && ty < r.y + 23 && ty + 23 > r.y,
        );
        k++
      )
        ty += 25;
      ty = Math.max(53, Math.min(h - 55, ty));
      labels.push({ x: tx, y: ty, w: tw });
      c.fillStyle = "#fffef6e8";
      c.strokeStyle = "#d9e1d0";
      c.lineWidth = 0.7;
      c.beginPath();
      c.roundRect(tx, ty, tw, 22, 4);
      c.fill();
      c.stroke();
      c.fillStyle = "#526c45";
      c.fillText(text, tx + 7, ty + 14);
      if (q > 0) {
        c.fillStyle = q > 15 ? "#d6a140" : "#749953";
        c.beginPath();
        c.arc(p[0] + 9, p[1] - 8, 7, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = "white";
        c.font = "bold 7px sans-serif";
        c.textAlign = "center";
        c.fillText(q > 99 ? "99+" : String(q), p[0] + 9, p[1] - 5.5);
        c.textAlign = "left";
      }
    }
    let meters = 65 / this.scale(),
      rounded =
        meters >= 1000
          ? `${(meters / 1000).toFixed(1)} km`
          : `${Math.round(meters / 10) * 10} m`;
    document.getElementById("mapScale").textContent = rounded;
    let level = document.getElementById("detailLevel");
    if (level)
      level.textContent = detailed
        ? "Site detail · illustrative layouts"
        : "Network view · zoom in for operating detail";
    if (this.basemap !== "network" && this.tileState !== "ready") {
      let msg =
        this.tileState === "unavailable"
          ? "Basemap unavailable · choose Network for offline use"
          : this.tileState === "partial"
            ? "Some map tiles unavailable · route remains visible"
            : "Loading basemap…";
      c.fillStyle = "#fffef8ef";
      c.fillRect(10, 57, Math.min(w - 55, 310), 22);
      c.fillStyle = "#7c806b";
      c.font = "10px sans-serif";
      c.fillText(msg, 18, 72);
    }
  }
}
