import fetch from "node-fetch";
import mcache from "memory-cache";

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_POINTS = 25; // 5x5 grid
const GRID_STEP = 0.03; // ~3 km por paso (más amplio que antes)
const NOISE_PERCENT = 1; // ±1% para variar los valores

function buildNearbyCoords(lat, lon, maxPoints = MAX_POINTS, step = GRID_STEP) {
  const centerLat = parseFloat(lat);
  const centerLon = parseFloat(lon);
  const coords = [];
  const offsets = [-2, -1, 0, 1, 2]; // 5x5 grid

  for (let i of offsets) {
    for (let j of offsets) {
      if (coords.length >= maxPoints) break;
      coords.push({ lat: +(centerLat + i*step).toFixed(6), lon: +(centerLon + j*step).toFixed(6) });
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
  const cacheKey = `__nasa_point__${lat}_${lon}_${startDate}_${endDate}`;
  const cached = mcache.get(cacheKey);
  if (cached) return cached;

const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=${parameters}&start=${startDate}&end=${endDate}&latitude=${lat}&longitude=${lon}&format=JSON`;  const response = await fetch(url, { headers: { Connection: "keep-alive" } });
  if (!response.ok) throw new Error(`NASA POWER ${response.status} ${response.statusText}`);

  const data = await response.json();
  const daily = data?.properties?.parameter || {};

  for (const key of Object.keys(daily)) {
    for (const date of Object.keys(daily[key])) {
      let val = Number(daily[key][date]);
      if (!isNaN(val) && val !== -999) {
        const factor = 1 + (Math.random() - 0.5) * (NOISE_PERCENT/100);
        daily[key][date] = parseFloat((val * factor).toFixed(2));
      }
    }
  }

  const res = { coordinates: { lat, lon }, daily };
  mcache.put(cacheKey, res, CACHE_TTL_MS);
  return res;
}

function aggregatePointsMean(points) {
  const vars = {};
  for (const p of points) {
    for (const v of Object.keys(p.daily)) {
      if (!vars[v]) vars[v] = {};
      for (const [date, val] of Object.entries(p.daily[v])) {
        if (!vars[v][date]) vars[v][date] = [];
        const n = Number(val);
        if (!Number.isNaN(n) && n !== -999) vars[v][date].push(n);
      }
    }
  }

  const aggregated = {};
  for (const [v, dates] of Object.entries(vars)) {
    aggregated[v] = {};
    for (const [date, arr] of Object.entries(dates)) {
      if (arr.length === 0) continue;
      const mean = arr.reduce((a,b)=>a+b,0)/arr.length;
      aggregated[v][date] = parseFloat(mean.toFixed(2));
    }
  }
  return aggregated;
}

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
  if (!lat || !lon) return res.status(400).json({ code: 400, description: "Faltan parámetros lat/lon", data: null });

  const today = new Date();
  const todayStr = today.toISOString().slice(0,10).replace(/-/g,'');
  const defaultStart = new Date(); defaultStart.setDate(defaultStart.getDate()-7);
  const defaultStartStr = defaultStart.toISOString().slice(0,10).replace(/-/g,'');
  const startDate = start || defaultStartStr;
  const endDate = end || todayStr;

  const cacheKey = "__nasa__agg__" + req.url;
  const cached = mcache.get(cacheKey);
  if (cached) return res.status(200).json(cached);

  try {
    const coords = buildNearbyCoords(lat, lon, MAX_POINTS, GRID_STEP);
    const toFetch = (grid === "1") ? [coords[Math.floor(coords.length/2)]] : coords;

    const fetchPromises = toFetch.map(c => fetchPoint(c.lat, c.lon, startDate, endDate).catch(err => ({ error: err.message, coordinates: c })));
    const results = await Promise.all(fetchPromises);

    const success = results.filter(r => !r.error);
    if (success.length === 0) return res.status(502).json({ code:502, description:"Todas las consultas a NASA POWER fallaron", data:results });

    const aggregated = aggregatePointsMean(success);

    const allDates = new Set();
    for (const v of Object.keys(aggregated)) {
    for (const date of Object.keys(aggregated[v])) {
        allDates.add(date);
    }
    }
    const sortedDates = Array.from(allDates).sort(); 
    const latestDate = sortedDates.length > 0 ? sortedDates[sortedDates.length - 1] : null;

    const simplifiedParameters = Object.keys(aggregated).map(v => {
    const valuesObj = aggregated[v];
    const value = latestDate && valuesObj[latestDate] != null ? valuesObj[latestDate] : null;
    return {
        variable: v,
        value: value !== null ? parseFloat(value.toFixed(2)) : null
    };
    });

    const payload = {
    code: 200,
    description: "Exitoso - valor más reciente por variable",
    data: {
        coordinates: { lat: parseFloat(lat), lon: parseFloat(lon) },
        date: latestDate, 
        parameters: simplifiedParameters
    }
    };

    mcache.put(cacheKey, payload, CACHE_TTL_MS);
    return res.status(200).json(payload);

  } catch(err) {
    return res.status(500).json({ code:500, description:"Error interno", data: err.message });
  }
}
