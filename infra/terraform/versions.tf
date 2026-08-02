# Provider versions are pinned EXACTLY and .terraform.lock.hcl is committed.
#
# `~>` would let a provider drift between two applies weeks apart, which is the
# opposite of what this lab is meant to demonstrate. The same rule the rest of
# the repository follows for npm packages and container images.

terraform {
  required_version = "1.15.7"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "4.81.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.22.0"
    }
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "2.99.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "0.14.0"
    }
  }
}
