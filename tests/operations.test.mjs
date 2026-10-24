import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildNetwork, Simulation } from "../src/engine.mjs";
import { CrossingController, seedCrossings } from "../src/operations.mjs";
const net = buildNetwork(
  JSON.parse(fs.readFileSync(new URL("../src/demo.geojson", import.meta.url))),
);
test("the fictional topology identifies three double bypass stops and five branch termini", () => {
  assert.equal(
    net.stations.filter((s) => s.stationType === "bypass").length,
    3,
  );
  assert.equal(
    net.stations.filter((s) => s.stationType === "terminus-single").length,
    5,
  );
});
test("demonstration crossing positions can be saved and reproduced", () => {
  let c = seedCrossings(net);
  assert.equal(c.length, 16);
  assert.ok(c.every((x) => x.confirmed === false));
  let a = new Simulation(net, {}, null, null, { crossings: c }),
    b = new Simulation(
      net,
      {},
      null,
      null,
      JSON.parse(JSON.stringify({ crossings: c })),
    );
  a.advance(120);
  b.advance(120);
  assert.deepEqual(a.stats(), b.stats());
  assert.deepEqual(
    a.crossings.map((c) => [c.phase, c.cars.length]),
    b.crossings.map((c) => [c.phase, c.cars.length]),
  );
});
test("a road vehicle already in the conflict area prevents a pod phase", () => {
  let c = new CrossingController({ id: "x" }, { roadDemand: 0, pedDemand: 0 });
  c.phase = "all-red";
  c.phaseStart = 0;
  c.cars = [{ id: 1, dir: 1, pos: 0, speed: 0, committed: true }];
  c.update(10, 0.25);
  assert.equal(c.phase, "all-red");
  assert.equal(c.grant(1), false);
  c.cars = [];
  c.update(10.25, 0.25);
  assert.equal(c.phase, "pod-green");
  assert.ok(c.grant(1));
  assert.equal(c.roadSignal, "red");
});
test("road green waits for the last reserved pod and intrusion holds both flows", () => {
  let c = new CrossingController({ id: "x" }, { roadDemand: 0, pedDemand: 0 });
  c.phase = "pod-green";
  assert.ok(c.grant(10));
  c.update(20, 0.25);
  assert.equal(c.phase, "pod-clearance");
  c.update(30, 0.25);
  assert.equal(c.phase, "pod-clearance");
  assert.equal(c.roadSignal, "red");
  c.release(10);
  c.update(30.25, 0.25);
  assert.equal(c.phase, "road-green");
  c.intrusion = true;
  c.update(31, 0.25);
  assert.equal(c.phase, "fault");
  assert.equal(c.roadSignal, "red");
  assert.equal(c.podSignal, "red");
  assert.equal(c.grant(12), false);
  c.intrusion = false;
  c.update(32, 0.25);
  assert.equal(c.phase, "all-red");
});
test("integrated crossings preserve passenger balance and never release cars with a reserved pod", () => {
  let s = new Simulation(net, { demand: 3000 }, null, null, {
    crossings: seedCrossings(net),
  });
  for (let i = 0; i < 7200; i++) {
    s.step(0.25);
    for (let c of s.crossings) {
      assert.ok(!(c.roadSignal === "green" && c.granted.size));
      assert.ok(!(c.granted.size && c.roadOccupied()));
    }
    if (i % 400 === 0) {
      let t = s.stats();
      assert.equal(t.generated, t.served + t.waiting + t.boarding + t.onboard);
    }
  }
  assert.ok(s.served > 100);
  assert.ok(s.crossings.some((c) => c.passedPods > 0));
  assert.ok(s.crossings.some((c) => c.passedCars > 0));
});
test("finite berth capacity retains excess fleet outside the operating network", () => {
  let s = new Simulation(net, { fleet: 50, berths: 4, demand: 0 });
  assert.equal(s.stats().reserve, 6);
  for (let st of s.stations) {
    assert.ok(st.slots.filter((x) => x !== null).length <= st.layout.capacity);
    assert.equal(
      new Set(st.slots.filter((x) => x !== null)).size,
      st.slots.filter((x) => x !== null).length,
    );
  }
});
test("door obstruction prevents departures and closing always precedes movement", () => {
  let s = new Simulation(net, { demand: 2000 });
  s.stations.forEach((st) => (st.doorObstruction = true));
  s.advance(180);
  assert.equal(s.trips, 0);
  assert.equal(s.emptyTrips, 0);
  assert.ok(s.pods.some((p) => p.state === "closing" && !p.doorsClosed));
  s.stations.forEach((st) => (st.doorObstruction = false));
  for (let i = 0; i < 1600; i++) {
    s.step(0.25);
    for (let p of s.pods)
      if (["moving", "departing", "reversing"].includes(p.state))
        assert.equal(p.doorsClosed, true);
  }
  assert.ok(s.trips > 0);
});
test("double-platform terminal arrivals unload before reversing into the departure queue", () => {
  let settings = net.stations.map((s, i) => ({
      weight: i === 0 ? 1 : 0,
      attraction: i === 3 ? 1 : 0,
      enabled: true,
      stationType: s.stationType === "bypass" ? "bypass" : "terminus-double",
    })),
    s = new Simulation(net, { demand: 500 }, settings);
  let arrivedIds = new Set(),
    reversedIds = new Set();
  for (let i = 0; i < 4800; i++) {
    s.step(0.25);
    for (let p of s.pods) {
      if (p.station === 3 && p.state === "alighting") arrivedIds.add(p.id);
      if (p.station === 3 && p.state === "reversing" && arrivedIds.has(p.id))
        reversedIds.add(p.id);
    }
  }
  assert.ok(arrivedIds.size > 0);
  assert.ok(reversedIds.size > 0);
});
