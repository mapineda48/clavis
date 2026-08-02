provider "azurerm" {
  features {}
  # Authenticate the storage data plane with the workload identity instead of a
  # shared key. The federated service principal holds Storage Blob Data
  # Contributor on both accounts.
  storage_use_azuread = true
}

provider "cloudflare" {}

provider "digitalocean" {}

# ------------------------------------------------------------------------------
# Core state: the Cloudflare zone and the storage account are owned by the
# mapineda48/devops repository. This state consumes them, it never manages them.
# ------------------------------------------------------------------------------
data "terraform_remote_state" "core" {
  backend = "azurerm"

  config = {
    resource_group_name  = var.core_state_resource_group_name
    storage_account_name = var.core_state_storage_account_name
    container_name       = var.core_state_container_name
    key                  = var.core_state_key
    use_azuread_auth     = true
  }
}

locals {
  app_fqdn  = "${var.app_subdomain}.${var.zone_name}"
  auth_fqdn = "${var.auth_subdomain}.${var.zone_name}"

  storage_account_name = data.terraform_remote_state.core.outputs.storage_account_name
  storage_account_key  = data.terraform_remote_state.core.outputs.storage_account_primary_access_key
  deploy_container     = data.terraform_remote_state.core.outputs.deploy_container_name

  storage_connection_string = join(";", [
    "DefaultEndpointsProtocol=https",
    "AccountName=${local.storage_account_name}",
    "AccountKey=${local.storage_account_key}",
    "EndpointSuffix=core.windows.net",
  ])
}

# ------------------------------------------------------------------------------
# Attachments container. In development the API talks to Azurite; in production
# it talks to this.
# ------------------------------------------------------------------------------
resource "azurerm_storage_container" "attachments" {
  name                  = var.attachments_container
  storage_account_id    = data.terraform_remote_state.core.outputs.storage_account_id
  container_access_type = "private"
}

# ------------------------------------------------------------------------------
# SAS tokens.
#
# Two of them, on purpose:
#
#   * blobfuse2 gets a SERVICE SAS scoped to the deploy container only. It is
#     the one credential that has to travel inside cloud-init user-data, and on
#     DigitalOcean user-data is readable from the metadata service for the
#     droplet's entire life and cannot be cleared. Keeping it container-scoped
#     bounds what an attacker who reads it can touch.
#
#   * the API gets an ACCOUNT SAS, delivered inside the deploy bundle and never
#     through metadata. It needs `create` because the storage plugin calls
#     createIfNotExists() on startup, and a service SAS without that permission
#     turns into a permanent 503 on the readiness probe that reads like "blob
#     storage is down".
#
# Both are driven by a time_rotating resource rather than timestamp(), which
# would mint a new token on every plan and show a permanent diff.
# ------------------------------------------------------------------------------
resource "time_rotating" "sas" {
  rotation_days = var.sas_rotation_days
}

data "azurerm_storage_account_blob_container_sas" "deploy" {
  connection_string = local.storage_connection_string
  container_name    = local.deploy_container
  https_only        = true

  start  = time_rotating.sas.rfc3339
  expiry = timeadd(time_rotating.sas.rfc3339, "${var.sas_validity_days * 24}h")

  permissions {
    read   = true
    add    = true
    create = true
    write  = true
    delete = true
    list   = true
  }
}

data "azurerm_storage_account_sas" "attachments" {
  connection_string = local.storage_connection_string
  https_only        = true
  signed_version    = "2022-11-02"

  start  = time_rotating.sas.rfc3339
  expiry = timeadd(time_rotating.sas.rfc3339, "${var.sas_validity_days * 24}h")

  resource_types {
    service   = true
    container = true
    object    = true
  }

  services {
    blob  = true
    queue = false
    table = false
    file  = false
  }

  permissions {
    read    = true
    write   = true
    delete  = true
    list    = true
    add     = true
    create  = true
    update  = false
    process = false
    tag     = false
    filter  = false
  }
}

# ------------------------------------------------------------------------------
# Droplet
# ------------------------------------------------------------------------------
resource "digitalocean_ssh_key" "break_glass" {
  name       = "${var.project}-break-glass"
  public_key = var.ssh_public_key
}

locals {
  blobfuse_config = templatefile("${path.module}/templates/blobfuse2.yaml.tftpl", {
    account_name = local.storage_account_name
    container    = local.deploy_container
    sas_token    = data.azurerm_storage_account_blob_container_sas.deploy.sas
  })

  deploy_env = join("\n", [
    "ERP_STORAGE_ACCOUNT=${local.storage_account_name}",
    "ERP_DEPLOY_CONTAINER=${local.deploy_container}",
    "ERP_DEPLOY_PREFIX=${var.deploy_prefix}",
    "ERP_APP_FQDN=${local.app_fqdn}",
    "ERP_AUTH_FQDN=${local.auth_fqdn}",
    "",
  ])

  # Files shipped verbatim. Base64 keeps YAML indentation out of the picture
  # entirely, which is where hand-built cloud-init usually breaks.
  host_files = [
    { path = "/etc/blobfuse2.yaml", mode = "0600", b64 = base64encode(local.blobfuse_config) },
    { path = "/etc/erp/deploy.env", mode = "0644", b64 = base64encode(local.deploy_env) },

    { path = "/opt/erp/bin/reconcile.sh", mode = "0755", b64 = filebase64("${path.module}/../deploy/scripts/reconcile.sh") },
    { path = "/opt/erp/bin/acme-restore.sh", mode = "0755", b64 = filebase64("${path.module}/../deploy/scripts/acme-restore.sh") },
    { path = "/opt/erp/bin/acme-backup.sh", mode = "0755", b64 = filebase64("${path.module}/../deploy/scripts/acme-backup.sh") },
    { path = "/opt/erp/bin/metadata-guard.sh", mode = "0755", b64 = filebase64("${path.module}/../deploy/scripts/metadata-guard.sh") },

    { path = "/etc/systemd/system/erp-blobfuse2.service", mode = "0644", b64 = filebase64("${path.module}/../deploy/systemd/erp-blobfuse2.service") },
    { path = "/etc/systemd/system/erp-acme-restore.service", mode = "0644", b64 = filebase64("${path.module}/../deploy/systemd/erp-acme-restore.service") },
    { path = "/etc/systemd/system/erp-acme-backup.service", mode = "0644", b64 = filebase64("${path.module}/../deploy/systemd/erp-acme-backup.service") },
    { path = "/etc/systemd/system/erp-acme-backup.path", mode = "0644", b64 = filebase64("${path.module}/../deploy/systemd/erp-acme-backup.path") },
    { path = "/etc/systemd/system/erp-acme-backup.timer", mode = "0644", b64 = filebase64("${path.module}/../deploy/systemd/erp-acme-backup.timer") },
    { path = "/etc/systemd/system/erp-deploy.service", mode = "0644", b64 = filebase64("${path.module}/../deploy/systemd/erp-deploy.service") },
    { path = "/etc/systemd/system/erp-deploy.timer", mode = "0644", b64 = filebase64("${path.module}/../deploy/systemd/erp-deploy.timer") },
    { path = "/etc/systemd/system/erp-metadata-guard.service", mode = "0644", b64 = filebase64("${path.module}/../deploy/systemd/erp-metadata-guard.service") },
    { path = "/etc/systemd/system/docker.service.d/erp-deps.conf", mode = "0644", b64 = filebase64("${path.module}/../deploy/systemd/docker-erp-deps.conf") },

    { path = "/etc/ssh/sshd_config.d/00-erp-hardening.conf", mode = "0600", b64 = filebase64("${path.module}/../deploy/host/sshd-hardening.conf") },
    { path = "/etc/apt/apt.conf.d/51erp-unattended-upgrades", mode = "0644", b64 = filebase64("${path.module}/../deploy/host/unattended-upgrades.conf") },
    { path = "/etc/fail2ban/jail.d/erp-sshd.local", mode = "0644", b64 = filebase64("${path.module}/../deploy/host/fail2ban-sshd.conf") },
    { path = "/etc/docker/daemon.json", mode = "0644", b64 = filebase64("${path.module}/../deploy/host/docker-daemon.json") },
    { path = "/etc/sysctl.d/60-erp.conf", mode = "0644", b64 = filebase64("${path.module}/../deploy/host/sysctl.conf") },
  ]

  cloud_init = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    files = local.host_files
  })
}

resource "digitalocean_droplet" "main" {
  name       = var.project
  region     = var.region
  size       = var.droplet_size
  image      = var.droplet_image
  ssh_keys   = [digitalocean_ssh_key.break_glass.id]
  user_data  = local.cloud_init
  monitoring = true
  ipv6       = false

  # user_data is baked at creation and is immutable for the droplet's life, so a
  # change to it has to replace the droplet. Making that explicit beats
  # discovering that an "applied" change never reached the host.
  lifecycle {
    replace_triggered_by = [terraform_data.cloud_init_revision]
  }
}

resource "terraform_data" "cloud_init_revision" {
  input = sha256(local.cloud_init)
}

resource "digitalocean_firewall" "main" {
  name        = var.project
  droplet_ids = [digitalocean_droplet.main.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # Only rendered when someone asks for SSH. The pipeline never does.
  dynamic "inbound_rule" {
    for_each = length(var.ssh_allowed_cidrs) > 0 ? [1] : []
    content {
      protocol         = "tcp"
      port_range       = "22"
      source_addresses = var.ssh_allowed_cidrs
    }
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

# ------------------------------------------------------------------------------
# DNS. Both records stay DNS-only.
#
# Cloudflare's free Universal SSL covers the apex and one level of subdomain, so
# it does NOT cover auth.erp-keycloak.mapineda48.com. Proxying that hostname
# would need Advanced Certificate Manager at $10/month per zone; with the proxy
# off, Traefik terminates TLS at the origin with its own Let's Encrypt
# certificate and it costs nothing.
# ------------------------------------------------------------------------------
resource "cloudflare_dns_record" "app" {
  zone_id = data.terraform_remote_state.core.outputs.cloudflare_zone_id
  name    = var.app_subdomain
  type    = "A"
  content = digitalocean_droplet.main.ipv4_address
  ttl     = 60
  proxied = false
  comment = "Managed by Terraform - erp-keycloak SPA and API"

  lifecycle {
    precondition {
      condition     = data.terraform_remote_state.core.outputs.cloudflare_zone_name == var.zone_name
      error_message = "The core state manages a different Cloudflare zone than var.zone_name."
    }
  }
}

resource "cloudflare_dns_record" "auth" {
  zone_id = data.terraform_remote_state.core.outputs.cloudflare_zone_id
  name    = var.auth_subdomain
  type    = "A"
  content = digitalocean_droplet.main.ipv4_address
  ttl     = 60
  proxied = false
  comment = "Managed by Terraform - erp-keycloak Keycloak"
}
