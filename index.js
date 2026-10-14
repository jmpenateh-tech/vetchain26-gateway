import express from "express";
import cors from "cors";
import crypto from "crypto";
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
app.disable("x-powered-by");
// TRUST_PROXY = número de proxies delante del gateway (Render: 1). Así req.ip es la IP
// real del cliente para el límite de intentos de login. Local: 0 (sin proxy).
app.set("trust proxy", Number(process.env.TRUST_PROXY) || 0);
app.use((_req, res, next) => {
  // Cabeceras de seguridad básicas para las respuestas JSON de la API.
  res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
  next();
});
app.use(cors(corsOpen ? undefined : { origin: corsOrigins }));
console.log(`[gateway] CORS: ${corsOpen ? "abierto (desarrollo)" : corsOrigins.join(", ")}`);
app.use(express.json({ limit: "2mb" }));

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
  // 2.10: mensajería interna usuario ↔ administrador
  communication: withScheme(process.env.COMMUNICATION_URL || "localhost:3010"),
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

// 2.10: además de JSON, el gateway reenvía
//   - archivos (p. ej. los reportes PDF): se copian Content-Type y Content-Disposition;
//   - flujos de eventos (text/event-stream) del chat, sin límite de tiempo y cerrando la
//     conexión con el microservicio cuando el navegador se desconecta.
const STREAM_PATHS = [/^\/chat\/stream(\?|$)/];
async function proxy(base, path, req, res) {
  const streaming = STREAM_PATHS.some((re) => re.test(path));
  const ctrl = new AbortController();
  if (streaming) res.on("close", () => ctrl.abort());
  try {
    const headers = { "Content-Type": "application/json" };
    if (req.headers.authorization) headers.Authorization = req.headers.authorization;
    // 2.8: IP del cliente para la auditoría (los servicios ven al gateway como origen).
    headers["X-Forwarded-For"] = req.ip || "";
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
      signal: streaming ? ctrl.signal : AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });

    const type = r.headers.get("content-type") || "";
    if (type.includes("text/event-stream") && r.body) {
      res.status(r.status).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
      res.flushHeaders?.();
      try { for await (const chunk of r.body) res.write(chunk); } catch { /* el navegador cerró la conexión */ }
      return res.end();
    }
    if (type && !type.includes("application/json")) {
      const buf = Buffer.from(await r.arrayBuffer());
      const pass = { "Content-Type": type, "Content-Length": String(buf.length) };
      const disp = r.headers.get("content-disposition");
      if (disp) pass["Content-Disposition"] = disp;
      const partial = r.headers.get("x-report-partial");
      if (partial) pass["X-Report-Partial"] = partial;
      pass["Access-Control-Expose-Headers"] = "Content-Disposition, X-Report-Partial";
      return res.status(r.status).set(pass).end(buf);
    }
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text }; }
    res.status(r.status).json(data);
  } catch (e) {
    if (streaming && ctrl.signal.aborted) return; // el navegador cerró el flujo del chat
    console.error("Gateway proxy error:", e.message);
    if (res.headersSent) return res.end();
    if (e.name === "TimeoutError") {
      return res.status(504).json({ error: "El microservicio tardó demasiado en responder" });
    }
    res.status(502).json({ error: "Microservicio no disponible" });
  }
}

// -----------------------------------------------------------------------------
// Auditoría (VetChain 2.8): el gateway anota lo que rechaza él mismo (token no
// válido, rol sin permiso, rutas manipuladas, IP bloqueada). Los eventos van
// firmados con HMAC (JWT_SECRET) a POST /internal/audit de auth-service.
// -----------------------------------------------------------------------------
const AUDIT_MAX_PER_MIN = Number(process.env.AUDIT_MAX_PER_MIN) || 300;
let auditWindow = { start: Date.now(), n: 0 };
function sendAudit(req, ev) {
  if (Date.now() - auditWindow.start > 60_000) auditWindow = { start: Date.now(), n: 0 };
  if (++auditWindow.n > AUDIT_MAX_PER_MIN) return;
  const body = JSON.stringify({
    service: "gateway", ip: req.ip, method: req.method, path: req.originalUrl.split("?")[0],
    actor_id: req.user?.sub ?? null, actor_name: req.user?.name || null, actor_role: req.user?.role || null, ...ev,
  });
  const ts = String(Date.now());
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${ts}.${body}`).digest("hex");
  fetch(`${services.auth}/internal/audit`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Audit-Ts": ts, "X-Audit-Signature": sig },
    body, signal: AbortSignal.timeout(5000),
  }).catch((e) => console.error("[gateway] no se pudo enviar el evento de auditoría:", e.message));
}

// -----------------------------------------------------------------------------
// Vigencia de la sesión (VetChain 2.7, A3)
// Además de la firma, el gateway pregunta a auth-service si el token sigue vigente
// (cuenta activa, mismo rol, misma versión de sesión). La respuesta se guarda
// SESSION_CACHE_MS (30 s): un token revocado deja de funcionar en ese plazo.
// -----------------------------------------------------------------------------
const SESSION_CACHE_MS = Number(process.env.SESSION_CACHE_MS) || 30000;
const sessionCache = new Map();
async function checkSession(token) {
  const key = token.slice(-43);
  const hit = sessionCache.get(key);
  if (hit && hit.until > Date.now()) return hit.result;
  let result;
  try {
    const r = await fetch(`${services.auth}/session`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    if (r.ok) result = { ok: true };
    else if (r.status === 401 || r.status === 403) {
      const d = await r.json().catch(() => ({}));
      result = { ok: false, status: 401, error: d.error || "Tu sesión ya no es válida. Inicia sesión de nuevo.", code: d.code || "session_revoked" };
    } else throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error("[gateway] no se pudo validar la sesión:", e.message);
    return { ok: false, status: 503, error: "No se pudo validar la sesión. Intenta de nuevo en unos segundos." };
  }
  if (sessionCache.size > 5000) sessionCache.clear();
  sessionCache.set(key, { result, until: Date.now() + SESSION_CACHE_MS });
  return result;
}

// -----------------------------------------------------------------------------
// Límite de intentos fallidos de login por IP (VetChain 2.7, A2)
// auth-service limita por cuenta; aquí se limita por IP para frenar a quien prueba
// muchas cuentas distintas. Solo cuentan los intentos fallidos (401/429), así un
// grupo detrás de la misma IP (p. ej. la red de la universidad) no se bloquea al
// entrar con normalidad.
// -----------------------------------------------------------------------------
const IP_MAX_FAILURES = Number(process.env.LOGIN_IP_MAX_FAILURES) || 30;
const IP_WINDOW_MS = (Number(process.env.LOGIN_WINDOW_MINUTES) || 15) * 60_000;
const ipFailures = new Map();
function ipLockedMs(ip) {
  const f = ipFailures.get(ip);
  if (!f) return 0;
  const left = f.first + IP_WINDOW_MS - Date.now();
  if (left <= 0) { ipFailures.delete(ip); return 0; }
  return f.count >= IP_MAX_FAILURES ? left : 0;
}
function ipFailure(ip) {
  const f = ipFailures.get(ip);
  if (!f || f.first + IP_WINDOW_MS <= Date.now()) ipFailures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
  if (ipFailures.size > 20000) ipFailures.clear();
}
app.use("/auth/login", (req, res, next) => {
  if (req.method !== "POST") return next();
  const ip = req.ip || "desconocida";
  const left = ipLockedMs(ip);
  if (left) {
    sendAudit(req, { action: "login.ip_blocked", outcome: "blocked", severity: "critical", target: ip,
      message: `Inicio de sesión bloqueado: ${IP_MAX_FAILURES} intentos fallidos desde esta IP` });
    res.set("Retry-After", String(Math.ceil(left / 1000)));
    return res.status(429).json({ error: `Demasiados intentos fallidos desde esta conexión. Espera ${Math.ceil(left / 60000)} minuto(s).`, code: "too_many_attempts" });
  }
  res.on("finish", () => { if (res.statusCode === 401 || res.statusCode === 429) ipFailure(ip); });
  next();
});

// -----------------------------------------------------------------------------
// Autorización (VetChain 2.4, ampliada en 2.7)
// Todas las rutas de negocio exigen un token válido (Authorization: Bearer ...),
// salvo el login. Las operaciones de escritura solo las puede hacer el rol que
// las ejecuta en la cadena real. Cualquier escritura que no esté en la lista se
// rechaza (lista blanca).
// -----------------------------------------------------------------------------
const PUBLIC_ROUTES = [["POST", /^\/auth\/login\/?$/], ["POST", /^\/auth\/register\/?$/]];
// 2.10: jerarquía de administración. ADMINS = admin y master-admin; las rutas exclusivas
// del administrador general usan MASTER. Esta lista es la primera barrera: cada servicio
// vuelve a comprobar el rol Y el ámbito (qué usuarios/datos le corresponden a cada admin).
const MASTER = ["master-admin"];
const ADMINS = ["master-admin", "admin"];
const EVERYONE = ["master-admin", "admin", "fabricante", "distribuidor", "veterinaria"];
const WRITE_RULES = [
  // [métodos, ruta, roles permitidos]
  [["PUT"], /^\/auth\/users\/[^/]+\/admin\/?$/, MASTER],
  [["POST"], /^\/auth\/admins\/[^/]+\/reassign-users\/?$/, MASTER],
  [["POST", "PATCH", "DELETE"], /^\/auth\/users(\/|$)/, ADMINS],
  [["POST"], /^\/auth\/me\/password\/?$/, EVERYONE],
  // 2.8: foto de perfil propia
  [["POST", "DELETE"], /^\/auth\/me\/photo\/?$/, EVERYONE],
  [["POST"], /^\/manufacturing\/batches(\/|$)/, ["fabricante"]],
  // 3.0: catálogo de productos. El fabricante envía y corrige SUS solicitudes; solo la
  // administración (gerente con ámbito o Administrador) aprueba o rechaza. El servicio
  // vuelve a comprobar rol, propiedad, ámbito y estado.
  [["POST"], /^\/manufacturing\/products\/[^/]+\/(approve|reject)\/?$/, ADMINS],
  [["POST"], /^\/manufacturing\/products\/?$/, ["fabricante"]],
  [["PUT"], /^\/manufacturing\/products\/[^/]+\/?$/, ["fabricante"]],
  [["POST"], /^\/recall\/recalls\/?$/, ["fabricante", ...ADMINS]],
  [["POST", "PATCH"], /^\/distribution\/(shipments|custody-transfers)(\/|$)/, ["distribuidor"]],
  [["POST"], /^\/dispensing\/dispensations\/?$/, ["veterinaria"]],
  [["PATCH"], /^\/fraud\/fraud-alerts\/[^/]+\/?$/, ADMINS],
  // 2.10: chat (el servicio decide con quién puede hablar cada cuenta)
  [["POST", "PATCH"], /^\/chat\/(conversations|messages)(\/|$)/, EVERYONE],
];
const READ_RULES = [
  // 3.0: catálogo. Listas propias del fabricante; cola de solicitudes solo para la
  // administración. El detalle y las imágenes los filtra el servicio (dueño/ámbito).
  [/^\/manufacturing\/products\/(mine|approved)\/?$/, ["fabricante"]],
  [/^\/manufacturing\/products\/[^/]+\/expiry-preview\/?$/, ["fabricante"]],
  [/^\/manufacturing\/products\/(summary\/?)?$/, ADMINS],
  [/^\/auth\/admins(\/|$)/, MASTER],
  [/^\/auth\/users(\/|$)/, ADMINS],
  [/^\/auth\/audit(\/|$)/, ADMINS], // 2.8: registro de auditoría (2.10: admin solo su ámbito)
  // 2.7 (M1): alertas de fraude, analítica y plantillas solo para la administración.
  [/^\/fraud(\/|$)/, ADMINS],
  [/^\/analytics\/reports(\/|$)/, ADMINS],
  [/^\/analytics(\/|$)/, MASTER], // contadores globales de la plataforma
  [/^\/notifications\/templates(\/|$)/, ADMINS],
];

async function authorize(req, res, next) {
  // Ruta normalizada: sin distinguir mayúsculas y sin barras dobles, igual que la
  // interpreta Express al enrutar. Una ruta con "." o ".." como segmento se rechaza:
  // el gateway reenvía la ruta original y fetch las resolvería de otra forma.
  let path;
  const badPath = () => {
    sendAudit(req, { action: "request.path_rejected", outcome: "denied", severity: "critical", message: "Ruta manipulada (codificación o segmentos . / ..)" });
    return res.status(400).json({ error: "Ruta no válida" });
  };
  try { path = decodeURIComponent(req.path).toLowerCase().replace(/\/{2,}/g, "/"); }
  catch { return badPath(); }
  if (/(^|\/)\.{1,2}(\/|$)/.test(path)) return badPath();
  const method = req.method;
  if (method === "OPTIONS") return next();
  if (PUBLIC_ROUTES.some(([m, re]) => m === method && re.test(path))) return next();

  const token = bearer(req);
  const user = verifyToken(token, JWT_SECRET);
  if (!user) {
    // Token caducado: algo normal. Token ausente o falsificado: se anota.
    const expired = token && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) && (() => { try { const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url")); return p.exp < Date.now() / 1000; } catch { return false; } })();
    if (!expired) sendAudit(req, { action: "access.unauthenticated", outcome: "denied", severity: token ? "critical" : "warning",
      message: token ? "Token no válido o manipulado" : "Petición sin sesión" });
    return res.status(401).json({ error: "Sesión no válida o expirada. Inicia sesión de nuevo." });
  }
  const session = await checkSession(token);
  if (!session.ok) return res.status(session.status).json({ error: session.error, ...(session.code ? { code: session.code } : {}) });
  req.user = user;

  if (method === "GET" || method === "HEAD") {
    const rule = READ_RULES.find(([re]) => re.test(path));
    if (rule && !rule[1].includes(user.role)) {
      sendAudit(req, { action: "access.denied", outcome: "denied", severity: "warning", message: "Rol sin acceso a esta información" });
      return res.status(403).json({ error: "Tu rol no tiene acceso a esta información" });
    }
    return next();
  }
  const rule = WRITE_RULES.find(([methods, re]) => methods.includes(method) && re.test(path));
  if (!rule) {
    sendAudit(req, { action: "access.denied", outcome: "denied", severity: "critical", message: "Operación de escritura no permitida por el gateway" });
    return res.status(403).json({ error: "Operación no permitida" });
  }
  if (!rule[2].includes(user.role)) {
    sendAudit(req, { action: "access.denied", outcome: "denied", severity: "warning", message: "Rol sin permiso para esta acción" });
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
route("/chat", "communication");

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
