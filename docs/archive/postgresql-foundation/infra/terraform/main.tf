terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22"
    }
  }
}

provider "cloudflare" {}

variable "account_id" {
  type = string
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Use separate staging or production state and credentials."
  }
}

resource "cloudflare_r2_bucket" "private_files" {
  account_id = var.account_id
  name       = "motorbaldi-${var.environment}-private"
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_managed_domain" "private_files" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.private_files.name
  enabled     = false
}

output "private_bucket" {
  value = cloudflare_r2_bucket.private_files.name
}
