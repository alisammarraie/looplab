import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildNetwork, Simulation } from "../src/engine.mjs";
const data = JSON.parse(
    fs.readFileSync(new URL("../src/demo.geojson", import.meta.url)),
  ),
  net = buildNetwork(data);
test("fictional demo geometry forms eight connected stops and five branches", () => {
  assert.equal(net.stations.length, 8);
  assert.equal(net.lines.length, 6);
  assert.ok(net.length > 5900 && net.length < 6200);
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++) {
      assert.ok(net.routes[i][j]);
      assert.ok(
        Math.abs(net.routes[i][j].length - net.routes[j][i].length) < 0.01,
      );
    }
  assert.ok(net.routes[3][6].steps.some((s) => s.edge.li === 1));
  assert.ok(net.routes[3][6].steps.some((s) => s.edge.li === 4));
});
function balance(s) {
  let t = s.stats();
  assert.equal(t.generated, t.served + t.waiting + t.boarding + t.onboard);
  for (let p of s.pods) {
    assert.ok(p.load.reduce((a, g) => a + g.n, 0) <= s.p.capacity);
    assert.ok(Number.isFinite(p.point[0]));
  }
}
test("zero demand produces no journeys or passengers", () => {
  let s = new Simulation(net, { demand: 0 });
  s.advance(3600);
  balance(s);
  assert.equal(s.served, 0);
  assert.equal(s.trips, 0);
  assert.equal(s.generated, 0); /* Empty redistribution can still occur. */
});
test("all passenger states conserve people under ordinary and overloaded demand", () => {
  for (let demand of [1500, 15000]) {
    let s = new Simulation(net, { demand, capacity: 8 });
    for (let i = 0; i < 8; i++) {
      s.advance(450);
      balance(s);
    }
    assert.ok(s.served > 0);
    if (demand === 15000) assert.ok(s.queueCount() > 5000);
  }
});
test("seeded runs reproduce results independent of playback chunk size", () => {
  let a = new Simulation(net, { seed: 123 }),
    b = new Simulation(net, { seed: 123 });
  a.advance(900);
  for (let i = 0; i < 900; i++) b.advance(1);
  assert.deepEqual(a.stats(), b.stats());
});
test("shared pods combine same-destination requests and private pods retain group size", () => {
  let shared = new Simulation(net, { demand: 6000 }),
    privateRun = new Simulation(net, { demand: 6000, mode: "private" });
  shared.advance(3600);
  privateRun.advance(3600);
  assert.equal(privateRun.stats().load, 1);
  assert.ok(shared.stats().load > 3);
  assert.ok(shared.served > privateRun.served);
  balance(shared);
  balance(privateRun);
});
test("larger fleets relieve overloaded private-service queues", () => {
  let a = new Simulation(net, { fleet: 10, mode: "private", demand: 3000 }),
    b = new Simulation(net, { fleet: 70, mode: "private", demand: 3000 });
  a.advance(1800);
  b.advance(1800);
  assert.ok(b.served > a.served);
  assert.ok(b.queueCount() < a.queueCount());
});
test("disconnected stops and invalid coordinates fail with actionable errors", () => {
  let d = structuredClone(data);
  d.features.push({
    type: "Feature",
    properties: { name: "Remote" },
    geometry: { type: "Point", coordinates: [54.5, 24.5] },
  });
  assert.throws(() => buildNetwork(d), /Remote/);
  d.features[0].geometry.coordinates[0] = [999, 0];
  assert.throws(() => buildNetwork(d), /WGS84/);
});
test("arrival and destination weights route passengers only to eligible stations", () => {
  let settings = net.stations.map((s, i) => ({
    weight: i === 0 ? 1 : 0,
    attraction: i === 1 ? 1 : 0,
    enabled: true,
  }));
  let s = new Simulation(net, { demand: 600 }, settings);
  s.advance(1800);
  balance(s);
  assert.ok(s.served > 0);
  assert.equal(
    s.stations.filter((_, i) => i !== 1).reduce((a, x) => a + x.served, 0),
    0,
  );
  assert.ok(s.emptyTrips > 0);
});
