# Suites de verificación

Tres guiones que comprueban el laboratorio **de punta a punta contra el stack en
marcha**, no con mocks. Existen porque este proyecto tiene tres capas que se
rompen de formas distintas y ninguna se detecta compilando.

| Guion | Qué protege | Duración |
|---|---|---|
| [`verify-api.sh`](verify-api.sh) | Modelo de permisos, caché, adjuntos y correo | ~15 s |
| [`verify-login-theme.sh`](verify-login-theme.sh) | Que el tema Freemarker **siga autenticando** | ~10 s |
| [`verify-password-reset.sh`](verify-password-reset.sh) | Recuperación de contraseña, correo incluido | ~1 min |

```bash
pnpm run verify                     # las tres seguidas
./scripts/verify-api.sh             # una suelta
MAIL_TEST_TO=tu@correo.com ./scripts/verify-api.sh   # probando el envío real
```

Todos resuelven la raíz del repositorio desde su propia ubicación, así que
funcionan desde cualquier directorio. Salen con código `0` si todo pasa, `1` si
algo falla y `2` si falta una herramienta o el stack no responde.

## Requisitos

- El stack arriba: `pnpm run up`.
- Un `.env` en la raíz (`cp .env.example .env`).
- `curl` y `python3`.
- **Solo para `verify-password-reset.sh`**: la CLI [`resend`](https://resend.com)
  autenticada, el realm con SMTP configurado y `DEMO_ADMIN_EMAIL` apuntando a una
  dirección real.

## Por qué comprueban lo que comprueban

**`verify-api.sh`** no se limita a «responde 200». Verifica que `worker` recibe
**403** al borrar y al pedir `scope=all`, que `manager` recibe 403 en
`/admin/stats` pero 200 en `/admin/users`, y que `admin` entra en ambos. Es el
modelo de permisos ejercitado desde fuera: si alguien afloja un
`requirePermissions`, aquí se ve.

También comprueba la cabecera `X-Cache` (`MISS` y luego `HIT`), que `seed-demo`
es idempotente, y que un adjunto subido a Azurite se descarga **byte a byte
idéntico**.

**`verify-login-theme.sh`** completa el flujo OIDC entero: autorización con PKCE
`S256` → formulario → *authorization code* → canje por *access token* con el
`code_verifier`. Un tema propio puede renderizar perfecto y aun así haber perdido
el `id` del formulario o el `name` de un campo, y entonces nadie inicia sesión.
Además confirma que PKCE es **obligatorio** (sin `code_challenge` Keycloak
rechaza), que no hay errores de Freemarker, que no quedan claves de mensaje sin
resolver (`??clave??`), y que las credenciales inválidas se muestran a nivel de
campo con `aria-invalid` y traducidas.

**`verify-password-reset.sh`** es el más ambicioso: pide el restablecimiento,
**lee el correo real con la API de Resend**, extrae el enlace, lo sigue, fija la
contraseña y comprueba que sirve para iniciar sesión. Verifica de paso que el
correo va maquetado con tablas, sin `<style>` y sin recursos remotos, que es lo
que exigen los clientes de correo.

> Vuelve a fijar la contraseña al mismo valor que hay en `.env`, así que puede
> ejecutarse tantas veces como haga falta sin dejar la demostración inconsistente.

## Nota

No son tests unitarios ni sustituyen a un framework de pruebas: son
comprobaciones de humo pensadas para este laboratorio, escritas en bash a
propósito para que se puedan leer de arriba abajo sin instalar nada.
