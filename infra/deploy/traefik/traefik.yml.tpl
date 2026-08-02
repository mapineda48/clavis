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
        certResolver: ${ERP_CERT_RESOLVER}
        domains:
          # ONE certificate covering both names. Issued separately they would
          # occupy two independent "5 duplicate certificates per week" buckets;
          # as a single identifier set they share one.
          - main: "${ERP_APP_FQDN}"
            sans:
              - "${ERP_AUTH_FQDN}"
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
      email: "${ERP_ACME_EMAIL}"
      storage: /acme.json
      caServer: https://acme-staging-v02.api.letsencrypt.org/directory
      keyType: EC256
      dnsChallenge:
        provider: cloudflare
        # Ask Cloudflare's own resolvers, not the host's: the propagation check
        # otherwise races a cached negative answer for the TXT record.
        resolvers:
          - "1.1.1.1:53"
          - "1.0.0.1:53"
        propagation:
          delayBeforeChecks: 10s

  production:
    acme:
      email: "${ERP_ACME_EMAIL}"
      storage: /acme.json
      caServer: https://acme-v02.api.letsencrypt.org/directory
      keyType: EC256
      dnsChallenge:
        provider: cloudflare
        resolvers:
          - "1.1.1.1:53"
          - "1.0.0.1:53"
        propagation:
          delayBeforeChecks: 10s
