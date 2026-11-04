terraform {
  required_version = ">= 1.6"
}

variable "bucket_name" {
  type    = string
  default = "canopy-fixture-bucket"
}

# Terraform fixture for the file viewer language flow.
resource "aws_s3_bucket" "fixture" {
  bucket = var.bucket_name
  tags = {
    Purpose = "highlighting"
  }
}
