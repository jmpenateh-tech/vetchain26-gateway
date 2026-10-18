# api-gateway — VetChain

Punto de entrada único del sistema VetChain. Recibe todas las peticiones del frontend, valida el
token, aplica las reglas de acceso por rol y **enruta** la petición al microservicio correspondiente.

## Responsabilidad en la arquitectura

El API Gateway es el **único servicio público** de la plataforma. Esconde la topología interna
(los 10 microservicios) detrás de una sola URL y centraliza las preocupaciones transversales:

- **Enrutamiento por prefijo**: `/auth`, `/manufacturing`, `/distribution`, `/traceability`,
  `/dispensing`, `/fraud`, `/recall`, `/notifications`, `/analytics`, `/chat`.
- **Autenticación**: verifica el JWT (`jwt.js`) y exige `Authorization: Bearer <token>` en todo
  salvo las rutas públicas (`POST /auth/login` y `POST /auth/register`).
- **Autorización por rol** y propagación de la identidad a los servicios internos.
- **CORS** y **auditoría** de las peticiones.
- **Estado agregado** (`GET /health`) de todos los servicios.

Los microservicios nunca se exponen directamente: confían en el Gateway y validan el token por su
cuenta contra `auth-service`. El Gateway **elimina el prefijo** antes de reenviar
(`/manufacturing/batches` → `http://manufacturing-service:3002/batches`).

## Tecnologías

| Componente | Versión |
|---|---|
| Node.js | ≥ 18 |
| Express | ^5.2.1 |
| cors | ^2.8.5 |
| Módulos | ESM (`type: module`) |
| JWT | `crypto` nativo (sin dependencias externas) |

## Instalación y ejecución

**Método oficial (recomendado): Docker Compose**, desde la raíz del proyecto. Levanta el Gateway
junto con todos los servicios, PostgreSQL, RabbitMQ y el frontend:

```bash
docker compose up -d --build --wait
```

**Ejecución directa del servicio** (solo si desarrollas fuera de Docker):

```bash
npm install
node index.js        # o: npm start
```

El Gateway arranca en el puerto `PORT` (3000 por defecto).

## Endpoints principales

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/` | Identificación del servicio. |
| GET | `/health` | Estado agregado de todos los microservicios. |
| ANY | `/auth/*` | Reenvía a `auth-service`. |
| ANY | `/manufacturing/*` | Reenvía a `manufacturing-service`. |
| ANY | `/distribution/*` | Reenvía a `distribution-service`. |
| ANY | `/traceability/*` | Reenvía a `traceability-service`. |
| ANY | `/dispensing/*` | Reenvía a `dispensing-service`. |
| ANY | `/fraud/*` | Reenvía a `fraud-service`. |
| ANY | `/recall/*` | Reenvía a `recall-service`. |
| ANY | `/notifications/*` | Reenvía a `notification-service`. |
| ANY | `/analytics/*` | Reenvía a `analytics-service`. |
| ANY | `/chat/*` | Reenvía a `communication-service`. |

Ejemplos:

```bash
GET  http://localhost:3000/health
POST http://localhost:3000/auth/login
POST http://localhost:3000/manufacturing/batches
GET  http://localhost:3000/traceability/verify/VET-...
POST http://localhost:3000/dispensing/dispensations
GET  http://localhost:3000/analytics/transit-time
```

## Variables de entorno

| Variable | Defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto de escucha del Gateway. |
| `NODE_ENV` | `development` | En `production` exige `CORS_ORIGIN` válido. |
| `CORS_ORIGIN` | `*` | Orígenes permitidos (lista separada por comas). |
| `TRUST_PROXY` | — | Confía en el proxy inverso para la IP real. |
| `PROXY_TIMEOUT_MS` | `15000` | Tiempo máximo por petición reenviada. |
| `HEALTH_TIMEOUT_MS` | `2000` | Tiempo máximo por sonda de `/health`. |
| `WAKE_TIMEOUT_MS` | — | Espera a que un servicio dormido (plan free) despierte. |
| `JWT_SECRET` | — | Secreto para verificar los tokens. |
| `AUTH_SERVICE_URL` | `http://localhost:3001` | URL de auth-service. |
| `MANUFACTURING_URL` | `http://localhost:3002` | URL de manufacturing-service. |
| `DISTRIBUTION_URL` | `http://localhost:3003` | URL de distribution-service. |
| `TRACEABILITY_URL` | `http://localhost:3004` | URL de traceability-service. |
| `DISPENSING_URL` | `http://localhost:3005` | URL de dispensing-service. |
| `FRAUD_URL` | `http://localhost:3006` | URL de fraud-service. |
| `RECALL_URL` | `http://localhost:3007` | URL de recall-service. |
| `NOTIFICATION_URL` | `http://localhost:3008` | URL de notification-service. |
| `ANALYTICS_URL` | `http://localhost:3009` | URL de analytics-service. |
| `COMMUNICATION_URL` | `http://localhost:3010` | URL de communication-service. |
| `AUDIT_MAX_PER_MIN` | `300` | Máximo de eventos de auditoría por minuto. |
| `SESSION_CACHE_MS` | `30000` | Caché de validación de sesión. |
| `LOGIN_IP_MAX_FAILURES` | `30` | Intentos fallidos de login por IP antes de bloquear. |

En `NODE_ENV=production` el Gateway **se niega a arrancar** si `CORS_ORIGIN` está vacío o es `*`.

## Base de datos

No usa base de datos propia. Es un servicio **sin estado**.

## Comunicación

- **Entrante**: todo el tráfico del frontend.
- **Saliente**: HTTP/JSON hacia los 10 microservicios.
- No consume ni publica en RabbitMQ.
