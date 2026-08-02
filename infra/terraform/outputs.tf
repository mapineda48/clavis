output "droplet_ipv4" {
  description = "Public address of the droplet"
  value       = digitalocean_droplet.main.ipv4_address
}

output "app_url" {
  description = "Public URL of the SPA; the API hangs off /api on the same origin"
  value       = "https://${local.app_fqdn}"
}

output "auth_url" {
  description = "Public URL of Keycloak"
  value       = "https://${local.auth_fqdn}"
}

output "issuer" {
  description = "Expected OIDC issuer. The smoke test asserts the discovery document reports exactly this."
  value       = "https://${local.auth_fqdn}/realms/erp"
}

output "storage_account_name" {
  description = "Storage account holding the deploy bundle and the attachments"
  value       = local.storage_account_name
}

output "deploy_container" {
  description = "Blob container the deploy bundle is published to"
  value       = local.deploy_container
}

output "deploy_prefix" {
  description = "Prefix inside the deploy container owned by this stack"
  value       = var.deploy_prefix
}

output "attachments_container" {
  description = "Blob container backing the attachments in production"
  value       = azurerm_storage_container.attachments.name
}

output "attachments_connection_string" {
  description = <<-EOT
    Connection string the API uses in production. Carries an account SAS, not
    the account key, and is consumed by the deploy workflow to build the bundle.
  EOT
  sensitive   = true
  value = join(";", [
    "BlobEndpoint=https://${local.storage_account_name}.blob.core.windows.net",
    "SharedAccessSignature=${trimprefix(data.azurerm_storage_account_sas.attachments.sas, "?")}",
  ])
}
