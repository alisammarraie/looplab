import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildNetwork, Simulation } from "../src/engine.mjs";
import {
  seedCrossings,
  servicePose,
  CrossingController,
} from "../src/operations.mjs";
const net = buildNetwork(
  JSON.parse(fs.readFileSync(new URL("../src/demo.geojson", import.meta.url))),
);
const square = buildNetwork({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Loop" },
      geometry: {
        type: "LineString",
        coordinates: [
          [54, 24],
          [54.01, 24],
          [54.01, 24.01],
          [54, 24.01],
          [54, 24],
        ],
      },
    },
    ...[0, 0.01].map((x, i) => ({
      type: "Feature",
      properties: { name: `S${i}` },
      geometry: { type: "Point", coordinates: [54 + x, 24] },
    })),
  ],
});
function balance(s) {
  let t = s.stats();
  assert.equal(t.generated, t.served + t.waiting + t.boarding + t.onboard);
}
test("a four-pod platform departs in FIFO order and followers advance physically", () => {
  let s = new Simulation(square, {
      fleet: 8,
      berths: 4,
      capacity: 1,
      demand: 0,
      reposition: true,
      dwell: 2,
      hold: 0,
    }),
    st = s.stations[0],
    order = [...st.platforms[0].queue];
  st.queue = Array.from({ length: 4 }, () => ({ n: 1, dest: 1, arrived: 0 }));
  s.generated = 4;
  let movedFollower = false;
  for (let i = 0; i < 600; i++) {
    let prev = s.pods[order[1]].point;
    s.step(0.25);
    if (Math.hypot(...s.pods[order[1]].point.map((v, j) => v - prev[j])) > 0)
      movedFollower = true;
    for (let p of s.pods)
      assert.ok(!["advancing", "departing"].includes(p.state) || p.doorsClosed);
  }
  assert.deepEqual(
    s.departureLog.filter((x) => x.station === 0).map((x) => x.id),
    order,
  );
  assert.ok(movedFollower);
  balance(s);
});
test("the first eligible pod receives a crossing grant, even when its ID is higher", () => {
  let s = new Simulation(square, { fleet: 2, demand: 0, reposition: false });
  let c = new CrossingController(
    { id: "test" },
    { roadDemand: 0, pedDemand: 0 },
  );
  c.phase = "pod-green";
  s.pods.forEach((p, i) => {
    p.path = {};
    p.pathS = 0;
    p.crossingMarks = [{ c, s: i ? 10 : 15 }];
  });
  assert.equal(s.firstAt(s.pods[0], "crossing", "test", 15), false);
  assert.equal(s.firstAt(s.pods[1], "crossing", "test", 10), true);
});
test("reposition routes can target either directional platform without reversing on the running track", () => {
  let s = new Simulation(net, { demand: 0 });
  for (let lane of [0, 1]) {
    let r = s.getRoute(3, 0, 0, lane);
    assert.ok(r);
    let last = r.steps.at(-1),
      st = s.stations[0],
      dir =
        (last.b[0] - last.a[0]) * st.tangent[0] +
        (last.b[1] - last.a[1]) * st.tangent[1];
    assert.equal(dir > 0, lane === 0);
    for (let i = 1; i < r.steps.length; i++)
      assert.notEqual(r.steps[i].edge.id, r.steps[i - 1].edge.id);
  }
});
test("fractional playback advances retain time rather than dropping partial steps", () => {
  let a = new Simulation(net, { demand: 0 }),
    b = new Simulation(net, { demand: 0 });
  for (let i = 0; i < 100; i++) a.advance(0.1);
  b.advance(10);
  assert.equal(a.time, b.time);
  assert.deepEqual(a.stats(), b.stats());
});
test("concentrated high demand is not limited to one arrival per time step", () => {
  let settings = net.stations.map((s, i) => ({
      weight: i === 0 ? 1 : 0,
      attraction: 1,
      enabled: true,
    })),
    s = new Simulation(
      net,
      { demand: 36000, fleet: 1, reposition: false },
      settings,
    );
  s.advance(3600);
  assert.ok(
    s.generated > 34000 && s.generated < 38000,
    `${s.generated} arrivals`,
  );
  balance(s);
});
test("synthetic junctions and stop markers lie on the guideway", () => {
  assert.ok(net.stations.every((s) => s.snapDistance < 0.01));
  assert.ok(
    net.edges.every((e) => e.li >= 0),
    "no tiny connector edges remain",
  );
});
test("one hour with 16 road crossings has continuous positions, closed moving doors and conserved passengers", () => {
  let s = new Simulation(net, { demand: 4500 }, null, null, {
      crossings: seedCrossings(net),
    }),
    old = s.pods.map((p) => [...p.point]);
  let servedAtHalf = 0;
  for (let i = 0; i < 14400; i++) {
    s.step(0.25);
    for (let p of s.pods) {
      let d = Math.hypot(p.point[0] - old[p.id][0], p.point[1] - old[p.id][1]);
      assert.ok(
        d <= (s.p.speed / 3.6) * 0.25 + 0.001,
        `jump: pod ${p.id}, ${d} m, ${p.state}`,
      );
      assert.deepEqual(
        servicePose(s.stations[p.station], p, s.p.berths, s.time).point,
        p.point,
      );
      if (p.path || p.state === "advancing") assert.equal(p.doorsClosed, true);
      old[p.id] = [...p.point];
    }
    for (let c of s.crossings)
      assert.ok(
        !(c.granted.size && (c.roadSignal === "green" || c.roadOccupied())),
      );
    if (i % 400 === 0) balance(s);
    if (i === 7199) servedAtHalf = s.served;
  }
  balance(s);
  assert.ok(
    s.served > servedAtHalf + 100,
    "service must continue in the second half hour",
  );
});

test("fifty default pods fit in fifty-five demonstration berths", () => {
  let s = new Simulation(net, { demand: 0 });
  assert.equal(s.stats().reserve, 0);
  assert.equal(
    s.stations.reduce((n, st) => n + st.layout.capacity, 0),
    55,
  );
});
test("single-platform termini reverse before unloading at their shared platform", () => {
  let settings = net.stations.map((s, i) => ({
      weight: i === 0 ? 1 : 0,
      attraction: i === 3 ? 1 : 0,
      enabled: true,
    })),
    s = new Simulation(net, { demand: 500 }, settings),
    reversed = new Set();
  let observed = false;
  for (let i = 0; i < 7200; i++) {
    s.step(0.25);
    for (let p of s.pods) {
      if (p.station === 3 && p.state === "reversing" && p.load.length)
        reversed.add(p.id);
      if (p.station === 3 && p.state === "alighting") {
        assert.ok(reversed.has(p.id));
        assert.equal(p.atDeparturePlatform, true);
        assert.ok(s.stations[3].platforms[0].queue.includes(p.id));
        observed = true;
      }
    }
    balance(s);
  }
  assert.ok(observed);
});
test("berth bookings never overfill a platform and boarding waits for the queue front", () => {
  let s = new Simulation(net, { demand: 4500 }, null, null, {
    crossings: seedCrossings(net),
  });
  for (let i = 0; i < 14400; i++) {
    s.step(0.25);
    for (let st of s.stations)
      for (let pl of st.platforms) {
        assert.ok(
          pl.queue.length + s.incomingBookings(st.id, pl.lane) <= s.p.berths,
        );
        for (let id of pl.queue) {
          let p = s.pods[id];
          if (["boarding", "closing", "ready"].includes(p.state)) {
            assert.equal(pl.queue[0], id);
            assert.ok(
              Math.abs(p.serviceS - pl.front) < 0.01,
              `pod ${id}: ${p.state}, ${p.serviceS} / ${pl.front}`,
            );
          }
        }
      }
  }
});
