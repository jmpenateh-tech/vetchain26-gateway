import express from "express";
import cors from "cors";
import { resolveSecret, verifyToken, bearer } from "./jwt.js";

const app = express();
const PORT = process.env.PORT || 3000;
// Configurables por entorno. En Render gratis los servicios "se duermen" y tardan
// ~1 minuto en despertar, por eso render.yaml sube PROXY_TIMEOUT_MS.
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS) || 15000;
const HEALTH_TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS) || 2000;
// /health?wake=1 espera hasta este tiempo a que cada servicio despierte (Render gratis).
const WAKE_TIMEOUT_MS = Number(process.env.WAKE_TIMEOUT_MS) || Math.min(PROXY_TIMEOUT_MS, 60000);
const JWT_SECRET = resolveSecret("gateway");

// CORS
// - CORS_ORIGIN="*"  -> abierto (solo permitido fuera de producción; es el valor local de docker-compose).
// - CORS_ORIGIN="https://a.com,https://b.com" -> solo esos orígenes.
// - En producción (NODE_ENV=production) el gateway NO arranca si CORS_ORIGIN está
//   vacío o es "*": así un despliegue no queda abierto por olvidar la variable.
// - Fuera de producción, vacío se comporta como "*" (compatibilidad con versiones anteriores).
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const corsOrigins = (process.env.CORS_ORIGIN || "").split(",").map((o) => o.trim()).filter(Boolean);
const corsOpen = corsOrigins.length === 0 || corsOrigins.includes("*");
if (IS_PRODUCTION && corsOpen) {
  console.error(
    "[gateway] CORS_ORIGIN debe contener el/los dominio(s) del frontend en producción " +
    "(p. ej. https://vetchain-app.vercel.app). Valor actual: " + JSON.stringify(process.env.CORS_ORIGIN || "")
  );
  process.exit(1);
}
app.use(cors(corsOpen ? undefined : { origin: corsOrigins }));
console.log(`[gateway] CORS: ${corsOpen ? "abierto (desarrollo)" : corsOrigins.join(", ")}`);
app.use(express.json());

// Render Blueprints (fromService/property: hostport) inyectan solo "host:port",
// sin esquema. En Docker Compose las variables ya traen "http://..." completo,
// así que esto no cambia nada localmente; solo evita tener que hardcodear el
// hash interno que Render asigna a cada servicio.
const withScheme = (url) => (/^https?:\/\//.test(url) ? url : `http://${url}`);

const services = {
  auth: withScheme(process.env.AUTH_SERVICE_URL || "localhost:3001"),
  manufacturing: withScheme(process.env.MANUFACTURING_URL || "localhost:3002"),
  distribution: withScheme(process.env.DISTRIBUTION_URL || "localhost:3003"),
  traceability: withScheme(process.env.TRACEABILITY_URL || "localhost:3004"),
  dispensing: withScheme(process.env.DISPENSING_URL || "localhost:3005"),
  fraud: withScheme(process.env.FRAUD_URL || "localhost:3006"),
  recall: withScheme(process.env.RECALL_URL || "localhost:3007"),
  notification: withScheme(process.env.NOTIFICATION_URL || "localhost:3008"),
  analytics: withScheme(process.env.ANALYTICS_URL || "localhost:3009"),
};

app.get("/", (_, res) =>
  res.json({
    service: "api-gateway",
    status: "ok",
    message: "API Gateway funcionando correctamente",
    routes: Object.keys(services),
  })
);

// /health          -> respuesta rápida (2 s por servicio).
// /health?wake=1   -> además "despierta" a los servicios dormidos (Render gratis) y
//                     espera hasta WAKE_TIMEOUT_MS. El frontend la llama al abrir la app
//                     para que los 9 servicios arranquen EN PARALELO y no uno a uno.
app.get("/health", async (req, res) => {
  const wake = req.query.wake === "1" || req.query.wake === "true";
  const timeout = wake ? WAKE_TIMEOUT_MS : HEALTH_TIMEOUT_MS;
  const result = { gateway: "ok", services: {} };
  await Promise.all(
    Object.entries(services).map(async ([name, url]) => {
      try {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeout) });
        result.services[name] = r.ok ? "ok" : "down";
      } catch {
        result.services[name] = "down";
      }
    })
  );
  res.json(result);
});

async function proxy(base, path, req, res) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (req.headers.authorization) headers.Authorization = req.headers.authorization;
    // Identidad ya verificada por el gateway, por si un servicio la necesita.
    if (req.user) {
      headers["X-User-Id"] = String(req.user.sub);
      headers["X-User-Role"] = String(req.user.role);
      headers["X-User-Name"] = encodeURIComponent(String(req.user.name || ""));
    }
    const hasBody = !["GET", "HEAD"].includes(req.method) && req.body !== undefined;

    const r = await fetch(`${base}${path}`, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text }; }
    res.status(r.status).json(data);
  } catch (e) {
    console.error("Gateway proxy error:", e.message);
    if (e.name === "TimeoutError") {
      return res.status(504).json({ error: "El microservicio tardó demasiado en responder" });
    }
    res.status(502).json({ error: "Microservicio no disponible" });
  }
}

// -----------------------------------------------------------------------------
// Autorización (VetChain 2.4)
// Todas las rutas de negocio exigen un token válido (Authorization: Bearer ...),
// salvo el login. Las operaciones de escritura solo las puede hacer el rol que
// las ejecuta en la cadena real. Cualquier escritura que no esté en la lista se
// rechaza (lista blanca).
// -----------------------------------------------------------------------------
const PUBLIC_ROUTES = [["POST", /^\/auth\/login\/?$/], ["POST", /^\/auth\/register\/?$/]];
const WRITE_RULES = [
  // [métodos, ruta, roles permitidos]
  [["POST", "PATCH"], /^\/auth\/users(\/|$)/, ["admin"]],
  [["POST"], /^\/auth\/me\/password\/?$/, ["admin", "fabricante", "distribuidor", "veterinaria"]],
  [["POST"], /^\/manufacturing\/batches(\/|$)/, ["fabricante"]],
  [["POST"], /^\/recall\/recalls\/?$/, ["fabricante"]],
  [["POST", "PATCH"], /^\/distribution\/(shipments|custody-transfers)(\/|$)/, ["distribuidor"]],
  [["POST"], /^\/dispensing\/dispensations\/?$/, ["veterinaria"]],
  [["PATCH"], /^\/fraud\/fraud-alerts\/[^/]+\/?$/, ["admin"]],
];
const READ_RULES = [
  [/^\/auth\/users(\/|$)/, ["admin"]],
];

function authorize(req, res, next) {
  const path = req.path;
  const method = req.method;
  if (method === "OPTIONS") return next();
  if (PUBLIC_ROUTES.some(([m, re]) => m === method && re.test(path))) return next();

  const user = verifyToken(bearer(req), JWT_SECRET);
  if (!user) return res.status(401).json({ error: "Sesión no válida o expirada. Inicia sesión de nuevo." });
  req.user = user;

  if (method === "GET" || method === "HEAD") {
    const rule = READ_RULES.find(([re]) => re.test(path));
    if (rule && !rule[1].includes(user.role)) return res.status(403).json({ error: "Tu rol no tiene acceso a esta información" });
    return next();
  }
  const rule = WRITE_RULES.find(([methods, re]) => methods.includes(method) && re.test(path));
  if (!rule) return res.status(403).json({ error: "Operación no permitida" });
  if (!rule[2].includes(user.role)) {
    return res.status(403).json({ error: "Tu rol no tiene permiso para esta acción" });
  }
  next();
}
app.use(authorize);

// El prefijo se quita: /manufacturing/batches -> {MANUFACTURING}/batches
function route(prefix, key) {
  app.use(prefix, async (req, res) => {
    const path = req.originalUrl.slice(prefix.length) || "/";
    await proxy(services[key], path, req, res);
  });
}

route("/auth", "auth");
route("/manufacturing", "manufacturing");
route("/distribution", "distribution");
route("/traceability", "traceability");
route("/dispensing", "dispensing");
route("/fraud", "fraud");
route("/recall", "recall");
route("/notifications", "notification");
route("/analytics", "analytics");

app.use((_req, res) => res.status(404).json({ error: "Ruta no encontrada" }));
app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "JSON inválido en el cuerpo de la petición" });
  }
  console.error(err);
  res.status(500).json({ error: "Error interno del gateway" });
});

app.listen(PORT, () => console.log(`API Gateway running on http://localhost:${PORT}`));
