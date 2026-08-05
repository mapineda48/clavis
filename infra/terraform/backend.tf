# Remote state in the Azure storage account that already holds the "core" state
# of the mapineda48/devops repository, under its own key.
#
# The values are resource names, not secrets, so they live in code: a
# `-backend-config` file that has to be reconstructed by hand is exactly how the
# reference implementation ended up pointing at a storage account that does not
# exist.
#
# `use_azuread_auth` is what makes the backend authenticate with the federated
# OIDC identity instead of trying to fetch a storage account shared key — which
# a workload identity cannot do, and which fails with an error that reads like a
# missing role assignment.

terraform {
  backend "azurerm" {
    resource_group_name  = "rg-mapineda48-tfstate"
    storage_account_name = "sttfstate2jk6opjz"
    container_name       = "tfstate"
    key                  = "clavis.tfstate"
    use_azuread_auth     = true
  }
}
