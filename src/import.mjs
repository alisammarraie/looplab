export function parseKML(text) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.getElementsByTagName("parsererror").length)
    throw Error("The KML file is not valid XML.");
  let features = [];
  const all = (el, name) => Array.from(el.getElementsByTagNameNS("*", name));
  for (let p of all(xml, "Placemark")) {
    let name = all(p, "name")[0]?.textContent || "";
    for (let kind of ["LineString", "Point"])
      for (let g of all(p, kind)) {
        let c = all(g, "coordinates")[0]?.textContent?.trim();
        if (!c) continue;
        let coords = c
          .split(/\s+/)
          .map((v) => v.split(",").slice(0, 2).map(Number));
        features.push({
          type: "Feature",
          properties: { name },
          geometry: {
            type: kind,
            coordinates: kind === "Point" ? coords[0] : coords,
          },
        });
      }
  }
  return { type: "FeatureCollection", features };
}
async function unzipKML(buffer) {
  let view = new DataView(buffer),
    bytes = new Uint8Array(buffer),
    end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw Error("Invalid KMZ archive.");
  let n = view.getUint16(end + 10, true),
    offset = view.getUint32(end + 16, true),
    files = [];
  if (n > 1000) throw Error("KMZ contains too many archive entries.");
  for (let i = 0; i < n; i++) {
    if (
      offset + 46 > bytes.length ||
      view.getUint32(offset, true) !== 0x02014b50
    )
      throw Error("Invalid KMZ directory.");
    let method = view.getUint16(offset + 10, true),
      size = view.getUint32(offset + 20, true),
      expanded = view.getUint32(offset + 24, true),
      nl = view.getUint16(offset + 28, true),
      xl = view.getUint16(offset + 30, true),
      cl = view.getUint16(offset + 32, true),
      local = view.getUint32(offset + 42, true),
      name = new TextDecoder().decode(
        bytes.slice(offset + 46, offset + 46 + nl),
      );
    files.push({ name, method, size, expanded, local });
    offset += 46 + nl + xl + cl;
  }
  let kmls = files.filter((x) => /\.kml$/i.test(x.name));
  if (!kmls.length) throw Error("No KML document inside this KMZ.");
  let file = kmls.find((x) => /(^|\/)doc\.kml$/i.test(x.name)) || kmls[0];
  if (file.expanded > 15e6)
    throw Error("Expanded KML exceeds the 15 MB limit.");
  if (
    file.local + 30 > bytes.length ||
    view.getUint32(file.local, true) !== 0x04034b50
  )
    throw Error("Invalid KMZ entry.");
  let start =
    file.local +
    30 +
    view.getUint16(file.local + 26, true) +
    view.getUint16(file.local + 28, true);
  if (start + file.size > bytes.length) throw Error("Truncated KMZ entry.");
  let part = bytes.slice(start, start + file.size),
    out;
  if (file.method === 0) out = part;
  else if (file.method === 8) {
    if (typeof DecompressionStream === "undefined")
      throw Error(
        "This browser cannot unzip KMZ. Export KML/GeoJSON or use a current browser.",
      );
    let stream = new Blob([part])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    let reader = stream.getReader(),
      chunks = [],
      size = 0;
    while (true) {
      let { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 15e6) {
        await reader.cancel();
        throw Error("Expanded KML exceeds 15 MB.");
      }
      chunks.push(value);
    }
    out = new Uint8Array(size);
    let p = 0;
    for (let c of chunks) {
      out.set(c, p);
      p += c.length;
    }
  } else
    throw Error(
      "Unsupported KMZ compression. Export a standard zipped KMZ or KML.",
    );
  return {
    text: new TextDecoder().decode(out),
    extra:
      kmls.length > 1
        ? `Imported ${file.name}; ${kmls.length - 1} other KML document(s) were not included.`
        : "",
  };
}
export async function readMap(file) {
  if (file.size > 20e6) throw Error("File exceeds the 20 MB upload limit.");
  let ext = file.name.split(".").at(-1).toLowerCase();
  if (ext === "kmz") {
    let k = await unzipKML(await file.arrayBuffer());
    return { data: parseKML(k.text), warning: k.extra };
  }
  if (ext === "kml") return { data: parseKML(await file.text()) };
  if (ext === "geojson" || ext === "json") {
    let data = JSON.parse(await file.text());
    if (data.looplabScenario) return { scenario: data };
    return { data };
  }
  throw Error("Choose a .kmz, .kml, .geojson or .json file.");
}
