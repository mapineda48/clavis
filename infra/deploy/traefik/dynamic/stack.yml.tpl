# Traefik dynamic configuration: routers, services, middlewares, TLS options.
# Rendered by the deploy workflow with envsubst.
#
# The file provider is used rather than Docker labels. The topology is fixed, so
# auto-discovery buys nothing, and the trade is worth stating: with labels the
# routing table is whatever containers happen to be running, and any container
# that starts on this host can claim `Host(auth.…)` and take over the identity
# provider. Here the table is a reviewed file and Traefik never sees the Docker
# socket at all.

tls:
  options:
    default:
      minVersion: VersionTLS12
      sniStrict: true
      curvePreferences:
        - X25519
        - CurveP256
      cipherSuites:
        - TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
        - TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
        - TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
        - TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
        - TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305
        - TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305

http:
  middlewares:
    security-headers:
      headers:
        # Short on purpose. This host is destroyed and rebuilt regularly, and a
        # year-long HSTS means that the one time a deploy comes up with a bad
        # certificate, nobody can click through — during a live demo. Five
        # minutes still enforces HTTPS for anyone browsing the site without
        # turning a bad deploy into a lockout. No preload: that is a claim on
        # the entire domain, and it is close to irreversible.
        stsSeconds: 300
        stsIncludeSubdomains: false
        forceSTSHeader: true
        contentTypeNosniff: true
        browserXssFilter: true
        # NO frame-options header here, and that is deliberate.
        #
        # Setting one at the edge applies it to BOTH hostnames, and Keycloak
        # serves some endpoints that MUST be framable from the application's
        # origin — /protocol/openid-connect/3p-cookies/step1.html above all,
        # which keycloak-js loads in a hidden iframe on startup. Forcing DENY or
        # even SAMEORIGIN onto it makes the browser refuse to render the frame,
        # keycloak-js waits for a message that never arrives, and initialisation
        # fails with "Timeout when waiting for 3rd party check iframe message".
        #
        # Logging in becomes impossible while every container stays healthy, the
        # certificate stays valid and the smoke suite still passes 8/8 — because
        # those assertions use the direct grant and never touch the browser's
        # framing rules. It took DevTools to see it.
        #
        # Each application already declares its own policy correctly: nginx
        # sends SAMEORIGIN for the SPA from infra/nginx/app.conf, and Keycloak
        # sets its own per endpoint precisely because a few of them have to be
        # framable.
        referrerPolicy: strict-origin-when-cross-origin
        customResponseHeaders:
          Server: ""
          X-Powered-By: ""
          Permissions-Policy: "geolocation=(), microphone=(), camera=(), payment=()"

    # Global ceiling. In-memory and per-instance, which is fine for one node.
    rate-limit:
      rateLimit:
        average: 50
        period: 1s
        burst: 100

    # Tighter for anything that authenticates.
    auth-rate-limit:
      rateLimit:
        average: 10
        period: 1s
        burst: 30

    # Tighter still for the password-reset form. The demo publishes its
    # credentials, so the reset endpoint is reachable by anyone and the admin
    # account carries a real inbox: without this the demo is an open mail relay
    # pointed at one person.
    reset-rate-limit:
      rateLimit:
        average: 1
        period: 1m
        burst: 3

    # The administration console and the master realm. Defaults to loopback,
    # which reaches nobody: on a public demo the console must be opened
    # deliberately, never by forgetting to close it.
    admin-allowlist:
      ipAllowList:
        sourceRange: [${ERP_ADMIN_ALLOWLIST}]

    compress:
      compress:
        excludedContentTypes:
          - image/png
          - image/jpeg
          - image/webp

  routers:
    # --- erp-keycloak.mapineda48.com -----------------------------------------
    # Everything the API owns is under /api, health and OpenAPI included, so
    # this one rule needs no exceptions.
    api:
      rule: "Host(`${ERP_APP_FQDN}`) && PathPrefix(`/api`)"
      entryPoints: [websecure]
      service: erp-api
      priority: 100

    spa:
      rule: "Host(`${ERP_APP_FQDN}`)"
      entryPoints: [websecure]
      service: erp-app
      middlewares: [compress]
      priority: 10

    # --- auth.erp-keycloak.mapineda48.com ------------------------------------
    keycloak-admin:
      rule: "Host(`${ERP_AUTH_FQDN}`) && (PathPrefix(`/admin`) || PathPrefix(`/realms/master`))"
      entryPoints: [websecure]
      service: erp-keycloak
      middlewares: [admin-allowlist, auth-rate-limit]
      priority: 200

    keycloak-reset:
      rule: "Host(`${ERP_AUTH_FQDN}`) && PathPrefix(`/realms/${ERP_REALM}/login-actions/reset-credentials`)"
      entryPoints: [websecure]
      service: erp-keycloak
      middlewares: [reset-rate-limit]
      priority: 150

    keycloak:
      rule: "Host(`${ERP_AUTH_FQDN}`)"
      entryPoints: [websecure]
      service: erp-keycloak
      middlewares: [auth-rate-limit]
      priority: 10

  services:
    erp-api:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: "http://api:3000"

    erp-app:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: "http://app:80"

    erp-keycloak:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: "http://keycloak:8080"
