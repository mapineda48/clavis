# Traefik static configuration. Rendered by the deploy workflow with envsubst
# and shipped inside the bundle.
#
# Two resolvers are declared and the entry point picks one. They are separate on
# purpose: Traefik wipes the stored ACME account whenever a resolver's caServer
# hostname changes, so flipping a single resolver between staging and production
# would destroy the account — and the certificates with it — on every switch.
# Keeping them apart means both live side by side in the same acme.json, keyed
# by resolver name.

global:
  checkNewVersion: false
  sendAnonymousUsage: false

log:
  level: INFO
  format: json

accessLog:
  format: json
  bufferingSize: 64
  fields:
    defaultMode: keep
    headers:
      defaultMode: drop
      names:
        User-Agent: keep
        Referer: keep
        # Never logged: these carry bearer tokens and session cookies.
        Authorization: drop
        Cookie: drop

# The dashboard exposes the whole routing table. `api` already defaults to
# false; it is spelled out so nobody "just turns it on to peek".
api:
  dashboard: false
  insecure: false

ping:
  entryPoint: ping

entryPoints:
  # Loopback inside the container, never published. Only the container
  # healthcheck talks to it.
  ping:
    address: "127.0.0.1:8082"

  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
          permanent: true

  websecure:
    address: ":443"
    http:
      middlewares:
        - security-headers@file
        - rate-limit@file
      # TLS is configured once, here, for every router on the entry point. No
      # router declares its own: two sources of truth for TLS is how a stack
      # ends up quietly serving Traefik's self-signed default certificate.
      tls:
        certResolver: ${CLAVIS_CERT_RESOLVER}
        domains:
          # ONE certificate covering the three names. Issued separately they
          # would occupy three independent "5 duplicate certificates per week"
          # buckets; as a single identifier set they share one.
          - main: "${CLAVIS_APP_FQDN}"
            sans:
              - "${CLAVIS_API_FQDN}"
              - "${CLAVIS_AUTH_FQDN}"
    transport:
      respondingTimeouts:
        readTimeout: 60s
        writeTimeout: 60s
        idleTimeout: 180s

providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true

certificatesResolvers:
  staging:
    acme:
      email: "${CLAVIS_ACME_EMAIL}"
      # One store PER RESOLVER, not one shared file. Traefik loads every
      # certificate it finds into a single store and serves by SNI match, so a
      # staging certificate sitting in the same file satisfies the request and
      # the production resolver never orders anything — the site keeps serving
      # an untrusted certificate and no error is logged anywhere.
      storage: /acme/staging.json
      caServer: https://acme-staging-v02.api.letsencrypt.org/directory
      keyType: EC256
      # HTTP-01, not DNS-01, and the reason is worth stating: DNS-01 would put a
      # token that can rewrite the whole mapineda48.com zone on a public-facing
      # host. HTTP-01 needs no credential at all — Traefik answers the challenge
      # on the port it already listens on. Traefik installs the challenge router
      # ahead of the HTTP-to-HTTPS redirection automatically.
      #
      # The cost is that the A record must already point here when the
      # certificate is ordered. Terraform creates both records in the same apply
      # that creates the droplet, with a 60 s TTL, and Traefik retries.
      httpChallenge:
        entryPoint: web

  production:
    acme:
      email: "${CLAVIS_ACME_EMAIL}"
      storage: /acme/production.json
      caServer: https://acme-v02.api.letsencrypt.org/directory
      keyType: EC256
      httpChallenge:
        entryPoint: web
