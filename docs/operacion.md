# Operación

Comandos del día a día para trabajar con este stack: arrancar, inspeccionar, resetear, migrar y
desatascar. Todos se ejecutan desde la raíz del repositorio:

```bash
cd /home/mapineda48/Repo/mapineda48/KeyCloak-Demo
```

Muchos ejemplos usan variables del `.env`. Cárgalas en la sesión con:

```bash
set -a; source .env; set +a
```

---

## 1. Comandos del día a día

Los scripts de `package.json` y los objetivos del `Makefile` son equivalentes; usa el que
prefieras.

| pnpm | make | Ejecuta |
|---|---|---|
| `pnpm run up` | `make up` | `docker compose up -d --build` |
| `pnpm run up:full` | `make up-full` | `docker compose --profile full up -d --build` |
| `pnpm run down` | `make down` | `docker compose down` (conserva volúmenes) |
| `pnpm run reset` | `make reset` | `docker compose down -v` (**borra** volúmenes) |
| `pnpm run logs` | `make logs` | `docker compose logs -f` |
| `pnpm run ps` | `make ps` | `docker compose ps` |
| `pnpm dev` | `make dev` | `pnpm -r --parallel dev` (API y SPA fuera de Docker) |
| `pnpm build` | `make build` | `pnpm -r build` |
| `pnpm typecheck` | `make typecheck` | `pnpm -r typecheck` |

> Make no admite `:` en nombres de objetivo, por eso `up:full` se llama `up-full` en el Makefile.

### Trabajar en un solo paquete

```bash
pnpm --filter @erp/app dev          # solo la SPA (http://localhost:5173)
pnpm --filter @erp/api dev          # solo la API con tsx watch (necesita el resto del stack arriba)
pnpm --filter @erp/api typecheck
pnpm --filter @erp/app build
```

El flujo habitual es **infraestructura en Docker + SPA en local**: `docker compose up -d --build`
levanta postgres, keycloak, valkey, azurite y la API; `pnpm --filter @erp/app dev` da recarga en
caliente del frontend.

Si prefieres iterar sobre la API en local, para el contenedor para liberar el puerto 3000:

```bash
docker compose stop api
pnpm --filter @erp/api dev
```

Ojo: la API en local necesita ver a los servicios por `localhost`, no por sus nombres de red
Docker. Ajusta en `.env` (o exporta en la sesión) `DATABASE_URL`, `VALKEY_URL`,
`KEYCLOAK_INTERNAL_ISSUER` y la parte de host de `AZURE_STORAGE_CONNECTION_STRING` para que
apunten a `localhost`.

### Ciclo corto sobre servicios sueltos

```bash
docker compose up -d --build api        # reconstruye y recrea solo la API
docker compose restart api              # reinicio rápido (relanza las migraciones)
docker compose stop keycloak            # parar sin borrar
docker compose ps                       # estado + salud de cada servicio
docker compose config                   # ver el compose ya interpolado con el .env (muy útil)
```

`docker compose config` es la forma más rápida de comprobar qué valor final tienen las variables
derivadas (`DATABASE_URL`, `KEYCLOAK_ISSUER`, `CORS_ORIGINS`, …) sin entrar en ningún contenedor.

Para iterar sobre el **tema de login** (`infra/keycloak/themes/erp`) no hace falta ninguno de
estos comandos: con `start-dev` los temas no se cachean y basta recargar el navegador, salvo que
toques `theme.properties` o añadas archivos. Detalle en la [sección 8](#tema-de-login).

### Comprobaciones de salud

```bash
curl -s http://localhost:3000/health | jq
curl -s http://localhost:3000/health/ready | jq
curl -sf http://localhost:8080/realms/erp/.well-known/openid-configuration >/dev/null && echo "realm erp OK"
```

`/health/ready` devuelve `200` si base de datos, caché, almacenamiento y correo responden, y
`503` si algo falla, con el detalle en `checks`.

---

## 2. Resetear el stack a cero

```bash
docker compose down -v
docker compose up -d --build
```

`down -v` elimina los cuatro volúmenes del proyecto: `pg-data`, `valkey-data`, `azurite-data` y
`keycloak-import`.

### Por qué eso reimporta el realm

Keycloak importa un realm con `--import-realm` **solo si ese realm no existe todavía en su base
de datos**. Si ya existe, lo ignora en silencio: es lo que evita que un reinicio te pise los
cambios hechos por consola.

La base de datos de Keycloak vive dentro del volumen `pg-data`. Por tanto:

| Comando | Qué pasa con el realm |
|---|---|
| `docker compose restart keycloak` | El realm ya existe → **no se importa**. Los cambios de la plantilla no se aplican. |
| `docker compose down` + `up` | `pg-data` sigue ahí → **no se importa**. |
| `docker compose down -v` + `up` | `pg-data` desaparece → Keycloak arranca vacío y **sí importa** `realm-erp.json`. |

El servicio one-shot `keycloak-realm` sí se ejecuta en cada `up`, así que el fichero
`/import/realm-erp.json` del volumen `keycloak-import` **siempre está al día** respecto a la
plantilla y al `.env`. Lo que no se refresca sin `-v` es lo que Keycloak ya guardó en Postgres.

Regla práctica: **cualquier cambio en `infra/keycloak/realm-erp.template.json` o en las variables
`DEMO_*`, `KEYCLOAK_*`, `APP_*_URL` exige `down -v`.** Eso incluye `KEYCLOAK_LOGIN_THEME`, que
alimenta el campo `loginTheme` del realm; para ese caso concreto hay una alternativa en caliente
con `kcadm.sh` que no borra datos, en la [sección 8](#tema-de-login).

Los archivos del tema de login (`infra/keycloak/themes/`) **no** entran en esa regla: van por
bind mount, no por el realm, y se recargan sin reimportar nada.

Un reset borra también las tareas, los adjuntos y la auditoría. Para repoblar, entra en la SPA y
pulsa "Crear datos de ejemplo", o llama a `POST /api/todos/seed-demo`.

### Reset selectivo

```bash
# Solo la base de datos de la aplicación y de Keycloak
docker compose down
docker volume rm erp-demo_pg-data
docker compose up -d --build

# Solo la caché (no rompe nada: se regenera sola)
docker compose exec valkey valkey-cli FLUSHALL

# Solo los adjuntos
docker compose down
docker volume rm erp-demo_azurite-data
docker compose up -d
```

El prefijo `erp-demo_` viene de `COMPOSE_PROJECT_NAME`. Comprueba los nombres reales con
`docker volume ls | grep erp-demo`.

---

## 3. Logs

```bash
docker compose logs -f                      # todo, en vivo
docker compose logs -f api                  # solo la API
docker compose logs -f keycloak
docker compose logs --tail=200 api          # últimas 200 líneas
docker compose logs --since=10m keycloak    # últimos 10 minutos
docker compose logs keycloak-realm          # one-shot: aquí se ve el render del realm
docker compose logs -f api valkey           # varios servicios a la vez
```

La API registra con **pino** (`LOG_LEVEL` en `.env`, por defecto `info`). Para depurar sube el
nivel y recrea:

```bash
LOG_LEVEL=debug docker compose up -d --force-recreate api
docker compose logs -f api
```

Filtros útiles:

```bash
docker compose logs api | grep -i mail          # envíos de correo (incluido el dry-run)
docker compose logs api | grep -i migration     # aplicación de migraciones al arrancar
docker compose logs keycloak | grep -i import   # importación del realm
```

En desarrollo local (`pnpm --filter @erp/api dev`) la salida pasa por `pino-pretty` y sale
legible y coloreada.

---

## 4. PostgreSQL con psql

```bash
set -a; source .env; set +a

# Base de datos de la aplicación
docker compose exec -it postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# Base de datos de Keycloak (identidad)
docker compose exec -it postgres psql -U "$POSTGRES_USER" -d "$KEYCLOAK_DB_NAME"
```

Con valores literales, si prefieres no cargar el `.env`:

```bash
docker compose exec -it postgres psql -U erp -d erp
```

Dentro de `psql`:

```sql
\dn                          -- esquemas
\dt erp.*                    -- tablas del esquema erp
\d erp.todos                 -- estructura de una tabla
\di erp.*                    -- índices
\x on                        -- salida vertical, cómoda para filas anchas

SELECT version, applied_at FROM erp.schema_migrations ORDER BY version;

SELECT id, username, email, last_seen_at FROM erp.users ORDER BY last_seen_at DESC NULLS LAST;

SELECT t.id, t.title, t.status, t.priority, o.username AS owner, a.username AS assignee
  FROM erp.todos t
  JOIN erp.users o ON o.id = t.owner_id
  LEFT JOIN erp.users a ON a.id = t.assignee_id
 ORDER BY t.created_at DESC
 LIMIT 20;

SELECT * FROM erp.v_todo_stats;

SELECT created_at, actor_id, action, entity, entity_id
  FROM erp.audit_log
 ORDER BY created_at DESC
 LIMIT 20;

SELECT a.file_name, a.content_type, a.size_bytes, a.blob_name
  FROM erp.todo_attachments a
 ORDER BY a.created_at DESC;
```

Consultas sueltas sin abrir la sesión interactiva:

```bash
docker compose exec postgres psql -U erp -d erp -c "SELECT count(*) FROM erp.todos;"
docker compose exec postgres psql -U erp -d erp -Atc "SELECT status, count(*) FROM erp.todos GROUP BY status;"
```

Copia de seguridad y restauración:

```bash
docker compose exec postgres pg_dump -U erp -d erp --schema=erp > /tmp/erp-backup.sql
cat /tmp/erp-backup.sql | docker compose exec -T postgres psql -U erp -d erp
```

---

## 5. Valkey con valkey-cli

```bash
docker compose exec -it valkey valkey-cli
```

Comandos útiles dentro de la sesión (o con `docker compose exec valkey valkey-cli <comando>`):

```bash
PING                                    # PONG
DBSIZE                                  # número de claves
SCAN 0 MATCH 'erp:*' COUNT 100          # recorrer claves sin bloquear el servidor
KEYS 'erp:v*:todos:*'                   # cómodo en desarrollo, evítalo en producción
TTL  'erp:v3:todos:<sub>:mine:_:_:1:20' # segundos que le quedan (= CACHE_TTL_SECONDS al crearse)
GET  'erp:v3:todos:<sub>:mine:_:_:1:20' # el JSON cacheado
INFO keyspace
MONITOR                                 # ver en vivo cada comando (Ctrl-C para salir)
FLUSHALL                                # vaciar la caché entera
```

Demostración de la invalidación por versión, paso a paso:

```bash
# 1. Ver la versión actual del namespace 'todos' y las claves existentes
docker compose exec valkey valkey-cli --scan --pattern 'erp:*'

# 2. En otra terminal, mirar en vivo lo que hace la API
docker compose exec valkey valkey-cli MONITOR

# 3. Lanzar dos veces el mismo listado: MISS y luego HIT
curl -si http://localhost:3000/api/todos -H "Authorization: Bearer $TOKEN" | grep -i '^x-cache'
curl -si http://localhost:3000/api/todos -H "Authorization: Bearer $TOKEN" | grep -i '^x-cache'

# 4. Crear una tarea: la API hace INCR sobre la versión (se ve en MONITOR)
curl -s -X POST http://localhost:3000/api/todos -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"title":"prueba de caché"}' >/dev/null

# 5. El mismo listado vuelve a ser MISS, y las claves con la versión anterior siguen ahí
#    (huérfanas) hasta que caduquen por TTL
curl -si http://localhost:3000/api/todos -H "Authorization: Bearer $TOKEN" | grep -i '^x-cache'
```

Vaciar la caché **nunca** provoca pérdida de datos: solo fuerza que el siguiente listado vaya a
PostgreSQL.

---

<a id="listar-blobs-de-azurite"></a>

## 6. Listar blobs de Azurite

La forma más directa es usar el propio SDK desde el contenedor de la API, que ya lo tiene
instalado y tiene la cadena de conexión en su entorno:

```bash
docker compose exec api node --input-type=module -e "
import { BlobServiceClient } from '@azure/storage-blob';
const svc = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const c = svc.getContainerClient(process.env.AZURE_STORAGE_CONTAINER);
for await (const b of c.listBlobsFlat()) {
  console.log(b.properties.contentLength.toString().padStart(9), b.properties.contentType, b.name);
}
"
```

Si la resolución de módulos falla, fuerza el directorio de trabajo del paquete:

```bash
docker compose exec -w /repo/packages/api api node --input-type=module -e "…"
```

Listar solo los adjuntos de una tarea (el prefijo es parte de la convención de nombres,
`todos/<todo_id>/…`):

```bash
docker compose exec api node --input-type=module -e "
import { BlobServiceClient } from '@azure/storage-blob';
const svc = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const c = svc.getContainerClient(process.env.AZURE_STORAGE_CONTAINER);
for await (const b of c.listBlobsFlat({ prefix: 'todos/' + process.argv[1] + '/' })) console.log(b.name);
" "<todo_id>"
```

Contrastar con lo que dice la base de datos (deben coincidir uno a uno):

```bash
docker compose exec postgres psql -U erp -d erp -Atc \
  "SELECT blob_name FROM erp.todo_attachments ORDER BY blob_name;"
```

Con el **Azure CLI** instalado en el host también funciona, sustituyendo el host interno
`azurite` por `127.0.0.1` en la cadena de conexión:

```bash
set -a; source .env; set +a
CONN="${AZURE_STORAGE_CONNECTION_STRING//azurite/127.0.0.1}"
az storage blob list --container-name "$AZURE_STORAGE_CONTAINER" --connection-string "$CONN" -o table
```

Los datos de Azurite persisten en el volumen `azurite-data`; para tirarlos, borra ese volumen
(ver [reset selectivo](#reset-selectivo)).

---

<a id="anadir-una-migracion"></a>

## 7. Añadir una migración

Las migraciones viven en `packages/api/migrations/` con el patrón `NNNN_nombre.sql` y se aplican
**en orden lexicográfico** al arrancar la API. Cada una se registra en `erp.schema_migrations`
con su **checksum**.

### Procedimiento

1. Crea el fichero siguiente en la numeración (cuatro dígitos, nombre descriptivo en inglés):

   ```
   packages/api/migrations/0003_add_todo_tags.sql
   ```

2. Escribe SQL **idempotente donde tenga sentido** y siempre dentro del esquema `erp`:

   ```sql
   -- 0003: etiquetas libres para las tareas
   ALTER TABLE erp.todos
     ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

   CREATE INDEX IF NOT EXISTS todos_tags_idx ON erp.todos USING gin (tags);
   ```

3. Aplícala reiniciando la API (el migrador corre en el arranque):

   ```bash
   docker compose restart api
   docker compose logs --tail=50 api | grep -i migration
   ```

   O, si desarrollas fuera de Docker, simplemente relanza `pnpm --filter @erp/api dev`.

4. Verifica el registro:

   ```bash
   docker compose exec postgres psql -U erp -d erp -c \
     "SELECT version, applied_at FROM erp.schema_migrations ORDER BY version;"
   ```

### Reglas

- **Nunca edites una migración ya aplicada.** El checksum dejaría de coincidir y el arranque
  fallaría con un error de migración modificada. Corrige siempre con un fichero nuevo.
- **No crees `erp.schema_migrations`** en una migración: la crea el propio migrador.
- **No añadas extensiones** para UUID: `gen_random_uuid()` es nativo en PostgreSQL 17.
- Si al escribir la migración te equivocas y aún estás en desarrollo, la salida limpia es
  `docker compose down -v && docker compose up -d --build`. Como último recurso, borra la fila:

  ```bash
  docker compose exec postgres psql -U erp -d erp -c \
    "DELETE FROM erp.schema_migrations WHERE version = '0003_add_todo_tags';"
  ```

  …pero recuerda deshacer también a mano lo que la migración ya hubiera aplicado.

---

<a id="tema-de-login"></a>

## 8. Tema de login

La pantalla de acceso del realm usa un tema Freemarker propio llamado **`erp`**.

### Dónde vive y cómo llega al contenedor

```
infra/keycloak/themes/erp/
├── theme.properties            # types=login
└── login/
    ├── theme.properties        # parent=base, styles, scripts, locales y mapeo de clases kc*
    ├── template.ftl            # layout de pantalla partida (macro registrationLayout)
    ├── login.ftl               # formulario + chuleta de usuarios demo
    ├── footer.ftl  error.ftl  info.ftl
    ├── login-page-expired.ftl  logout-confirm.ftl
    ├── messages/               # messages_es.properties + messages_en.properties
    └── resources/
        ├── css/erp-login.css
        └── js/erp-login.js
```

El servicio `keycloak` de `docker-compose.yml` lo monta en solo lectura:

```yaml
volumes:
  - keycloak-import:/opt/keycloak/data/import
  - ./infra/keycloak/themes:/opt/keycloak/themes:ro
```

Montar encima de `/opt/keycloak/themes` no rompe nada: en la imagen oficial ese directorio **solo
contiene un README**; los temas integrados (`base`, `keycloak`, `keycloak.v2`) viajan dentro de
los JAR del servidor. Por eso `parent=base` se sigue resolviendo y las páginas que el tema `erp`
no sobrescribe (OTP, actualizar contraseña, verificar correo…) las sirve `base` con el mapeo de
clases `kc*` declarado en `login/theme.properties`.

Comprobación de que el montaje existe:

```bash
docker compose exec keycloak ls /opt/keycloak/themes/erp/login
# error.ftl  footer.ftl  info.ftl  login.ftl  login-page-expired.ftl
# logout-confirm.ftl  messages  resources  template.ftl  theme.properties
```

Quién selecciona el tema: el campo `loginTheme` del realm, que sale de
`infra/keycloak/realm-erp.template.json` (`"loginTheme": "__KEYCLOAK_LOGIN_THEME__"`) y que
`render-realm.mjs` sustituye por la variable `KEYCLOAK_LOGIN_THEME` (`.env`, por defecto `erp`).
El mismo bloque activa los idiomas: `internationalizationEnabled: true`,
`supportedLocales: ["es","en"]`, `defaultLocale: "es"`.

### Editar el tema en caliente

Keycloak arranca con `start-dev`, y en ese modo **no cachea los temas**:

| Qué tocas | Qué hace falta |
|---|---|
| Un `.ftl`, `resources/css/erp-login.css`, `resources/js/erp-login.js` | Nada. Guardar y recargar el navegador con `Ctrl+Shift+R` |
| Un `messages_*.properties` | Nada, recargar la página |
| Cualquiera de los dos `theme.properties` | `docker compose restart keycloak` |
| Añadir un archivo o directorio nuevo | `docker compose restart keycloak` |
| Añadir o cambiar el montaje en `docker-compose.yml` | `docker compose up -d --force-recreate keycloak` (un `restart` **no** aplica volúmenes nuevos) |

Para ver la pantalla sin arrancar la SPA, abre <http://localhost:8080/realms/erp/account> en una
ventana privada: la consola de cuenta del realm exige login y usa el mismo tema.

<a id="cambiar-el-tema-de-un-realm-ya-importado"></a>

### Cambiar de tema (o volver al de por defecto)

En `.env`:

```dotenv
KEYCLOAK_LOGIN_THEME=erp          # el tema propio
# KEYCLOAK_LOGIN_THEME=keycloak   # tema integrado clásico
# KEYCLOAK_LOGIN_THEME=keycloak.v2
```

Y después, **una de estas dos vías**:

**A) Reimportar el realm** (limpio, pero borra los datos de la demo):

```bash
docker compose down -v
docker compose up -d --build
```

**B) Aplicarlo en caliente con `kcadm.sh`** (conserva usuarios, tareas, adjuntos y auditoría).
Un realm que ya existe **no** vuelve a importarse, así que editar la plantilla no basta:

```bash
set -a; source .env; set +a

# 1. Autenticarse contra el realm master con el admin de bootstrap.
#    --config fija dónde se guarda el token; /tmp siempre es escribible en el contenedor.
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --config /tmp/kcadm.config \
  --server http://localhost:8080 \
  --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" \
  --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"

# 2. Aplicar tema e idiomas al realm erp (sin tocar nada más)
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update "realms/$KEYCLOAK_REALM" \
  --config /tmp/kcadm.config \
  -s "loginTheme=$KEYCLOAK_LOGIN_THEME" \
  -s 'internationalizationEnabled=true' \
  -s 'supportedLocales=["es","en"]' \
  -s 'defaultLocale=es'

# 3. Verificar
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh get "realms/$KEYCLOAK_REALM" \
  --config /tmp/kcadm.config \
  --fields realm,loginTheme,internationalizationEnabled,supportedLocales,defaultLocale
# {
#   "realm" : "erp",
#   "loginTheme" : "erp",
#   "internationalizationEnabled" : true,
#   "supportedLocales" : [ "es", "en" ],
#   "defaultLocale" : "es"
# }
```

El cambio surte efecto en la siguiente carga de la pantalla de login; no hace falta reiniciar.

Notas:

- Es el admin de la consola (`KC_BOOTSTRAP_ADMIN_*`), no un usuario demo del realm `erp`.
- El token de `kcadm` vive en `/tmp/kcadm.config` **dentro** del contenedor: se pierde al
  recrearlo, y entonces hay que repetir el paso 1.
- Lo mismo se puede hacer por la consola: <http://localhost:8080/admin> → realm `erp` →
  *Realm settings* → *Themes* → *Login theme*.
- Un cambio aplicado con `kcadm` o por consola **no se versiona**. Refléjalo también en `.env` /
  `realm-erp.template.json` para que el siguiente arranque limpio lo conserve.

---

<a id="recuperar-contrasena"></a>

## 9. Recuperar contraseña y correo de Keycloak

### Dos caminos de correo distintos

| Quién envía | Cómo | Qué manda |
|---|---|---|
| La API (`@erp/api`) | API **HTTP** de Resend | Notificaciones de tareas |
| **Keycloak** | **SMTP** | Recuperar contraseña, verificar correo |

Keycloak no habla con la API HTTP de Resend, solo con SMTP. Por eso el realm apunta a
`smtp.resend.com:587` (STARTTLS) y `docker-compose.yml` reutiliza `RESEND_API_KEY` como
contraseña SMTP: un único secreto para los dos caminos.

### Qué controla cada variable

| Variable | Efecto |
|---|---|
| `KEYCLOAK_SMTP_HOST` / `_PORT` | Servidor SMTP (`smtp.resend.com` / `587`) |
| `KEYCLOAK_SMTP_USER` | Siempre `resend` en el relay de Resend |
| `KEYCLOAK_SMTP_FROM` | Remitente; **debe** ser de un dominio verificado |
| `KEYCLOAK_EMAIL_THEME` | Tema de los correos (`erp` = el propio) |
| `DEMO_ADMIN_EMAIL` | Debe ser una dirección real para poder probarlo |

La contraseña SMTP no está en `.env`: sale de `RESEND_API_KEY`.

### Comprobar que el SMTP responde

```bash
python3 - <<'PY'
import smtplib, re, pathlib, ssl
key = re.search(r'^RESEND_API_KEY=(.*)$', pathlib.Path('.env').read_text(), re.M).group(1).strip()
s = smtplib.SMTP('smtp.resend.com', 587, timeout=20)
s.starttls(context=ssl.create_default_context()); s.login('resend', key)
print('AUTH OK'); s.quit()
PY
```

### Aplicarlo a un realm que YA existe

`smtpServer`, `resetPasswordAllowed` y `emailTheme` solo se leen **al importar** el realm. Para
un realm en marcha, sin perder datos:

```bash
set -a; source .env; set +a

docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080 --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"

# Recuperación + tema de correo + caducidad del enlace (30 min)
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update realms/erp \
  -s resetPasswordAllowed=true \
  -s emailTheme=erp \
  -s actionTokenGeneratedByUserLifespan=1800

# SMTP (ojo: es un objeto JSON, no campos sueltos)
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update realms/erp \
  -s "smtpServer={\"host\":\"$KEYCLOAK_SMTP_HOST\",\"port\":\"$KEYCLOAK_SMTP_PORT\",\"from\":\"$KEYCLOAK_SMTP_FROM\",\"fromDisplayName\":\"$KEYCLOAK_SMTP_FROM_DISPLAY_NAME\",\"ssl\":\"false\",\"starttls\":\"true\",\"auth\":\"true\",\"user\":\"$KEYCLOAK_SMTP_USER\",\"password\":\"$RESEND_API_KEY\"}"
```

Cambiar el correo de un usuario:

```bash
UID=$(docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh get users -r erp \
        -q username=admin --fields id | grep -o '"id" : "[^"]*"' | cut -d'"' -f4)
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update "users/$UID" -r erp \
  -s 'email=tu.correo@ejemplo.com' -s 'emailVerified=true'
```

`actionTokenGeneratedByUserLifespan` es un campo **de primer nivel** del realm, no un
`attributes.*`: con `-s attributes.actionToken…` no se aplica y no avisa.

### Dónde viven las pantallas y el correo

```
infra/keycloak/themes/erp/login/login-reset-password.ftl   ← pedir el enlace
infra/keycloak/themes/erp/login/login-update-password.ftl  ← fijar la contraseña
infra/keycloak/themes/erp/email/html/password-reset.ftl    ← cuerpo del correo
infra/keycloak/themes/erp/email/html/template.ftl          ← maqueta común
infra/keycloak/themes/erp/email/messages/                  ← asunto y textos
```

El correo se maqueta con tablas y CSS en línea a propósito: los clientes de correo descartan
`<style>` y las hojas externas.

### Ver el correo enviado sin abrir el buzón

```bash
resend emails list --limit 3
resend emails get <id>            # incluye el HTML y el enlace de acción
```

---

<a id="resolucion-de-problemas"></a>

## 10. Resolución de problemas

### Keycloak tarda mucho en arrancar o aparece `unhealthy`

**Normal la primera vez**: crea su esquema en PostgreSQL e importa el realm; 40–90 segundos es
esperable, y más en la primera descarga de la imagen.

```bash
docker compose ps                      # columna STATUS: (health: starting) → (healthy)
docker compose logs -f keycloak        # busca "Listening on" y "Imported realm erp"
```

Si se queda en `starting` indefinidamente:

- Comprueba que `postgres` está `healthy`: Keycloak depende de él con `service_healthy`.
- Revisa `docker compose logs keycloak-realm`: si el render falló, no hay fichero que importar.
- El healthcheck usa **bash con `/dev/tcp`** contra el puerto de management `9000` y
  `/health/ready`, porque la imagen de Keycloak **no trae `curl` ni `wget`**. Si lo has cambiado
  por `curl`, siempre dará `unhealthy`.

Espera activa desde el host:

```bash
until curl -sf http://localhost:8080/realms/erp/.well-known/openid-configuration >/dev/null; do
  sleep 2
done; echo listo
```

### `401` por audiencia inválida en el token

Síntoma: el login funciona, pero toda llamada a `/api/*` devuelve `401`.

1. Decodifica el token y mira `aud`:

   ```bash
   node -e "
     const [,,t]=process.argv;
     const p=JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString());
     console.log({ iss: p.iss, aud: p.aud, azp: p.azp });
   " "$TOKEN"
   ```

2. `aud` **debe contener `erp-api`**. Si no lo contiene, falta el protocol mapper
   `oidc-audience-mapper` en el cliente `erp-app`, o se ha perdido porque el realm no se
   reimportó. Solución: revisar `infra/keycloak/realm-erp.template.json` y
   `docker compose down -v && docker compose up -d --build`.
3. Comprueba lo que ve la API:

   ```bash
   docker compose config | grep -E 'KEYCLOAK_(ISSUER|INTERNAL_ISSUER|AUDIENCE)'
   ```

   `KEYCLOAK_AUDIENCE` debe valer `erp-api`, y `KEYCLOAK_ISSUER` debe coincidir **carácter a
   carácter** con el `iss` del token (cuidado con `127.0.0.1` frente a `localhost` y con la barra
   final).

### Errores de CORS en el navegador

Mensaje típico: *"has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header"*.

Hay **dos** capas de CORS y hay que mirar ambas:

| Petición bloqueada | Quién decide | Dónde se arregla |
|---|---|---|
| Hacia `localhost:8080` (Keycloak) | *Web origins* del cliente `erp-app` | `realm-erp.template.json`, derivado de `APP_DEV_URL` / `APP_PROD_URL`; requiere `down -v` |
| Hacia `localhost:3000` (API) | `@fastify/cors` con `CORS_ORIGINS` | `.env` (`APP_DEV_URL`, `APP_PROD_URL`) + `docker compose up -d --force-recreate api` |

```bash
docker compose config | grep CORS_ORIGINS
# CORS_ORIGINS: http://localhost:5173,http://localhost:8081
```

Causa habitual: abrir la SPA en `http://127.0.0.1:5173` en lugar de `http://localhost:5173`. Para
el navegador son **orígenes distintos** y ninguno de los dos está configurado para el otro. Usa
siempre `localhost`.

### Puerto ocupado

```
Error: bind: address already in use
```

Identifica al culpable:

```bash
ss -ltnp | grep -E ':(3000|5173|5432|6379|8080|8081|10000|10001|10002)\b'
# alternativa: sudo lsof -i :5432
```

Casos frecuentes:

- **5432**: un PostgreSQL instalado en la máquina. Párate el servicio local
  (`sudo systemctl stop postgresql`) o cambia el mapeo del puerto en `docker-compose.yml`.
- **6379**: un Redis local.
- **8080**: otro contenedor o un Tomcat/Jenkins.
- **5173**: otra instancia de Vite. `vite.config.ts` usa `strictPort: true`, así que **falla en
  vez de saltar al 5174** — es intencionado: la URL de redirección registrada en Keycloak es la
  del 5173 y un puerto distinto rompería el login con `invalid_redirect_uri`.

Restos de una ejecución anterior:

```bash
docker compose ps -a
docker compose down --remove-orphans
```

### El realm no se reimporta porque el volumen ya existe

Síntoma: cambias `realm-erp.template.json` (o una variable `DEMO_*`), reinicias y **no pasa
nada**: el usuario nuevo no existe, el permiso nuevo no aparece en el token.

Causa: Keycloak solo importa un realm que **no** exista ya en su base de datos, y esa base de
datos vive en el volumen `pg-data`, que `docker compose down` (sin `-v`) conserva.

```bash
docker compose down -v
docker compose up -d --build
```

Comprueba que la importación ocurrió:

```bash
docker compose logs keycloak | grep -i "import"
docker compose logs keycloak-realm            # el render debe terminar sin marcadores pendientes
```

Si no quieres perder los datos de la demo, la alternativa es aplicar el cambio a mano en la
consola de administración (<http://localhost:8080/admin>) **y además** reflejarlo en la plantilla,
para que el siguiente arranque limpio lo conserve.

### La pantalla de login sale sin estilos (o con el tema de Keycloak)

Recórrelo en este orden; cada paso descarta una causa distinta.

**1. Caché del navegador.** El servidor no cachea temas con `start-dev`, pero el navegador sí
cachea `erp-login.css` y `erp-login.js` por URL. Recarga con `Ctrl+Shift+R`, o abre las
herramientas de desarrollo → pestaña *Network* → *Disable cache*, o usa una ventana privada. En
*Network*, `erp-login.css` debe responder **200**; un **404** significa que el archivo no está
donde dice `styles=` en `login/theme.properties`.

**2. ¿Llegó el montaje al contenedor?**

```bash
docker compose exec keycloak ls /opt/keycloak/themes/erp/login
```

Debe listar `template.ftl`, `login.ftl`, `theme.properties`, `messages` y `resources`. Si
responde `No such file or directory`:

```bash
docker compose config | grep -A6 'keycloak:' | grep themes   # ¿está el bind mount?
docker compose up -d --force-recreate keycloak               # añadir un volumen exige RECREAR
```

Un `docker compose restart keycloak` **no** aplica volúmenes nuevos: hay que recrear el
contenedor.

**3. ¿Qué tema tiene el realm de verdad?**

```bash
set -a; source .env; set +a
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh get "realms/$KEYCLOAK_REALM" \
  --config /tmp/kcadm.config --fields realm,loginTheme
```

(Si no te has autenticado antes, ejecuta primero el paso 1 de
[la sección 8](#cambiar-el-tema-de-un-realm-ya-importado).)

Si `loginTheme` no es `erp`, la causa casi siempre es esta: **un realm ya importado no cambia de
tema por editar la plantilla**. Keycloak solo importa un realm que no exista todavía en su base
de datos, y esa base vive en el volumen `pg-data`. Dos salidas:

```bash
# Reimportar desde cero (borra datos de la demo)
docker compose down -v && docker compose up -d --build
```

o aplicarlo en caliente sin perder datos con `kcadm.sh`, como se explica en
[la sección 8](#cambiar-el-tema-de-un-realm-ya-importado).

**4. ¿Has tocado `theme.properties` o añadido archivos?** Esos cambios sí necesitan reinicio:

```bash
docker compose restart keycloak
docker compose logs --since=2m keycloak | grep -i -e theme -e freemarker
```

Un error de Freemarker en una plantilla aparece en ese log y hace que la página se sirva con el
mensaje de error del servidor en vez del formulario.

**5. Estilos a medias en una página que no es la de login** (OTP, actualizar contraseña,
verificar correo). Esas plantillas las sirve el tema `base` y solo adoptan el aspecto ERP por el
mapeo `kc*` de `infra/keycloak/themes/erp/login/theme.properties`. Si falta una propiedad, ese
elemento sale sin clase. Añádela ahí y reinicia el contenedor.

### `render-realm.mjs` falla con "marcador sin sustituir"

El renderizador termina con código ≠ 0 a propósito cuando queda algún `__VARIABLE__` sin
resolver. Casi siempre es un `.env` incompleto (copiado de una versión anterior de
`.env.example`) o una variable nueva añadida a la plantilla.

```bash
docker compose logs keycloak-realm            # el mensaje dice qué marcador falta
diff <(grep -o '^[A-Z_]*' .env | sort -u) <(grep -o '^[A-Z_]*' .env.example | sort -u)
```

Actualiza tu `.env` con las variables que falten y vuelve a levantar.

### El build de la imagen de la API falla con `ERR_PNPM_OUTDATED_LOCKFILE`

El Dockerfile instala con `--frozen-lockfile`. Si has tocado dependencias en algún
`package.json` sin actualizar el lockfile:

```bash
pnpm install                 # regenera pnpm-lock.yaml
docker compose build api
```

Si el error menciona un `package.json` que "no existe", asegúrate de que el Dockerfile copia
**los `package.json` de los dos paquetes**: el lockfile describe el workspace completo.

### `api` arranca y se cae en bucle

```bash
docker compose logs --tail=100 api
```

Causas típicas, por orden de frecuencia:

1. **Variable de entorno inválida o ausente** — zod aborta el arranque con el nombre exacto de la
   variable. Compara tu `.env` con `.env.example`.
2. **Migración fallida** — el mensaje incluye el fichero. Ver [sección 7](#anadir-una-migracion).
3. **Checksum de migración modificado** — has editado una migración ya aplicada.
4. **Dependencia no sana** — `docker compose ps` mostrará qué servicio está `unhealthy`.

### El listado siempre devuelve `X-Cache: MISS`

- Cada escritura incrementa la versión del namespace: si algo (o alguien) está escribiendo
  continuamente, nunca habrá `HIT`.
- `CACHE_TTL_SECONDS` demasiado bajo. Comprueba el valor efectivo con
  `docker compose config | grep CACHE_TTL`.
- Valkey caído: `curl -s http://localhost:3000/health/ready | jq '.checks.cache'`.
- Recuerda que la clave incluye `sub`, alcance, filtros y paginación: cambiar cualquier filtro es
  legítimamente una clave nueva y por tanto un `MISS`.

### El correo no llega

1. Mira en qué modo está el *mailer*:

   ```bash
   curl -s http://localhost:3000/health/ready | jq '.checks.mailer'
   docker compose logs api | grep -i mail
   ```

2. Con `provider: "dry-run"` el correo **no se envía nunca** y aun así la petición responde `200`:
   es el comportamiento esperado sin `RESEND_API_KEY`.
3. Con `provider: "resend"` y sin dominio verificado, Resend solo permite enviar a la dirección
   con la que te registraste. Comprueba tus dominios con `resend domains` y ajusta `MAIL_FROM`.
4. Tras cambiar `RESEND_API_KEY` hay que recrear el contenedor, no basta con `restart`:

   ```bash
   docker compose up -d --force-recreate api
   ```

### `InvalidHeaderValue: The API version … is not supported by Azurite`

El SDK `@azure/storage-blob` negocia una versión de la API de Storage más reciente que la que
conoce el emulador, y Azurite rechaza la petición con `400`. Por eso el servicio `azurite` de
`docker-compose.yml` arranca con `--skipApiVersionCheck`:

```yaml
command:
  - azurite
  # …
  - --skipApiVersionCheck
```

Es el workaround oficial del emulador y no afecta a Azure real. Si al subir un adjunto vuelve a
aparecer este error, comprueba que la bandera sigue en el `command` y recrea el contenedor:

```bash
docker compose up -d --force-recreate azurite
```

Mientras el contenedor de blobs no exista, `GET /health/ready` reporta `storage: "error"` y
responde `503`. La sonda es auto-reparable: vuelve a crear el contenedor de forma idempotente,
así que basta con reintentar una vez que Azurite esté sano.

### `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: esbuild`

pnpm 10+ bloquea los scripts de instalación de las dependencias. Los aprobados se declaran de
forma versionada en `pnpm-workspace.yaml`, así que la instalación es reproducible sin responder
a ningún prompt:

```yaml
allowBuilds:
  esbuild: true
```

Si tras actualizar dependencias aparece otro paquete en el mensaje, añádelo a esa lista en vez
de ejecutar `pnpm approve-builds` a mano: lo segundo no queda registrado en el repositorio.

Dentro de los `Dockerfile` se fija además `ENV CI=true`; sin ello pnpm pide confirmación
interactiva para purgar `node_modules` y el build falla con
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.

### Empezar de cero, sin dudas

```bash
docker compose down -v --remove-orphans
rm -rf node_modules packages/*/node_modules
pnpm install
docker compose up -d --build
```
