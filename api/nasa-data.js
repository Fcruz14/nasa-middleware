import fetch from "node-fetch";
import mcache from "memory-cache";

const CACHE_TTL_MS = 10 * 60 * 1000;

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

  const { lat, lon, start, end } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ code: 400, description: "Faltan parámetros lat/lon", data: null });
  }

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10).replace(/-/g, "");
  const defaultStart = new Date();
  defaultStart.setDate(defaultStart.getDate() - 7);
  const defaultStartStr = defaultStart.toISOString().slice(0, 10).replace(/-/g, "");
  const startDate = start || defaultStartStr;
  const endDate = end || todayStr;

  const cacheKey = "__nasa__" + req.url;
  const cached = mcache.get(cacheKey);
  if (cached) return res.status(200).json(cached);

  try {
    const parameters = [
      "T2M","T2M_MAX","T2M_MIN",
      "PRECTOT","ALLSKY_SFC_SW_DWN",
      "WS2M","WD2M","RH2M","PS"
    ].join(",");

    const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=${parameters}&start=${startDate}&end=${endDate}&latitude=${lat}&longitude=${lon}&format=JSON&community=AG`;

    const response = await fetch(url, { headers: { Connection: "keep-alive" } });
    const raw = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        code: response.status,
        description: `Fallo NASA POWER (${response.statusText})`,
        data: null,
      });
    }

    const data = JSON.parse(raw);
    const daily = data?.properties?.parameter || {};
    const result = Object.keys(daily).map(k => ({ variable: k, values: daily[k] }));

    const payload = {
      code: 200,
      description: "Exitoso",
      data: { coordinates: { lat, lon }, range: { start: startDate, end: endDate }, parameters: result }
    };

    mcache.put(cacheKey, payload, CACHE_TTL_MS);
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ code: 500, description: "Error interno", data: null });
  }
}
