# Despliegue y operación — VetChain 3.2

Este documento describe cómo se despliega VetChain, qué se verifica en cada cambio y
cómo se revierte. Es la fuente de verdad operativa; `render.yaml` de cada repositorio
documenta la configuración esperada de su servicio.

## 1. Arquitectura desplegada

Un repositorio por servicio (no hay monorepo). El único punto de entrada público es el
gateway; el resto de los servicios también tienen URL pública, pero exigen JWT válido.

| Servicio | Repositorio | Tipo | Región | URL | Base de datos |
| --- | --- | --- | --- | --- | --- |
| Gateway | `vetchain26-gateway` | Docker | oregon | https://vc26-gateway.onrender.com | — |
| Auth | `vetchain26-auth` | Docker | oregon | https://vc26-auth.onrender.com | `neondb` |
| Manufacturing | `vetchain26-manufacturing` | Docker | oregon | https://vc26-manufacturing.onrender.com | `manufacturing_db` |
| Distribution | `vetchain26-distribution` | Docker | oregon | https://vc26-distribution.onrender.com | `distribution_db` |
| Traceability | `vetchain26-traceability` | Docker | oregon | https://vc26-traceability.onrender.com | `traceability_db` |
| Dispensing | `vetchain26-dispensing` | Docker | oregon | https://vc26-dispensing.onrender.com | `dispensing_db` |
| Fraud | `vetchain26-fraud` | Docker | oregon | https://vc26-fraud.onrender.com | `fraud_db` |
| Recall | `vetchain26-recall` | Docker | oregon | https://vc26-recall.onrender.com | `recall_db` |
| Notification | `vetchain26-notification` | Docker | oregon | https://vc26-notification.onrender.com | `notification_db` |
| Analytics | `vetchain26-analytics` | Docker | oregon | https://vc26-analytics.onrender.com | `analytics_db` |
| Communication | `vetchain26-communication` | Docker | ohio | https://vetchain26-communication.onrender.com | `communication_db` |
| Web | `vetchain26-web` | Static | — | https://vc26-web.onrender.com | — |

Infraestructura compartida:

- **PostgreSQL**: Neon, proyecto `vetchain` (`morning-shadow-15061215`), rama
  `br-falling-art-b5mz3veh`, PostgreSQL 18, `aws-us-east-2`. Una sola instancia con una
  base por servicio; cada servicio elige la suya con `DB_NAME` sobre la misma
  `DATABASE_URL`.
- **RabbitMQ**: exchange `vetchain.events` (fanout). Los servicios publican y consumen
  eventos de negocio (`batch.created`, `custody.transferred`, `unit.dispensed`,
  `recall.initiated`, `fraud.alert`, ...).

## 2. Flujo de un cambio

```
push a main
  └─ 1. GitHub Actions «ci»: npm ci → node --check → docker build → contenedor + /health
  └─ 2. Render (solo si los checks pasaron): build de la imagen → deploy → /health
```

El workflow `ci` de cada repositorio:

1. instala dependencias con el lockfile (`npm ci`);
2. valida la sintaxis de todos los `.js`/`.mjs` versionados;
3. construye la misma imagen Docker que usa Render;
4. arranca el contenedor contra PostgreSQL y RabbitMQ efímeros y exige `200` en
   `/health` (en auth, además, `prisma contract emit`).

Si el build de Render falla, Render **mantiene vivo el deploy anterior**: un commit
roto no tumba el servicio.

## 3. Verificación después de desplegar

```bash
# Estado agregado de los 10 backends (despierta los servicios dormidos)
curl -s "https://vc26-gateway.onrender.com/health?wake=1"

# El gateway responde
curl -s https://vc26-gateway.onrender.com/

# CORS: el origen del frontend debe estar permitido y uno ajeno rechazado
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://vc26-web.onrender.com" \
  https://vc26-gateway.onrender.com/
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://evil.example" \
  https://vc26-gateway.onrender.com/

# Un servicio directo debe rechazar sin token
curl -s -o /dev/null -w "%{http_code}\n" https://vc26-traceability.onrender.com/batches
```

Resultado esperado: todos los servicios en `ok`, gateway `200`, CORS permitido,
origen ajeno sin cabecera `Access-Control-Allow-Origin`, servicio directo `401`.

## 4. Configuración de Render

Aplicada en los 12 servicios (2026-10-28):

1. **Health Check Path**: `/health` en los 11 servicios web. Render solo marca el
   deploy como `live` cuando `/health` responde `200`; si no, falla y conserva la
   versión anterior.
2. **Auto-Deploy**: `After CI Checks Pass` (`autoDeployTrigger: checksPass`). Render no
   despliega hasta que los checks de GitHub del commit estén en verde.

Pendiente, solo por dashboard (la API no lo acepta):

3. **Settings → Notify on Fail**: activar el correo del responsable.

`render.yaml` no modifica servicios creados desde el dashboard: solo aplica al adoptar
el repositorio como Blueprint. Ya refleja esta configuración, así que una adopción
futura no la revierte.

> Advertencia sobre Blueprints: adoptar `render.yaml` crea servicios **nuevos**. No
> hacerlo sobre los actuales sin planificar la migración de variables y el cambio de
> URLs; de lo contrario quedarían duplicados.

## 5. Variables de entorno

Cada microservicio (los que usan `common.js`):

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `DATABASE_URL` | sí | Cadena directa de Neon (sin `-pooler`). |
| `DB_NAME` | sí (salvo auth) | Base del servicio dentro de la instancia compartida. |
| `JWT_SECRET` | sí | Mismo valor en los 12 servicios; si falta en producción el proceso no arranca. |
| `RABBITMQ_URL` | sí | Cadena `amqp://` del broker. |
| `AUTH_SERVICE_URL` | sí | URL interna de auth (validación de sesión y ámbito). |
| `DB_POOL_MAX` | no | Conexiones por servicio (por defecto 10; en plan gratis conviene 5). |

Gateway: `CORS_ORIGIN` (obligatoria en producción, no puede ser `*`), `JWT_SECRET`,
`AUTH_SERVICE_URL`, `MANUFACTURING_URL`, `DISTRIBUTION_URL`, `TRACEABILITY_URL`,
`DISPENSING_URL`, `FRAUD_URL`, `RECALL_URL`, `NOTIFICATION_URL`, `ANALYTICS_URL`,
`COMMUNICATION_URL`, `TRUST_PROXY=1`, `PROXY_TIMEOUT_MS`, `WAKE_TIMEOUT_MS`.

Auth: `DATABASE_URL`, `JWT_SECRET`, `SEED_DEMO_USERS=false` en producción. Ver
`.env.example` del repositorio para el resto.

## 6. Rollback

1. **Aplicación**: Render → servicio → *Deploys* → elegir el deploy anterior →
   *Rollback*. El rollback es inmediato y no requiere rebuild.
2. **Base de datos**: Neon conserva *instant restore* de 6 horas en el plan gratuito
   (rama → *Restore*). Para cambios de esquema, hacer un snapshot manual antes:

   ```bash
   curl -X POST "https://console.neon.tech/api/v2/projects/$PROJECT_ID/branches/$BRANCH_ID/snapshot" \
     -H "Authorization: Bearer $NEON_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"name":"antes-de-migracion"}'
   ```

3. Verificar después del rollback con los comandos de la sección 3.

## 7. Respaldos

- Plan gratuito de Neon: *point-in-time restore* de 6 horas; los snapshots manuales se
  pueden crear por API o consola y se conservan hasta borrarlos.
- Los snapshots **programados** requieren plan pago. Mientras no se actualice, crear un
  snapshot manual antes de cada migración y uno semanal como mínimo.
- Existe un snapshot base: `manual-baseline-2026-10-28`.

## 8. Gate de producción

Activo desde 2026-10-28. Un push a `main` sigue este orden:

```
push → GitHub Actions «ci» (job verify)
     → si verify falla: Render NO despliega (el servicio queda con la versión anterior)
     → si verify pasa: Render construye y despliega, y exige 200 en /health
```

Validado con un commit real en `traceability`: durante los 30 s que tardó CI, Render no
creó ningún deploy; al pasar los checks, arrancó el build y quedó `live`.

Consecuencias operativas:

- **Todo commit a `main` debe generar checks.** El workflow no tiene filtros de rutas,
  así que cualquier cambio los genera. No agregar `paths:` al workflow o los commits
  que no lo disparen se desplegarían sin verificación.
- Si CI se cae por infraestructura (no por código), el deploy queda esperando; re-ejecutar
  el workflow (`Re-run jobs`) destraba el despliegue sin tocar código.
- El gate no impide pushear directo a `main`: impide que ese push llegue a producción
  sin CI en verde. Para revisión obligatoria por PR hace falta GitHub Pro (la protección
  de ramas en repos privados es de plan pago).

## 9. Servicios obsoletos (eliminar)

Siguen existiendo y con *Auto-Deploy* activo sobre repositorios viejos:

- `vetchain-manufacturing-v2`, `vetchain-distribution-v2`, `vetchain-dispensing-v2`,
  `vetchain-traceability-v2`, `vetchain-recall-v2`, `vetchain-fraud-v2` (activos).
- `vetchain-manufacturing`, `vetchain-distribution`, `vetchain-traceability`,
  `vetchain-dispensing`, `vetchain-recall`, `vetchain-fraud` (suspendidos).

Eliminarlos (o al menos desactivar su Auto-Deploy) evita despliegues accidentales desde
los repositorios antiguos.

## 10. Checklist de un cambio

- [ ] Rama + PR (no push directo a `main`).
- [ ] CI en verde (`verify`).
- [ ] Si hay migración: snapshot manual en Neon antes del merge.
- [ ] Merge a `main`; esperar deploy de Render.
- [ ] Ejecutar la verificación de la sección 3.
- [ ] Si falla: rollback de Render y, si tocó datos, restore de Neon.
