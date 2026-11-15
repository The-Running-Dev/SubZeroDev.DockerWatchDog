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

variable "cf_access_client_id" {
  description = "Cloudflare Access service token in front of Portainer."
  type        = string
  sensitive   = true
}

variable "cf_access_client_secret" {
  type      = string
  sensitive = true
}

variable "oidc_issuer" {
  description = "The Dashboard's Supabase Auth URL (https://<project>.supabase.co/auth/v1)."
  type        = string
}

variable "owner_subject" {
  description = "The Supabase user ID allowed to sign in."
  type        = string
}

variable "supabase_publishable_key" {
  description = "The Supabase project's publishable key."
  type        = string
  sensitive   = true
}
