variable "state_passphrase" {
  description = "Encrypts the state and plans stored in R2."
  type        = string
  sensitive   = true
}

variable "portainer_url" {
  type    = string
  default = "https://containers.subzerodev.com"
}

variable "portainer_api_key" {
  type      = string
  sensitive = true
}

variable "watchdog_api_key" {
  description = "Watchdog API key staged in Uptime Kuma before the VPS stack is applied."
  type        = string
  sensitive   = true
  nullable    = false

  validation {
    condition     = length(trimspace(var.watchdog_api_key)) > 0 && var.watchdog_api_key == trimspace(var.watchdog_api_key)
    error_message = "The Watchdog API key must be nonempty and have no leading or trailing whitespace."
  }
}

variable "cf_access_client_id" {
  description = "Cloudflare Access service token in front of Portainer."
  type        = string
  sensitive   = true
}

variable "cf_access_client_secret" {
  type      = string
  sensitive = true
}
