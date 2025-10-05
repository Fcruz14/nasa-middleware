import fetch from "node-fetch";
import compression from "compression";
import mcache from "memory-cache";

const compressionMiddleware = compression();

// Cache manual (10 min)
const cache = (durationSec) => (req, res, next) => {
  const key = "__nasa__" + req.url;
  const cached = mcache.get(key);
  if (cached) {
    console.log("⚡ Respuesta desde caché:", req.url);
    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(cached);
  }

  res.sendResponse = res.send;
  res.send = (body) => {
    mcache.put(key, body, durationSec * 1000);
    res.sendResponse(body);
  };
  next();
};

// Adaptador para middlewares en Vercel
const runMiddleware = (req, res, fn) =>
  new Promise((resolve, reject) => {
    fn(req, res, (result) => (result instanceof Error ? reject(result) : resolve(result)));
  });

export default async function handler(req, res) {
  await runMiddleware(req, res, compressionMiddleware);
  await runMiddleware(req, res, cache(600));

  const { lat, lon, start, end } = req.query;

  if (!lat || !lon || !start || !end) {
    return res.status(400).json({
      code: 400,
      description: "Faltan parámetros: ?lat=-12.05&lon=-77.03&start=20250101&end=20250105",
      data: null,
    });
  }

  try {
    const parameters = [
      "T2M", "T2M_MAX", "T2M_MIN",
      "PRECTOT", "ALLSKY_SFC_SW_DWN",
      "WS2M", "WD2M", "RH2M", "PS",
    ].join(",");

    const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=${parameters}&start=${start}&end=${end}&latitude=${lat}&longitude=${lon}&format=JSON&community=AG`;

    console.time("NASA_FETCH");
    const response = await fetch(url, { headers: { "Connection": "keep-alive" } });
    console.timeEnd("NASA_FETCH");

    const raw = await response.text();
    if (!response.ok) {
      console.error("❌ Error NASA POWER:", response.status, raw);
      return res.status(response.status).json({
        code: response.status,
        description: `Fallo NASA POWER (${response.statusText})`,
        data: null,
      });
    }

    const data = JSON.parse(raw);
    const daily = data?.properties?.parameter || {};
    const result = Object.keys(daily).map(k => ({
      variable: k,
      values: daily[k],
    }));

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({
      code: 200,
      description: "Exitoso (cacheado si repites coordenadas)",
      data: { coordinates: { lat, lon }, range: { start, end }, parameters: result },
    });

  } catch (err) {
    console.error("💥 Error interno:", err.message);
    return res.status(500).json({
      code: 500,
      description: "Error interno del servidor",
      data: null,
    });
  }
}
