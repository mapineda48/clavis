# Verification suites

Three scripts that exercise the lab **end to end against the running stack**, not
against mocks. They exist because this project has three layers that break in
different ways, and none of those breakages shows up at compile time.

| Script | What it protects | Duration |
|---|---|---|
| [`verify-api.sh`](verify-api.sh) | Permission model, cache, attachments and email | ~15 s |
| [`verify-login-theme.sh`](verify-login-theme.sh) | That the Freemarker theme **still authenticates** | ~10 s |
| [`verify-password-reset.sh`](verify-password-reset.sh) | Password recovery, email included | ~1 min |

```bash
pnpm run verify                     # the two suites that need no external CLI
./scripts/verify-api.sh             # just one
MAIL_TEST_TO=you@example.com ./scripts/verify-api.sh   # exercising real delivery
```

They all resolve the repository root from their own location, so they work from
any directory. They exit with `0` when everything passes, `1` when something
fails, and `2` when a tool is missing or the stack is not answering.

## Requirements

- The stack up: `pnpm run up`.
- A `.env` at the root (`cp .env.example .env`).
- `curl` and `python3`.
- **For `verify-password-reset.sh` only**: the [`resend`](https://resend.com) CLI
  authenticated, the realm with SMTP configured, and `DEMO_ADMIN_EMAIL` pointing
  at a real address.

## Why they check what they check

**`verify-api.sh`** does not stop at "it returns 200". It asserts that `worker`
gets **403** when deleting and when asking for `scope=all`, that `manager` gets
403 on `/admin/stats` but 200 on `/admin/users`, and that `admin` gets into both.
It is the permission model exercised from the outside: if somebody loosens a
`requirePermissions`, it shows up here.

It also checks the `X-Cache` header (`MISS` and then `HIT`), that `seed-demo` is
idempotent, and that an attachment uploaded to Azurite comes back **byte-for-byte
identical**.

**`verify-login-theme.sh`** walks the entire OIDC flow: PKCE `S256` authorization
→ form → *authorization code* → exchange for an *access token* with the
`code_verifier`. A custom theme can render perfectly and still have lost the
form's `id` or a field's `name`, and then nobody can sign in. It also confirms
that PKCE is **mandatory** (Keycloak rejects a request with no `code_challenge`),
that there are no Freemarker errors, that no message key is left unresolved
(`??key??`), and that invalid credentials are reported at field level with
`aria-invalid` and using the theme's message catalogue.

**`verify-password-reset.sh`** is the most ambitious one: it requests the reset,
**reads the real email through the Resend API**, extracts the link, follows it,
sets the password and checks that it works for signing in. Along the way it
verifies that the email is laid out with tables, carries no `<style>` block and
loads no remote resources — which is what email clients demand.

> It sets the password back to the value already in `.env`, so it can be run as
> many times as needed without leaving the demo inconsistent.

## Note

These are not unit tests and they do not replace a testing framework: they are
smoke checks written for this lab, deliberately in bash so they can be read top
to bottom without installing anything.
