import { DEFAULTS, buildNetwork, Simulation } from "./engine.mjs";
import { readMap } from "./import.mjs";
import { NetworkMap } from "./map.mjs";
import {
  DEFAULT_OPERATIONS,
  PHASE_LABELS,
  SERVICE_LABELS,
  seedCrossings,
  locateCrossings,
} from "./operations.mjs";
import { DetailInspector } from "./detail.mjs";
const $ = (id) => document.getElementById(id),
  esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    ),
  fmt = (n) => Math.round(n).toLocaleString(),
  time = (s) => {
    s = Math.floor(s);
    return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  },
  duration = (s) =>
    s < 60 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`;
let network,
  sim,
  geojson,
  params = { ...DEFAULTS },
  settings = null,
  od = null,
  playing = false,
  accumulator = 0,
  last = 0,
  lastUI = 0,
  mapName = "Demo Loop",
  projectName = "Fictional demonstration network",
  snap = 30,
  stationSnap = 100,
  snapshots = [],
  adding = false,
  busy = false,
  operations = { ...DEFAULT_OPERATIONS, crossings: [] },
  inspected = null;
let map = new NetworkMap($("map"), selectStation);
const paramKeys = Object.keys(DEFAULTS);
let inspector = new DetailInspector(
  $("detailCanvas"),
  $("inspectorStatus"),
  () => sim,
);
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").hidden = true), 5500);
}
function modal(title, html, eyebrow = "SIMULATION LAB") {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = html;
  $("modalEyebrow").textContent = eyebrow;
  $("modal").showModal();
}
$("closeModal").onclick = () => $("modal").close();
$("modal").addEventListener("click", (e) => {
  if (e.target === $("modal")) {
    let r = $("modal").getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      $("modal").close();
  }
});
function values() {
  let p = {};
  for (let k of paramKeys) {
    if (k === "reposition") p[k] = $(k).checked;
    else if (k === "mode") p[k] = $(k).value;
    else {
      let el = $(k);
      if (!el.checkValidity())
        throw Error(`Check “${el.closest("label")?.textContent.trim() || k}”.`);
      p[k] = Number(el.value);
      if (!Number.isFinite(p[k])) throw Error(`Enter a valid ${k}.`);
    }
  }
  for (let k of ["fleet", "capacity", "groupSize", "berths", "seed"])
    if (!Number.isInteger(p[k])) throw Error(`${k} must be a whole number.`);
  if (p.groupSize > p.capacity)
    throw Error("Group size cannot exceed pod capacity.");
  return p;
}
function fillParams(p) {
  for (let k of paramKeys) {
    if (k === "reposition") $(k).checked = p[k];
    else $(k).value = p[k];
  }
}
function validateParams(p) {
  let old = {};
  for (let k of paramKeys)
    old[k] = k === "reposition" ? $(k).checked : $(k).value;
  try {
    fillParams(p);
    return values();
  } finally {
    fillParams(old);
  }
}
function stop() {
  playing = false;
  $("playBtn").textContent = "▶";
  $("playBtn").setAttribute("aria-label", "Start simulation");
}
function reset(start = false) {
  stop();
  accumulator = 0;
  sim = new Simulation(network, params, settings, od, operations);
  map.sim = sim;
  settings = sim.stations.map((s) => ({
    name: s.name,
    weight: s.weight,
    attraction: s.attraction,
    enabled: s.enabled,
    stationType: s.stationType,
  }));
  network.stations.forEach((s, i) => (s.name = settings[i].name));
  refreshFocusOptions();
  update();
  map.draw();
  if (start) togglePlay();
}
function loadNetwork(data, name, config = {}) {
  let next = buildNetwork(data, {
      snap: config.snap ?? snap,
      stationSnap: config.stationSnap ?? stationSnap,
    }),
    nextOperations = {
      ...DEFAULT_OPERATIONS,
      ...config.operations,
      crossings:
        config.operations?.crossings ??
        (next.lines.some((l) => l.name === "Demo Loop")
          ? seedCrossings(next, 16)
          : []),
    },
    nextParams = validateParams({ ...DEFAULTS, ...(config.params || params) });
  validateSettings(config, next, nextParams);
  nextOperations = validateOperations(nextOperations, next);
  if (next.stations.length === 1)
    toast("Add a second stop with the map editor to start a simulation.");
  network = next;
  geojson = data;
  mapName = name;
  projectName = config.projectName || name;
  snap = next.snap;
  stationSnap = next.stationSnap;
  settings = config.settings || null;
  od = config.od || null;
  operations = nextOperations;
  params = nextParams;
  fillParams(params);
  $("projectName").textContent = projectName;
  $("mapTitle").textContent = projectName;
  $("networkName").textContent = mapName;
  $("networkMeta").textContent =
    `${next.lines.length} track lines · WGS84 geometry`;
  $("lengthInfo").textContent = (next.length / 1000).toFixed(2);
  $("stopsInfo").textContent = next.stations.length;
  $("stationSummary").textContent =
    `${next.stations.length} stops · live queues`;
  map.size();
  map.setNetwork(next);
  if (config.view) setBasemap(config.view.basemap, config.view.opacity);
  reset();
}
function apply() {
  try {
    if (network.stations.length < 2)
      throw Error("Add at least two stops before running.");
    params = values();
    reset(true);
    $("pendingLabel").textContent = "Running with the parameters shown.";
  } catch (e) {
    toast(e.message);
  }
}
$("applyBtn").onclick = apply;
$("resetBtn").onclick = () => {
  reset();
  toast("Run reset with the same seed and applied parameters.");
};
function togglePlay() {
  if (network.stations.length < 2) {
    toast("Add at least two connected stops first.");
    return;
  }
  if (playing) stop();
  else {
    playing = true;
    last = performance.now();
    $("playBtn").textContent = "Ⅱ";
    $("playBtn").setAttribute("aria-label", "Pause simulation");
  }
}
$("playBtn").onclick = togglePlay;
async function advance() {
  if (busy) return;
  if (network.stations.length < 2) {
    toast("Add at least two connected stops first.");
    return;
  }
  busy = true;
  stop();
  $("advanceBtn").disabled = true;
  $("advanceBtn").textContent = "Calculating…";
  let active = sim,
    target = sim.time + 900;
  try {
    while (sim === active && sim.time < target) {
      sim.advance(Math.min(30, target - sim.time));
      update();
      map.draw();
      await new Promise(requestAnimationFrame);
    }
  } finally {
    busy = false;
    $("advanceBtn").disabled = false;
    $("advanceBtn").textContent = "Advance 15 min ↗";
    update();
  }
}
$("advanceBtn").onclick = advance;
function update() {
  if (!sim) return;
  let s = sim.stats();
  $("servedMetric").textContent = fmt(s.served);
  $("throughputMetric").textContent =
    `${fmt(s.throughput)} pax/h · since start`;
  $("waitMetric").textContent = sim.waits.length ? duration(s.meanWait) : "—";
  $("p95Metric").textContent =
    `95th percentile · ${sim.waits.length ? duration(s.p95Wait) : "—"}`;
  $("queueMetric").textContent = fmt(s.waiting);
  $("generatedMetric").textContent = `${fmt(s.generated)} passengers generated`;
  $("loadMetric").textContent = s.trips
    ? `${s.load.toFixed(1)} / ${params.capacity}`
    : "—";
  $("movingMetric").textContent =
    `${s.moving} moving${s.reserve ? ` · ${s.reserve} reserve` : ""} / ${params.fleet} pods`;
  $("clock").textContent = time(sim.time);
  $("runState").textContent = busy
    ? "Advancing simulation"
    : playing
      ? "Simulation running"
      : sim.time
        ? "Simulation paused"
        : "Ready to simulate";
  $("utilizationMetric").textContent =
    `${Math.round((s.moving / params.fleet) * 100)}%`;
  $("utilBar").style.width = `${(s.moving / params.fleet) * 100}%`;
  $("tripSummary").textContent =
    `${fmt(s.trips)} passenger trips · ${fmt(s.emptyTrips)} empty trips`;
  $("stationRows").innerHTML = sim.stations
    .map((st) => {
      let queue = st.queue.reduce((a, g) => a + g.n, 0),
        here = sim.pods.filter(
          (p) =>
            !["moving", "reserve"].includes(p.state) && p.station === st.id,
        ).length,
        inbound = sim.pods.filter(
          (p) => p.state === "moving" && p.dest === st.id,
        ).length;
      return `<tr class="station-row" data-station="${st.id}" tabindex="0"><td><span class="stop-dot"></span>${esc(st.name)}${!st.enabled ? " (inactive)" : ""}</td><td><span class="queue-pill ${queue > 20 ? "busy" : ""}">${queue}</span></td><td>${here}</td><td>${inbound}</td><td>${fmt(st.served)}</td></tr>`;
    })
    .join("");
  $("stationRows")
    .querySelectorAll("tr")
    .forEach((r) => {
      r.onclick = () => selectStation(Number(r.dataset.station));
      r.onkeydown = (e) => {
        if (e.key === "Enter") r.click();
      };
    });
  $("activityLog").innerHTML =
    sim.log
      .slice(0, 10)
      .map(
        (l) =>
          `<div class="activity-item"><time>${time(l.t).slice(3)}</time><span>${esc(l.text)}</span></div>`,
      )
      .join("") ||
    '<p class="empty-message">Start a run to follow pod journeys.</p>';
  renderInspector();
}
function frame(now) {
  if (playing && !busy && sim) {
    let dt = Math.min(0.25, (now - last) / 1000);
    accumulator += dt * Number($("playSpeed").value);
    let n = Math.min(1200, Math.floor(accumulator / 0.25));
    for (let i = 0; i < n; i++) sim.step(0.25);
    accumulator -= n * 0.25;
    map.draw();
    inspector.draw();
  }
  if (now - lastUI > 250) {
    update();
    lastUI = now;
  }
  last = now;
  requestAnimationFrame(frame);
}
$("advancedBtn").onclick = () => {
  $("advancedFields").hidden = !$("advancedFields").hidden;
  $("advancedBtn").querySelector("span").textContent = $("advancedFields")
    .hidden
    ? "＋"
    : "−";
};
for (let k of paramKeys)
  $(k).addEventListener("change", () => {
    $("pendingLabel").textContent =
      "Unapplied changes · start a new run to use them.";
    document
      .querySelectorAll("[data-preset]")
      .forEach((b) =>
        b.classList.toggle("active", b.dataset.preset === "custom"),
      );
  });
for (let b of document.querySelectorAll("[data-preset]"))
  b.onclick = () => {
    document
      .querySelectorAll("[data-preset]")
      .forEach((x) => x.classList.toggle("active", x === b));
    if (b.dataset.preset !== "custom") {
      fillParams({
        ...DEFAULTS,
        demand: b.dataset.preset === "peak" ? 4500 : 1500,
        mode: "shared",
      });
      $("pendingLabel").textContent =
        "Preset loaded · apply to start a new run.";
    }
  };
$("zoomIn").onclick = () => {
  map.zoom = Math.min(250, map.zoom * 1.3);
  map.draw();
};
$("zoomOut").onclick = () => {
  map.zoom = Math.max(0.3, map.zoom / 1.3);
  map.draw();
};
$("fitBtn").onclick = () => {
  map.fit();
  $("stationPopup").hidden = true;
};
function setBasemap(name, opacity = null) {
  if (opacity !== null && Number.isFinite(opacity)) {
    map.opacity = Math.max(0.2, Math.min(1, opacity));
  } else if (name !== map.basemap)
    map.opacity = name === "satellite" ? 0.55 : 0.68;
  map.setBasemap(name);
  for (let [id, layer] of [
    ["tilesBtn", "clean"],
    ["satelliteBtn", "satellite"],
    ["schematicBtn", "network"],
  ]) {
    let active = map.basemap === layer;
    $(id).classList.toggle("active", active);
    $(id).setAttribute("aria-pressed", String(active));
  }
  $("basemapOpacity").hidden = map.basemap === "network";
  $("backgroundOpacity").value = Math.round(map.opacity * 100);
  $("opacityValue").textContent = `${Math.round(map.opacity * 100)}%`;
  $("tileAttribution").hidden = map.basemap === "network";
  $("tileAttribution").innerHTML =
    map.basemap === "satellite"
      ? 'Tiles © <a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9" target="_blank" rel="noopener">Esri</a> · Maxar · Earthstar Geographics · GIS User Community'
      : '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
}
$("tilesBtn").onclick = () => setBasemap("clean");
$("satelliteBtn").onclick = () => setBasemap("satellite");
$("schematicBtn").onclick = () => setBasemap("network");
$("backgroundOpacity").oninput = (e) => {
  map.opacity = Number(e.target.value) / 100;
  $("opacityValue").textContent = `${e.target.value}%`;
  map.draw();
};

function selectStation(id) {
  map.selected = id;
  $("stationPopup").hidden = true;
  if (id < 0) {
    map.draw();
    return;
  }
  inspect("station", id, false);
  map.draw();
}
$("presentBtn").onclick = () => {
  document.body.classList.toggle("presentation");
  setTimeout(() => {
    map.size();
    if (inspected) focusInspected();
    else map.fit();
  }, 60);
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.body.classList.remove("presentation");
    if (adding) {
      adding = false;
      map.addMode = false;
      toast("Add-stop mode cancelled.");
    }
  }
  if (
    e.code === "Space" &&
    !$("modal").open &&
    !["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(
      document.activeElement.tagName,
    )
  ) {
    e.preventDefault();
    togglePlay();
  }
});
function scenario() {
  return {
    looplabScenario: 3,
    modelVersion: "3.0-fifo-audited",
    name: mapName,
    projectName,
    geojson,
    params,
    settings,
    od,
    snap,
    stationSnap,
    operations,
    view: { basemap: map.basemap, opacity: map.opacity },
  };
}
function download(name, text, type = "application/json") {
  let url = URL.createObjectURL(new Blob([text], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("saveBtn").onclick = () => {
  download(
    `${mapName.replace(/[^a-z0-9]/gi, "-")}-scenario.json`,
    JSON.stringify(scenario(), null, 2),
  );
  toast("Scenario saved with route, stops, demand and applied parameters.");
};
function validateSettings(conf, net, p) {
  if (conf.settings) {
    if (
      !Array.isArray(conf.settings) ||
      conf.settings.length !== net.stations.length
    )
      throw Error("Saved station settings do not match the map.");
    let enabled = 0;
    for (let s of conf.settings) {
      if (
        s.stationType &&
        !["bypass", "terminus-single", "terminus-double"].includes(
          s.stationType,
        )
      )
        throw Error("Unknown station layout type.");
      if (
        typeof s.name !== "string" ||
        !s.name.trim() ||
        !Number.isFinite(s.weight) ||
        s.weight < 0 ||
        !Number.isFinite(s.attraction) ||
        s.attraction < 0 ||
        typeof s.enabled !== "boolean"
      )
        throw Error("Invalid station settings.");
      if (s.enabled) enabled++;
    }
    if (enabled < 2) throw Error("At least two stops must be enabled.");
  }
  if (conf.od) {
    if (
      !Array.isArray(conf.od) ||
      conf.od.length !== net.stations.length ||
      conf.od.some(
        (r) =>
          !Array.isArray(r) ||
          r.length !== net.stations.length ||
          r.some((v) => !Number.isFinite(v) || v < 0),
      )
    )
      throw Error("Invalid destination matrix.");
  }
}
async function importFile(file) {
  try {
    stop();
    let result = await readMap(file);
    if (result.scenario) {
      let conf = result.scenario;
      let checked = buildNetwork(conf.geojson, {
        snap: conf.snap ?? 30,
        stationSnap: conf.stationSnap ?? 100,
      });
      validateParams({ ...DEFAULTS, ...conf.params });
      validateSettings(conf, checked);
      if (conf.operations) validateOperations(conf.operations, checked);
      loadNetwork(conf.geojson, conf.name || file.name, conf);
      $("modal").close();
      toast("Scenario loaded. Start a new run to reproduce it.");
      return;
    }
    importReview(result.data, file.name, result.warning);
  } catch (e) {
    toast(`Import failed: ${e.message}`);
  }
}
$("mapInput").onchange = (e) => {
  if (e.target.files[0]) importFile(e.target.files[0]);
  e.target.value = "";
};
function uploadDialog() {
  stop();
  modal(
    "Bring your network.",
    '<div class="upload-zone" id="uploadZone"><strong>Choose a track map or saved scenario</strong><p>Use line features for tracks and point features for stops.</p><div><span class="format-chip">KMZ</span><span class="format-chip">KML</span><span class="format-chip">GeoJSON</span><span class="format-chip">Scenario JSON</span></div><button id="chooseMap" class="dark-btn" style="margin-top:15px">Choose file</button></div><p>Files are processed in your browser. Map and scenario uploads are not sent to a server. Maximum upload 20 MB; expanded KML 15 MB. KMZ imports doc.kml when present.</p><h3>Preparing a reusable map</h3><ul><li>Use WGS84 longitude/latitude coordinates, named lines for tracks, and named points for stations.</li><li>Track directions are modelled as separate opposing lanes. Line endpoints join nearby tracks within the chosen snap tolerance.</li><li>Interior line crossings do not form junctions unless a line endpoint meets them. Split lines at intended junctions.</li><li>Polygons and external KML NetworkLinks are not track data. Export referenced geometry into the file.</li><li>Demand, pod settings and routing assumptions can be saved in a scenario JSON.</li></ul><div class="modal-actions"><button id="restoreLocal" class="outline-btn">Restore browser draft</button><button id="restoreDemo" class="outline-btn">Load fictional demo network</button></div>',
  );
  $("chooseMap").onclick = () => $("mapInput").click();
  let zone = $("uploadZone");
  zone.ondragover = (e) => e.preventDefault();
  zone.ondrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
  };
  $("restoreDemo").onclick = async () => {
    try {
      let data = await fetch("./demo.geojson").then((r) => r.json());
      params = { ...DEFAULTS };
      loadNetwork(data, "Demo Loop", {
        snap: 30,
        stationSnap: 100,
        projectName: "Fictional demonstration network",
        view: { basemap: "network", opacity: 0.68 },
      });
      $("modal").close();
      toast("Fictional demo network loaded.");
    } catch (e) {
      toast(e.message);
    }
  };
  $("restoreLocal").onclick = () => {
    try {
      let c = JSON.parse(localStorage.getItem("looplab-draft"));
      if (!c)
        throw Error(
          "No browser draft saved. Save one from the network editor.",
        );
      let net = buildNetwork(c.geojson, {
        snap: c.snap,
        stationSnap: c.stationSnap,
      });
      validateSettings(c, net);
      if (c.operations) validateOperations(c.operations, net);
      validateParams({ ...DEFAULTS, ...c.params });
      loadNetwork(c.geojson, c.name, c);
      $("modal").close();
      toast("Browser draft restored.");
    } catch (e) {
      toast(e.message);
    }
  };
}
$("uploadBtn").onclick = uploadDialog;
function importReview(data, name, warning = "") {
  let normalized;
  try {
    normalized = buildNetwork(data, { snap, stationSnap });
  } catch (e) {
    normalized = { error: e.message };
  }
  modal(
    "Review imported network",
    `<p>${esc(name)} · confirm how nearby features should connect.</p><label class="field"><span>Track endpoint snap tolerance <em>m</em></span><input id="importSnap" type="number" min="0" max="500" value="${snap}"></label><label class="field"><span>Stop projection limit <em>m</em></span><input id="importStationSnap" type="number" min="1" max="1000" value="${stationSnap}"></label><div id="importReport">${reportHTML(normalized)}</div>${warning ? `<p class="error">${esc(warning)}</p>` : ""}<p class="modal-note">A connection within the endpoint tolerance adds a short straight connector. Stops are placed on the nearest track within the projection limit. Check these choices before relying on journey results.</p><div class="modal-actions"><button id="checkImport" class="outline-btn">Recheck connections</button><button id="acceptImport" class="primary-btn">Use this network ↗</button></div>`,
  );
  const get = () => {
    let sp = Number($("importSnap").value),
      ss = Number($("importStationSnap").value);
    if (
      !$("importSnap").checkValidity() ||
      !$("importStationSnap").checkValidity()
    )
      throw Error("Enter valid snap limits.");
    return { snap: sp, stationSnap: ss };
  };
  $("checkImport").onclick = () => {
    try {
      let n = buildNetwork(data, get());
      $("importReport").innerHTML = reportHTML(n);
    } catch (e) {
      $("importReport").innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  };
  $("acceptImport").onclick = () => {
    try {
      let config = get();
      loadNetwork(data, name, {
        ...config,
        projectName: name.replace(/\.(kmz|kml|geojson|json)$/i, ""),
      });
      $("modal").close();
      toast("Map loaded. Review parameters and demand, then start a run.");
    } catch (e) {
      $("importReport").innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  };
}
function reportHTML(n) {
  if (n.error) return `<p class="error">${esc(n.error)}</p>`;
  return `<p class="modal-note"><strong>${n.lines.length} track lines · ${n.stations.length} stops · ${(n.length / 1000).toFixed(2)} route km</strong><br>Two-way routing ${n.stations.length < 2 ? "requires at least two stops." : "checked between all stop pairs."}</p>${n.warnings.length ? `<ul>${n.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "<p>All stops project within 5 m of the supplied tracks.</p>"}`;
}
$("networkBtn").onclick = networkEditor;
function networkEditor() {
  stop();
  modal(
    "Your network",
    `${reportHTML(network)}<p>Lengths are calculated from the imported geometry. Review the measured network before comparing scenarios.</p><div class="table-scroll"><table class="modal-table"><thead><tr><th>TRACK</th><th>GEOMETRY LENGTH</th><th>VERTICES</th></tr></thead><tbody>${network.lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${(l.points.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - l.points[i][0], p[1] - l.points[i][1]), 0) / 1000).toFixed(3)} km</td><td>${l.points.length}</td></tr>`).join("")}</tbody></table></div><h3>Stops</h3><div class="table-scroll"><table class="modal-table"><thead><tr><th>NAME</th><th>TRACK OFFSET</th><th></th></tr></thead><tbody>${network.stations.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.snapDistance.toFixed(1)} m</td><td><button class="tiny-link remove-stop" data-id="${s.id}">Remove</button></td></tr>`).join("")}</tbody></table></div><p class="help">Adding or removing stops starts a fresh run and resets station demand weights and destination settings. Inactive stops can instead be set in the demand editor.</p><div class="modal-actions"><button id="draftBtn" class="outline-btn">Save browser draft</button><button id="exportMap" class="outline-btn">Export GeoJSON ↓</button><button id="addStop" class="primary-btn">Add a stop on map ＋</button></div>`,
  );
  $("exportMap").onclick = () =>
    download(
      "looplab-network.geojson",
      JSON.stringify(geojson, null, 2),
      "application/geo+json",
    );
  $("draftBtn").onclick = () => {
    try {
      localStorage.setItem("looplab-draft", JSON.stringify(scenario()));
      toast("Draft saved in this browser.");
    } catch (e) {
      toast("Browser storage is unavailable. Use Save scenario instead.");
    }
  };
  $("addStop").onclick = () => {
    $("modal").close();
    map.addMode = true;
    adding = true;
    toast("Click a track to place a stop. Press Esc to cancel.");
  };
  document.querySelectorAll(".remove-stop").forEach(
    (b) =>
      (b.onclick = () => {
        let feature = featuresFromNetwork().filter(
          (f, i) =>
            !(
              f.geometry.type === "Point" &&
              f.properties.stopId === Number(b.dataset.id)
            ),
        );
        try {
          loadNetwork(
            { type: "FeatureCollection", features: feature },
            mapName,
            { projectName, operations },
          );
          networkEditor();
        } catch (e) {
          toast(e.message);
        }
      }),
  );
}
function featuresFromNetwork() {
  return [
    ...network.raw.lines.map((l) => ({
      type: "Feature",
      properties: { name: l.name },
      geometry: { type: "LineString", coordinates: l.coords },
    })),
    ...network.stations.map((s, i) => ({
      type: "Feature",
      properties: {
        name: settings?.[i]?.name || s.name,
        stopId: i,
        stationType: settings?.[i]?.stationType || s.stationType,
      },
      geometry: { type: "Point", coordinates: s.coord },
    })),
  ];
}
map.onAdd = (point) => {
  map.addMode = false;
  if (adding === "crossing") {
    adding = false;
    let next = {
      ...operations,
      crossings: [
        ...operations.crossings,
        {
          id: `X${Date.now().toString(36)}`,
          name: `CROSS ${operations.crossings.length + 1}`,
          coord: network.unproject(point),
          roadAngle: 90,
          enabled: true,
          confirmed: false,
        },
      ],
    };
    try {
      operations = validateOperations(next, network);
      reset();
      toast(
        "Crossing added. Edit its road angle and timings in Stations & signals.",
      );
    } catch (e) {
      toast(e.message);
    }
    return;
  }
  adding = false;
  let coord = network.unproject(point),
    name = `Stop ${network.stations.length + 1}`,
    features = featuresFromNetwork();
  features.push({
    type: "Feature",
    properties: { name },
    geometry: { type: "Point", coordinates: coord },
  });
  try {
    loadNetwork({ type: "FeatureCollection", features }, mapName, {
      projectName,
      operations,
    });
    toast(`${name} added. Rename it in station demand settings.`);
  } catch (e) {
    toast(e.message);
  }
};
$("demandBtn").onclick = demandEditor;
function demandEditor() {
  stop();
  modal(
    "Where journeys begin",
    `<p>Distribute the applied network demand of <strong>${fmt(params.demand)} pax/hour</strong>. Origin weights divide total arrivals; destination weights set relative attractions. Zero-origin stops can still receive passengers.</p><div class="table-scroll"><table class="modal-table"><thead><tr><th>ACTIVE</th><th>STATION</th><th>ORIGIN WEIGHT</th><th>DESTINATION WEIGHT</th><th>PAX/H*</th></tr></thead><tbody>${settings.map((s, i) => `<tr><td><input id="enabled-${i}" type="checkbox" ${s.enabled ? "checked" : ""}></td><td><input id="name-${i}" type="text" value="${esc(s.name)}" maxlength="60"></td><td><input id="weight-${i}" type="number" min="0" max="100000" step="0.1" value="${s.weight}"></td><td><input id="attraction-${i}" type="number" min="0" max="100000" step="0.1" value="${s.attraction}"></td><td>${Math.round((params.demand * s.weight) / (settings.filter((x) => x.enabled).reduce((a, x) => a + x.weight, 0) || 1))}</td></tr>`).join("")}</tbody></table></div><p class="help">*Applied origin share before edits; recomputed on save. At least two active stops and one positive origin weight are required. Each positive origin needs an eligible destination.</p><label class="check-field"><input id="useOD" type="checkbox" ${od ? "checked" : ""}> Use a custom destination matrix</label><div id="odEditor" ${od ? "" : "hidden"}><p>Rows are origins; columns are destinations. Values are relative weights, not additional arrivals. Each non-zero row is normalised to 100%. Total demand comes from the network arrivals parameter.</p><div class="table-scroll"><table class="modal-table od-table"><thead><tr><th>FROM ↓ / TO →</th>${settings.map((s) => `<th>${esc(s.name)}</th>`).join("")}</tr></thead><tbody>${settings.map((s, i) => `<tr><th>${esc(s.name)}</th>${settings.map((_, j) => `<td>${i === j ? "—" : `<input aria-label="${esc(s.name)} to ${esc(settings[j].name)} weight" id="od-${i}-${j}" type="number" min="0" max="1000000" value="${od?.[i]?.[j] ?? 1}">`}</td>`).join("")}</tr>`).join("")}</tbody></table></div><button id="exportOD" class="text-btn">Download destination matrix CSV ↓</button></div><div class="modal-actions"><button id="saveDemand" class="primary-btn">Save demand & reset run ↗</button></div>`,
  );
  $("useOD").onchange = () => ($("odEditor").hidden = !$("useOD").checked);
  $("exportOD").onclick = () => {
    let rows = [
      ["from / to", ...settings.map((s) => s.name)],
      ...settings.map((s, i) => [
        s.name,
        ...settings.map((_, j) =>
          i === j ? 0 : Number($(`od-${i}-${j}`).value),
        ),
      ]),
    ];
    download("looplab-destination-weights.csv", csv(rows), "text/csv");
  };
  $("saveDemand").onclick = () => {
    try {
      let next = settings.map((s, i) => {
        let name = $(`name-${i}`).value.trim();
        if (!name) throw Error("Each stop needs a name.");
        for (let k of ["weight", "attraction"])
          if (!$(`${k}-${i}`).checkValidity())
            throw Error("Use non-negative station weights.");
        return {
          ...s,
          name,
          enabled: $(`enabled-${i}`).checked,
          weight: Number($(`weight-${i}`).value),
          attraction: Number($(`attraction-${i}`).value),
        };
      });
      if (next.filter((s) => s.enabled).length < 2)
        throw Error("Enable at least two stops.");
      if (!next.some((s) => s.enabled && s.weight > 0))
        throw Error("Give at least one active stop a positive origin weight.");
      let matrix = null;
      if ($("useOD").checked)
        matrix = next.map((s, i) =>
          next.map((_, j) => {
            if (i === j) return 0;
            let el = $(`od-${i}-${j}`);
            if (!el.checkValidity())
              throw Error("Matrix entries must be non-negative numbers.");
            return Number(el.value);
          }),
        );
      for (let i = 0; i < next.length; i++)
        if (
          next[i].enabled &&
          next[i].weight > 0 &&
          !next.some(
            (s, j) =>
              j !== i &&
              s.enabled &&
              (matrix ? matrix[i][j] > 0 : s.attraction > 0),
          )
        )
          throw Error(
            `${next[i].name} needs a positive destination weight to another active stop.`,
          );
      settings = next;
      od = matrix;
      reset();
      $("modal").close();
      toast("Station demand saved. A fresh run is ready.");
    } catch (e) {
      toast(e.message);
    }
  };
}
function csv(rows) {
  return rows
    .map((r) =>
      r
        .map((v) => {
          let s = String(v);
          if (/^[=+@\-]/.test(s) && typeof v !== "number") s = "'" + s;
          return '"' + s.replaceAll('"', '""') + '"';
        })
        .join(","),
    )
    .join("\r\n");
}
function summaryRows() {
  let s = sim.stats();
  return [
    ["LoopLab simulation results", "Value", "Unit"],
    ["Scenario", projectName, ""],
    ["Model version", "3.0-fifo-audited", ""],
    ["Simulated duration", s.elapsed, "seconds"],
    ["Generated passengers", s.generated, "pax"],
    ["Delivered passengers", s.served, "pax"],
    ["Waiting passengers", s.waiting, "pax"],
    ["Boarding passengers", s.boarding, "pax"],
    ["Onboard passengers", s.onboard, "pax"],
    ["Network delivered rate since start", s.throughput, "pax/hour"],
    ["Mean wait (departed passengers)", s.meanWait, "seconds"],
    ["P95 wait (departed passengers)", s.p95Wait, "seconds"],
    ["Mean ride (delivered passengers)", s.meanRide, "seconds"],
    ["Average departure load", s.load, "pax/pod"],
    ["Passenger trips started", s.trips, "trips"],
    ["Empty trips started", s.emptyTrips, "trips"],
    ["Total vehicle distance", s.km, "km"],
    ["Empty vehicle distance", s.emptyKm, "km"],
    ["Reserve pods outside service", s.reserve, "pods"],
    ["Road vehicles cleared", s.roadPassed, "cars"],
    ["Road vehicles currently waiting", s.roadWaiting, "cars"],
    [""],
    ["Crossing", "Phase", "Cars cleared", "Pods cleared", "Intrusion"],
    ...sim.crossings.map((c) => [
      c.name,
      c.phase,
      c.passedCars,
      c.passedPods,
      c.intrusion,
    ]),
    [""],
    ["Applied parameters", "Value"],
    ...Object.entries(params),
    [""],
    ["Station", "Waiting pax", "Delivered pax", "Passenger departures"],
    ...sim.stations.map((s) => [
      s.name,
      s.queue.reduce((a, g) => a + g.n, 0),
      s.served,
      s.departures,
    ]),
    [""],
    ["Time seconds", "Delivered cumulative", "Waiting pax", "Moving pods"],
    ...sim.history.map((h) => [h.t, h.served, h.queue, h.active]),
  ];
}
$("resultsBtn").onclick = resultsDialog;
$("resultsMain").onclick = resultsDialog;
function resultsDialog() {
  stop();
  let s = sim.stats();
  modal(
    "Every journey, counted.",
    `<p>${esc(projectName)} · ${time(s.elapsed)} simulated · seed ${params.seed}</p><div class="result-grid">${[
      ["Delivered", fmt(s.served) + " pax"],
      ["Delivered rate", fmt(s.throughput) + " pax/h"],
      ["Mean wait", sim.waits.length ? duration(s.meanWait) : "—"],
      ["95th percentile wait", sim.waits.length ? duration(s.p95Wait) : "—"],
      ["Mean in-vehicle time", sim.rides.length ? duration(s.meanRide) : "—"],
      ["Vehicle distance", s.km.toFixed(1) + " km"],
    ]
      .map(
        ([l, v]) =>
          `<div class="result-card"><strong>${v}</strong><span>${l}</span></div>`,
      )
      .join(
        "",
      )}</div><h3>Passengers waiting over time</h3><canvas id="resultChart" class="chart"></canvas><p class="help">Rate = passengers delivered ÷ elapsed simulated hours, including startup. It is a network-wide rate, not passengers per hour per direction. Wait metrics include passengers who have departed; people still waiting are shown separately.</p><p class="modal-note">Passenger balance: ${s.generated} generated = ${s.served} delivered + ${s.waiting} queued + ${s.boarding} boarding + ${s.onboard} onboard.</p><h3>Scenario comparisons</h3><div id="compareTable">${comparisonHTML()}</div><div class="modal-actions"><button id="exportResults" class="outline-btn">Export results CSV ↓</button><button id="snapshotResult" class="primary-btn">Save this comparison ＋</button></div>`,
  );
  drawChart();
  $("exportResults").onclick = () =>
    download("looplab-results.csv", csv(summaryRows()), "text/csv");
  $("snapshotResult").onclick = () => {
    saveSnapshot();
    $("compareTable").innerHTML = comparisonHTML();
  };
}
function saveSnapshot() {
  if (!sim.time) {
    toast("Run the simulation before saving a comparison.");
    return;
  }
  snapshots.push({
    label: `Run ${snapshots.length + 1}`,
    time: sim.time,
    params: { ...params },
    stats: sim.stats(),
    name: projectName,
    stations: JSON.parse(JSON.stringify(settings)),
    od: od ? JSON.parse(JSON.stringify(od)) : null,
  });
  if (snapshots.length > 8) snapshots.shift();
  toast("Comparison saved for this browser session.");
}
$("snapshotBtn").onclick = () => {
  saveSnapshot();
};
function comparisonHTML() {
  if (!snapshots.length)
    return "<p>No comparisons saved yet. Save a base case, change parameters, then save another run of the same duration.</p>";
  return `<div class="table-scroll"><table class="modal-table"><thead><tr><th>RUN / MAP</th><th>DURATION</th><th>DEMAND</th><th>FLEET</th><th>DELIVERED/H</th><th>MEAN WAIT</th><th>WAITING</th></tr></thead><tbody>${snapshots.map((s) => `<tr><td>${esc(s.label)} · ${esc(s.name)}</td><td>${time(s.time)}</td><td>${s.params.demand}</td><td>${s.params.fleet}</td><td>${fmt(s.stats.throughput)}</td><td>${duration(s.stats.meanWait)}</td><td>${s.stats.waiting}</td></tr>`).join("")}</tbody></table></div><p class="help">Use equal run durations and seeds for comparisons. Each row retains the applied parameters, station weights and destination matrix in this session.</p>`;
}
function drawChart() {
  let c = $("resultChart"),
    r = c.getBoundingClientRect(),
    d = devicePixelRatio || 1;
  c.width = r.width * d;
  c.height = r.height * d;
  let ctx = c.getContext("2d");
  ctx.scale(d, d);
  let w = r.width,
    h = r.height,
    data = sim.history,
    max = Math.max(10, ...data.map((x) => x.queue));
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#98a58c";
  for (let i = 0; i < 4; i++) {
    let y = 15 + ((h - 45) * i) / 3;
    ctx.strokeStyle = "#e1e8d6";
    ctx.beginPath();
    ctx.moveTo(38, y);
    ctx.lineTo(w - 15, y);
    ctx.stroke();
    ctx.fillText(Math.round(max * (1 - i / 3)), 8, y + 3);
  }
  if (data.length) {
    ctx.strokeStyle = "#6f9256";
    ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((v, i) => {
      let x = 38 + ((w - 53) * v.t) / Math.max(1, sim.time),
        y = 15 + (h - 45) * (1 - v.queue / max);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  ctx.fillText("00:00", 38, h - 8);
  ctx.fillText(time(sim.time), w - 65, h - 8);
}
const limitations = `<p class="modal-note">This is an interactive planning and presentation model. Its outputs are scenario estimates. Operational calibration and engineering validation would be required for real-world use.</p><ul><li><strong>Topology:</strong> direction-constrained shortest-distance routing on separate opposing lanes, with no instant running-track reversals. Branch endpoints may be connected by short straight links within the snap tolerance. Stop markers are projected to their nearest tracks. Geometry is measured using a local metric projection, best suited to city-scale networks.</li><li><strong>Passenger arrivals:</strong> seeded exponential inter-arrival times (Poisson demand), fixed group size, no abandonment, no event surges unless you change demand between runs. Destinations follow your weights or matrix. Shared pods combine only passengers bound for the same destination and make no intermediate stops.</li><li><strong>Stations:</strong> FIFO berths per departure platform, separate directional bypass queues, a single departure-platform terminus or optional distinct arrival/departure platforms, station-throat reservations, alighting, switch-back time, boarding, door closing and departure interlocks. Excess initial fleet remains in an unmapped reserve; the assumed depot is outside the service model. The active fleet is limited by the available platform spaces; excess initial pods remain in reserve. Reserved arrival berths prevent over-dispatch to a full platform. Arrivals join the back; only the front pod boards and departs. A receiving berth is booked before guideway departure; full platforms may exchange pods in a coordinated dispatch. Followers advance with doors closed. Terminal approaches use a reserved reversal drawer before joining the departure queue. These exact layouts remain illustrative. Local movement, reversal and door times are editable.</li><li><strong>Movement:</strong> conservative exclusive routing zones around station access, branch switches and tight sketch bends; FIFO ownership prevents followers reserving a route ahead of their leader. These zones may reduce throughput and are assumptions pending engineering validation. Finite acceleration and braking, speed cap, following-time spacing, a following-distance constraint and a physical 4 m × 1.275 m pod-footprint clearance guard. Opposing directions use separate conceptual tracks. Single-pod crossing reservations and station-throat reservations demonstrate conflicting movement control. This does not reproduce certified ATP, moving blocks, complete network interlocking or validated spillback protection.</li><li><strong>Crossings:</strong> road/pedestrian green → road amber → all-red clearance → a pod phase → all-red pod clearance. Cars and pedestrians already committed clear before pods are released; road green waits for the last reserved pod to clear. Intrusion holds both flows. The generated demo locations, road orientation, demand and timings are illustrative and editable. The previous distance-based crossing allowance is used only when no explicit crossings are enabled. Road traffic uses short local approach corridors, not a city traffic model.</li><li><strong>Empty pods:</strong> every five simulated seconds, eligible idle pods are sent to demand queues or to restore a pod where a donor has a spare. A full station with no demand releases a pod to a least-stocked compatible stop, using a simple stock-balancing rule. This is a transparent heuristic, an illustrative dispatch algorithm.</li><li><strong>Metrics:</strong> delivered rate is network-wide since start, including startup, with no warm-up removal. Wait time ends at pod departure and is reported only for departed passengers. Ride time ends at arrival. Incomplete trips are excluded from delivered passenger and mean ride counts.</li><li>Energy, HVAC, gradients, turn-radius speed limits, failures, evacuation, maintenance outages and regulatory compliance are outside this model.</li></ul>`;
function basisDialog() {
  stop();
  modal(
    "Fictional network, explicit assumptions",
    `<p>LoopLab is an independent educational prototype for exploring small automated transit networks. The included network is generated from an ellipse and five radial branches around an arbitrary coordinate origin. It represents no real project.</p><p>Every operating value is hypothetical: fleet size, pod dimensions and capacity, cruise speed, dwell time, acceleration, platform layouts and signal timings. Change these under Fleet & operation and Stations & signals. No operator data, supplier documents or engineering drawings are included.</p><p>Shared mode pools requests with the same destination. Private mode allocates one passenger group per pod. Arrivals join the back of each departure queue; only the front pod boards and leaves. Followers advance with closed doors.</p><p>This prototype demonstrates software and planning concepts. It has not been validated against an operating transport system.</p>`,
    "MODEL BASIS",
  );
}
$("basisBtn").onclick = basisDialog;
$("limitationsBtn").onclick = () => {
  stop();
  modal("What the model includes", limitations, "MODEL SCOPE");
};
$("guideBtn").onclick = () => {
  stop();
  modal(
    "From a map to moving pods.",
    `<ol><li><strong>Review the route.</strong> A fictional demo network is preloaded. Green track lines connect eight stops; off-loop stops use the five branches.</li><li><strong>Set fleet, demand and service.</strong> Choose shared pods for passengers travelling to the same destination, or private pods for individual groups. Advanced settings control collection time, headway, acceleration and crossing allowances.</li><li><strong>Apply and run.</strong> Apply starts a fresh run. Playback changes animation speed without changing simulated physics. Advance 15 min calculates a consistent additional fifteen minutes.</li><li><strong>Explore operating detail.</strong> Select a stop or CROSS from Inspect, then Zoom to detail. Zooming in reveals platform berths, pods, road signals, cars and pedestrians. The live detail panel explains the selected element. Stations & signals edits illustrative locations, layouts and timing; obstruction buttons exercise the interlocks.</li><li><strong>Watch the journeys.</strong> Solid green pods carry passengers; outlined pods reposition empty. Intermediate stops are bypassed. Click a stop for its queue and delivered count.</li><li><strong>Compare scenarios.</strong> Save a comparison, change settings, and run for the same duration. Results & export shows saved comparisons and downloads detailed CSV results.</li><li><strong>Reuse with another map.</strong> Import KMZ, KML or GeoJSON. Review connection tolerances. Point features become stops; line features become two-way tracks. Add missing stops in the network editor.</li><li><strong>Keep your work.</strong> Save scenario downloads the geometry, applied settings and destination weights. Reload it with Import map. Save browser draft is also available in the network editor.</li></ol><p class="modal-note">Press Space to play/pause. Drag the map to pan and scroll to zoom. Present expands the map; Esc returns to the dashboard.</p>${limitations}`,
    "QUICK GUIDE",
  );
};
function refreshFocusOptions() {
  let selected = $("focusTarget").value;
  let options = [
    '<option value="overview">Network overview</option>',
    ...sim.stations.map(
      (s) => `<option value="station:${s.id}">Stop · ${esc(s.name)}</option>`,
    ),
    ...sim.crossings.map(
      (c) =>
        `<option value="crossing:${esc(c.id)}">${esc(c.name)}${c.confirmed ? "" : " · demo"}</option>`,
    ),
  ];
  $("focusTarget").innerHTML = options.join("");
  $("focusTarget").value = [...$("focusTarget").options].some(
    (x) => x.value === selected,
  )
    ? selected
    : "overview";
  let demo = sim.crossings.filter((c) => !c.confirmed).length;
  $("operationsBadge").textContent =
    `${sim.crossings.length} CROSS${demo ? ` · ${demo} illustrative locations` : ""}`;
  if (inspected && !getInspected()) {
    $("detailPanel").hidden = true;
    inspected = null;
  }
}
function getInspected() {
  return inspected?.kind === "station"
    ? sim.stations[inspected.id]
    : inspected
      ? sim.crossings.find((c) => c.id === inspected.id)
      : null;
}
function inspect(kind, id, focus = false) {
  inspected = { kind, id };
  let item = getInspected();
  if (!item) return;
  inspector.select(kind, id);
  $("detailPanel").hidden = false;
  $("inspectorTitle").textContent = item.name;
  $("focusTarget").value = `${kind}:${id}`;
  $("requestCrossing").hidden = kind !== "crossing";
  if (focus) focusInspected();
  renderInspector();
  requestAnimationFrame(() => inspector.draw());
}
function focusInspected() {
  let item = getInspected();
  if (item) {
    map.focusPoint(
      item.trackPoint || item.point,
      Math.min(
        8,
        (map.w - 80) /
          (inspected.kind === "station" ? params.berths * 5 + 45 : 140),
      ),
    );
    if (
      document.body.classList.contains("presentation") &&
      !$("detailPanel").hidden
    ) {
      if (map.w > 600) map.pan[0] -= map.w * 0.14;
      else map.pan[1] -= map.h * 0.18;
      map.draw();
    }
  }
}
function renderInspector() {
  if (!inspected || $("detailPanel").hidden) return;
  let item = getInspected();
  if (!item) return;
  let e = esc;
  if (inspected.kind === "station") {
    let pods = sim.pods.filter(
        (p) =>
          p.station === item.id && !["moving", "reserve"].includes(p.state),
      ),
      counts = {};
    for (let p of pods) counts[p.state] = (counts[p.state] || 0) + 1;
    let sequence = [
      "entering",
      ...(item.stationType === "terminus-single"
        ? ["reversing", "alighting"]
        : item.stationType === "terminus-double"
          ? ["alighting", "reversing"]
          : ["alighting"]),
      "advancing",
      "idle",
      "boarding",
      "closing",
      "ready",
      "departing",
    ];
    $("inspectorStatus").innerHTML =
      `<div class="inspector-status"><span class="status-tag">${item.stationType === "bypass" ? "Double bypass" : item.stationType === "terminus-single" ? "Single-platform terminus" : "Arrival + departure platforms"}</span><span class="status-tag">${item.slots.filter((x) => x !== null).length}/${item.layout.capacity} berths occupied</span><span class="status-tag ${item.doorObstruction ? "red" : ""}">${item.doorObstruction ? "Door obstruction · departure held" : "Door interlock available"}</span></div><div class="phase-sequence">${sequence.map((s) => `<span class="phase-step ${counts[s] ? "active" : ""}">${e(SERVICE_LABELS[s])}${counts[s] ? ` (${counts[s]})` : ""}</span>`).join("")}</div><p><strong>${item.queue.reduce((a, g) => a + g.n, 0)} waiting</strong> · ${item.served} delivered · ${pods.filter((p) => p.state === "holding").length} pods holding on approach</p>${item.platforms.map((p, i) => `<p class="help"><strong>${item.stationType === "bypass" ? `Platform ${i ? "B" : "A"}` : "Departure platform"} · first → back:</strong> ${p.queue.length ? p.queue.map((id) => `P${String(id + 1).padStart(2, "0")}`).join(" → ") : "empty"} · ${sim.incomingBookings(item.id, i)} arriving berth reservations</p>`).join("")}`;
    $("inspectorExplanation").textContent =
      item.stationType === "bypass"
        ? "Arrivals join the back of their directional siding queue. Only the front pod boards and leaves; followers advance with doors closed. Through pods stay on the guideway. Door warning and a clear route are required for departure."
        : "Arrivals use a separate inbound approach and reserved reversal drawer, then join the back of the departure queue. Only the first pod boards and departs; the others advance with doors closed. At a single platform, passengers alight after reversal at the shared platform. The double-platform option unloads at its separate arrival platform first. Exact terminal geometry is an editable demonstration assumption.";
    $("testInterlock").textContent = item.doorObstruction
      ? "Clear door obstruction"
      : "Test door obstruction";
  } else {
    $("inspectorStatus").innerHTML =
      `<div class="inspector-status"><span class="status-tag ${item.roadSignal === "red" ? "red" : item.roadSignal === "amber" ? "amber" : ""}">Cars: ${item.roadSignal.toUpperCase()}</span><span class="status-tag ${item.podSignal === "red" ? "red" : ""}">Pods: ${item.podSignal.toUpperCase()}</span><span class="status-tag ${item.pedestrianSignal === "wait" ? "red" : ""}">Pedestrians: ${item.pedestrianSignal.toUpperCase()}</span></div><h3>${e(PHASE_LABELS[item.phase])}</h3><p>${Math.floor(sim.time - item.phaseStart)} s in phase · ${item.cars.filter((c) => c.speed < 0.1).length} cars queued<br>${item.passedCars} cars and ${item.passedPods} pods cleared</p><span class="source-tag warning-tag">${item.confirmed ? "Location confirmed by user" : "Demonstration location"} · timing assumptions</span>`;
    $("inspectorExplanation").textContent =
      "A pod request changes the road signals to amber, then all red. Cars and pedestrians already crossing must clear before pods receive permission. Road traffic waits until the reserved pod has cleared. An intrusion forces all signals red and holds pods; clearing it requires a fresh clearance period.";
    $("testInterlock").textContent = item.intrusion
      ? "Clear simulated intrusion"
      : "Simulate intrusion";
  }
  inspector.draw();
}
$("slowDetail").onclick = () => {
  $("playSpeed").value = "1";
  if (!playing) togglePlay();
};
$("focusBtn").onclick = () => {
  let value = $("focusTarget").value;
  if (value === "overview") {
    map.fit();
    $("detailPanel").hidden = true;
    return;
  }
  let [kind, id] = value.split(":");
  inspect(kind, kind === "station" ? Number(id) : id, true);
};
$("focusTarget").onchange = () => {
  $("focusBtn").click();
};
$("detailFocusBtn").onclick = focusInspected;
$("closeDetailBtn").onclick = () => ($("detailPanel").hidden = true);
map.onCrossing = (id) => inspect("crossing", id, false);
$("testInterlock").onclick = () => {
  let item = getInspected();
  if (!item) return;
  if (inspected.kind === "station")
    item.doorObstruction = !item.doorObstruction;
  else {
    item.intrusion = !item.intrusion;
    item.transition(item.intrusion ? "fault" : "all-red", sim.time);
  }
  renderInspector();
  map.draw();
};
$("requestCrossing").onclick = () => {
  let c = getInspected();
  if (c && inspected.kind === "crossing") {
    c.manualRequestUntil = sim.time + 60;
    toast(
      "Pod-phase request registered. Play the simulation to see the signal sequence.",
    );
  }
};
$("operationsBtn").onclick = operationsEditor;
$("editInspected").onclick = operationsEditor;
function validateOperations(value, net) {
  let v = { ...DEFAULT_OPERATIONS, ...value };
  for (let [k, min, max] of [
    ["roadGreen", 1, 300],
    ["podGreen", 3, 120],
    ["amber", 1, 15],
    ["clearance", 1, 30],
    ["roadDemand", 0, 3000],
    ["pedDemand", 0, 2000],
    ["turnaround", 1, 60],
    ["doorWarning", 2, 30],
    ["stationMove", 2, 60],
  ])
    if (!Number.isFinite(v[k]) || v[k] < min || v[k] > max)
      throw Error(`Check the ${k} operating assumption.`);
  if (typeof v.enabled !== "boolean")
    throw Error("Crossing enabled setting must be true or false.");
  let list = v.crossings || [];
  if (!Array.isArray(list) || list.length > 80)
    throw Error("Maximum 80 crossing locations per scenario.");
  let ids = new Set();
  for (let c of list) {
    if (
      typeof c.id !== "string" ||
      !c.id ||
      c.id.includes(":") ||
      ids.has(c.id)
    )
      throw Error("Crossings need unique IDs without colons.");
    ids.add(c.id);
    if (
      !Array.isArray(c.coord) ||
      c.coord.length < 2 ||
      !c.coord.slice(0, 2).every(Number.isFinite) ||
      Math.abs(c.coord[0]) > 180 ||
      Math.abs(c.coord[1]) > 85
    )
      throw Error("Crossing coordinates must be WGS84 longitude / latitude.");
    if (!Number.isFinite(c.roadAngle))
      throw Error("Crossing road orientation must be a number.");
  }
  locateCrossings(net, list);
  return { ...v, crossings: list };
}
function operationsEditor() {
  stop();
  let draft = operations.crossings.map((c) => ({ ...c, coord: [...c.coord] }));
  let fields = [
    ["roadGreen", "Minimum road green", "s", 1, 300],
    ["podGreen", "Pod phase window", "s", 3, 120],
    ["amber", "Road amber", "s", 1, 15],
    ["clearance", "All-red clearance", "s", 1, 30],
    ["roadDemand", "Road demand / crossing", "cars/h", 0, 3000],
    ["pedDemand", "Pedestrian demand / crossing", "people/h", 0, 2000],
    ["turnaround", "Terminus switch-back", "s", 1, 60],
    ["doorWarning", "Door closing warning", "s", 2, 30],
    ["stationMove", "Local movement time / 25 m", "s", 2, 60],
  ];
  modal(
    "Stops, crossings and signals",
    `<p class="modal-note">These operating principles are demonstration assumptions. The locations below, local road geometry, timing values and berth layouts are demonstration assumptions. They can be replaced with confirmed project data. Shared pods remain your selected service mode.</p><label class="check-field"><input id="opsEnabled" type="checkbox" ${operations.enabled ? "checked" : ""}> Simulate explicit road crossings and traffic signals</label><div class="operations-grid">${fields.map(([k, label, unit, min, max]) => `<label class="field"><span>${label} <em>${unit}</em></span><input id="ops-${k}" type="number" min="${min}" max="${max}" step="1" value="${operations[k]}"></label>`).join("")}</div><p class="help">Road and pedestrian flows share the conflicting road phase in this local demonstration. The pod phase uses a conservative single-pod reservation per crossing. Existing cars and pedestrians clear before pod permission. The distance-based crossing allowance is ignored while explicit crossings are active.</p><h3>Station layouts</h3><div class="table-scroll"><table class="modal-table"><thead><tr><th>STATION</th><th>LAYOUT</th><th>MODEL BERTHS</th></tr></thead><tbody>${settings.map((s, i) => `<tr><td>${esc(s.name)}</td><td><select id="stationType-${i}"><option value="bypass" ${s.stationType === "bypass" ? "selected" : ""}>Double bypass · directional platforms</option><option value="terminus-single" ${s.stationType === "terminus-single" ? "selected" : ""}>Terminus · single shared platform</option><option value="terminus-double" ${s.stationType === "terminus-double" ? "selected" : ""}>Terminus · arrival + departure platforms</option></select></td><td>${params.berths} per departure platform</td></tr>`).join("")}</tbody></table></div><p class="help">Bypass stations have separate directional departure queues. Single-platform termini share a departure platform; the double-platform option adds a separate arrival platform. Berth pitch, curves and platform positioning are illustrative. The current model has ${sim.stations.reduce((a, s) => a + s.layout.capacity, 0)} docking spaces; excess initial fleet stays in reserve.</p><h3>Crossing locations</h3><div id="crossingDraftTable"></div><div class="modal-actions"><button id="seedCrossings" class="outline-btn">Generate 16 demo locations</button><button id="addCrossing" class="outline-btn">Place crossing on map ＋</button></div><p class="help">Road orientation is degrees counter-clockwise from east. Position confirmed is a user flag; it does not certify timings. Only enabled crossings are simulated. Enabled crossings must stay at least 55 m from branch junctions and 65 m from stops for the demonstration routing buffers. Locations and orientations require site confirmation.</p><div class="modal-actions"><button id="applyOperations" class="primary-btn">Apply operating assumptions & reset run ↗</button></div>`,
    "OPERATING ASSUMPTIONS",
  );
  function readRows() {
    for (let [i, c] of draft.entries()) {
      c.name = $(`crossName-${i}`).value.trim() || c.id;
      c.coord = [
        Number($(`crossLon-${i}`).value),
        Number($(`crossLat-${i}`).value),
      ];
      c.roadAngle = Number($(`crossAngle-${i}`).value);
      c.enabled = $(`crossEnabled-${i}`).checked;
      c.confirmed = $(`crossConfirmed-${i}`).checked;
    }
  }
  function table() {
    $("crossingDraftTable").innerHTML =
      `<div class="table-scroll"><table class="modal-table operations-table"><thead><tr><th>ACTIVE</th><th>NAME</th><th>LONGITUDE</th><th>LATITUDE</th><th>ROAD ANGLE</th><th>POSITION CONFIRMED</th><th></th></tr></thead><tbody>${draft.map((c, i) => `<tr><td><input id="crossEnabled-${i}" type="checkbox" ${c.enabled ? "checked" : ""}></td><td><input id="crossName-${i}" value="${esc(c.name)}" maxlength="50" type="text"></td><td><input id="crossLon-${i}" value="${c.coord[0].toFixed(7)}" type="number" step="any"></td><td><input id="crossLat-${i}" value="${c.coord[1].toFixed(7)}" type="number" step="any"></td><td><input id="crossAngle-${i}" value="${c.roadAngle.toFixed(1)}" type="number" step="any"></td><td><input id="crossConfirmed-${i}" type="checkbox" ${c.confirmed ? "checked" : ""}></td><td><button class="tiny-link focus-draft-cross" data-cross-id="${esc(c.id)}">Inspect ↗</button></td></tr>`).join("")}</tbody></table></div>${draft.length ? "" : "<p>No crossings configured. Generate demonstration locations or place a crossing on the map.</p>"}`;
    document.querySelectorAll(".focus-draft-cross").forEach(
      (b) =>
        (b.onclick = () => {
          $("modal").close();
          let c = sim.crossings.find((c) => c.id === b.dataset.crossId);
          if (c) inspect("crossing", c.id, true);
          else toast("Apply the edited crossing list before inspecting it.");
        }),
    );
  }
  table();
  $("seedCrossings").onclick = () => {
    draft = seedCrossings(network, 16);
    table();
  };
  $("addCrossing").onclick = () => {
    $("modal").close();
    map.addMode = true;
    adding = "crossing";
    toast(
      "Click the guideway to add a crossing. Unapplied editor changes are discarded.",
    );
  };
  $("applyOperations").onclick = () => {
    try {
      readRows();
      let next = {
        ...operations,
        crossings: draft,
        enabled: $("opsEnabled").checked,
      };
      for (let [k] of fields) {
        let el = $(`ops-${k}`);
        if (!el.checkValidity())
          throw Error("Check the operating timing and demand values.");
        next[k] = Number(el.value);
      }
      next = validateOperations(next, network);
      let newSettings = settings.map((s, i) => ({
        ...s,
        stationType: $(`stationType-${i}`).value,
      }));
      operations = next;
      settings = newSettings;
      reset();
      $("modal").close();
      toast("Operating assumptions applied. The simulation has been reset.");
    } catch (e) {
      toast(e.message);
    }
  };
}

try {
  geojson = await fetch("./demo.geojson").then((r) => {
    if (!r.ok) throw Error("Could not load the demo route.");
    return r.json();
  });
  loadNetwork(geojson, "Demo Loop", {
    projectName: "Fictional demonstration network",
    view: { basemap: "network", opacity: 0.68 },
  });
  requestAnimationFrame(frame);
} catch (e) {
  $("runState").textContent = "Network needs attention";
  toast(e.message);
  console.error(e);
}
// Expose read-only diagnostics for deterministic QA; no external services or telemetry.
window.looplab = {
  get network() {
    return network;
  },
  get simulation() {
    return sim;
  },
  get params() {
    return { ...params };
  },
};
