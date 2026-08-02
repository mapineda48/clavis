# --- naming -------------------------------------------------------------------

variable "project" {
  description = "Prefix for every resource this state owns"
  type        = string
  default     = "erp-keycloak"
}

# --- hostnames ----------------------------------------------------------------

variable "zone_name" {
  description = "Cloudflare zone that owns the records. Must match the one in the core state."
  type        = string
  default     = "mapineda48.com"
}

variable "app_subdomain" {
  description = "Record for the SPA and the API, relative to the zone"
  type        = string
  default     = "erp-keycloak"
}

variable "auth_subdomain" {
  description = "Record for Keycloak, relative to the zone"
  type        = string
  default     = "auth.erp-keycloak"
}

# --- droplet ------------------------------------------------------------------

variable "region" {
  description = <<-EOT
    DigitalOcean region. Defaults to nyc3 because the Neon project lives in
    aws-us-east-1: every Keycloak boot and every token exchange pays this round
    trip, so putting the droplet in Europe would add ~90 ms to each of them.
  EOT
  type        = string
  default     = "nyc3"
}

variable "droplet_size" {
  description = "Droplet size slug. Billed by the hour: the stack is brought up on demand."
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "droplet_image" {
  description = "Base image slug"
  type        = string
  default     = "ubuntu-24-04-x64"
}

variable "ssh_public_key" {
  description = "Public key registered on the droplet for break-glass access"
  type        = string
}

# --- access control -----------------------------------------------------------

variable "ssh_allowed_cidrs" {
  description = <<-EOT
    Sources allowed to reach port 22. EMPTY BY DEFAULT, and that is deliberate:
    the pipeline deploys by pull and never needs SSH, so the port only opens
    when a human asks for it. DigitalOcean's browser console remains available
    regardless.
  EOT
  type        = list(string)
  default     = []
}

variable "admin_allowed_cidrs" {
  description = <<-EOT
    Sources allowed to reach the Keycloak administration console and the master
    realm. Defaults to loopback, which reaches nobody: on a public demo the
    console must be opened on purpose, never by omission.
  EOT
  type        = list(string)
  default     = ["127.0.0.1/32"]
}

# --- core state ---------------------------------------------------------------

variable "core_state_resource_group_name" {
  description = "Resource group holding the core Terraform state"
  type        = string
  default     = "rg-mapineda48-tfstate"
}

variable "core_state_storage_account_name" {
  description = "Storage account holding the core Terraform state"
  type        = string
  default     = "sttfstate2jk6opjz"
}

variable "core_state_container_name" {
  description = "Blob container holding the core Terraform state"
  type        = string
  default     = "tfstate"
}

variable "core_state_key" {
  description = "Blob key of the core Terraform state"
  type        = string
  default     = "core.tfstate"
}

# --- storage ------------------------------------------------------------------

variable "attachments_container" {
  description = "Blob container backing the ERP attachments in production"
  type        = string
  default     = "erp-attachments"
}

variable "deploy_prefix" {
  description = "Prefix inside the deploy container that this stack owns"
  type        = string
  default     = "erp-keycloak"
}

variable "sas_rotation_days" {
  description = <<-EOT
    How often the SAS tokens are regenerated. A `time_rotating` resource drives
    it rather than `timestamp()`, which would produce a perpetual diff and mint
    a fresh token on every single plan.
  EOT
  type        = number
  default     = 30
}

variable "sas_validity_days" {
  description = "Lifetime of each generated SAS. Must exceed the rotation period."
  type        = number
  default     = 90
}
