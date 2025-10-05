import fetch from "node-fetch";
import mcache from "memory-cache";

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_POINTS = 9; // 3x3 grid
const GRID_STEP = 0.02; // ~0.02° ≈ 2 km (ajusta según necesites)

function buildNearbyCoords(lat, lon, maxPoints = MAX_POINTS, step = GRID_STEP) {
  const centerLat = parseFloat(lat);
  const centerLon = parseFloat(lon);
  const coords = [];

  // grid 3x3 centered
  const offsets = [-1, 0, 1];
  for (let i of offsets) {
    for (let j of offsets) {
      if (coords.length >= maxPoints) break;
      coords.push({ lat: +(centerLat + i * step).toFixed(6), lon: +(centerLon + j * step).toFixed(6) });
    }
    if (coords.length >= maxPoints) break;
  }
  return coords;
}

const parameters = [
  "T2M","T2M_MAX","T2M_MIN",
  "PRECTOT","ALLSKY_SFC_SW_DWN",
  "WS2M","WD2M","RH2M","PS"
].join(",");

async function fetchPoint(lat, lon, startDate, endDate) {
  // cache por punto
  const cacheKey = `__nasa_point__${lat}_${lon}_${startDate}_${endDate}`;
  const cached = mcache.get(cacheKey);
  if (cached) return cached;

  const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=${parameters}&start=${startDate}&end=${endDate}&latitude=${lat}&longitude=${lon}&format=JSON&community=AG`;
  const response = await fetch(url, { headers: { Connection: "keep-alive" } });
  if (!response.ok) throw new Error(`NASA POWER ${response.status} ${response.statusText}`);
  const data = await response.json();
  const daily = data?.properties?.parameter || {};
  const res = { coordinates: { lat, lon }, daily };
  mcache.put(cacheKey, res, CACHE_TTL_MS);
  return res;
}

function aggregatePoints(points) {
  // points: [{ coordinates, daily: { T2M: {YYYYMMDD: val, ...}, ... } }, ...]
  // Build map: variable -> date -> array(values)
  const vars = {};
  for (const p of points) {
    for (const v of Object.keys(p.daily)) {
      if (!vars[v]) vars[v] = {};
      for (const [date, val] of Object.entries(p.daily[v])) {
        if (!vars[v][date]) vars[v][date] = [];
        // only accept numeric
        const n = Number(val);
        if (!Number.isNaN(n)) vars[v][date].push(n);
      }
    }
  }

  // compute aggregates
  const aggregated = {};
  for (const [v, dates] of Object.entries(vars)) {
    aggregated[v] = {};
    for (const [date, arr] of Object.entries(dates)) {
      if (arr.length === 0) continue;
      const sum = arr.reduce((a,b) => a+b, 0);
      const mean = sum / arr.length;
      const sq = arr.reduce((a,b) => a + Math.pow(b - mean, 2), 0);
      const std = Math.sqrt(sq / arr.length);
      const min = Math.min(...arr);
      const max = Math.max(...arr);
      aggregated[v][date] = { mean, std, min, max, count: arr.length, samples: arr };
    }
  }
  return aggregated;
}

// handler
export default async function handler(req, res) {
  const origin = req.headers.origin || "*";
  const allowCredentials = process.env.CORS_ALLOW_CREDENTIALS === "true";

  if (allowCredentials) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(204).end();

  const { lat, lon, start, end, grid } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ code: 400, description: "Faltan parámetros lat/lon", data: null });
  }

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10).replace(/-/g, "");
  const defaultStart = new Date(); defaultStart.setDate(defaultStart.getDate() - 7);
  const defaultStartStr = defaultStart.toISOString().slice(0, 10).replace(/-/g, "");
  const startDate = start || defaultStartStr;
  const endDate = end || todayStr;

  const cacheKey = "__nasa__agg__" + req.url;
  const cached = mcache.get(cacheKey);
  if (cached) return res.status(200).json(cached);

  try {
    const coords = buildNearbyCoords(lat, lon, MAX_POINTS, GRID_STEP);
    // si el usuario pide grid=1 puede forzar 1 punto (solo centro)
    const toFetch = (grid === "1") ? [coords[Math.floor(coords.length/2)]] : coords;

    // fetch en paralelo (si necesitas limitar concurrency, puedes usar p-limit)
    const fetchPromises = toFetch.map(c => fetchPoint(c.lat, c.lon, startDate, endDate).catch(err => ({ error: err.message, coordinates: c })));
    const results = await Promise.all(fetchPromises);

    // filtrar errores
    const success = results.filter(r => !r.error);
    if (success.length === 0) {
      return res.status(502).json({ code: 502, description: "Todas las consultas a NASA POWER fallaron", data: results });
    }

    const aggregated = aggregatePoints(success);

    const payload = {
      code: 200,
      description: "Exitoso - agregado de puntos cercanos",
      data: {
        center: { lat, lon },
        sampledPoints: success.map(s => s.coordinates),
        range: { start: startDate, end: endDate },
        aggregated
      }
    };

    mcache.put(cacheKey, payload, CACHE_TTL_MS);
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ code: 500, description: "Error interno", data: err.message });
  }
}
