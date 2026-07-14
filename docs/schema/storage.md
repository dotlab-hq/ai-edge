# `storage`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `storage` | `StorageSchema` | No | — |

## Description

Storage backend for skills and files. Requires **MongoDB** for metadata (skills, skill versions, file metadata) and an **S3-compatible** object store for binary content.

## Top-Level Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mongo_uri` | `string` | Yes | — | MongoDB connection URI (e.g. `mongodb://localhost:27017`) |
| `s3` | `StorageS3Schema` | Yes | — | S3-compatible object store configuration |

## S3 Sub-Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `endpoint` | `string` | Yes | — | S3-compatible endpoint URL (e.g. `https://s3.amazonaws.com` or `http://minio:9000`) |
| `region` | `string` | No | `"auto"` | AWS region for S3 (`auto` for S3-compatible services like MinIO) |
| `access_key` | `string` | Yes | — | S3 access key ID |
| `secret_key` | `string` | Yes | — | S3 secret access key |
| `bucket` | `string` | Yes | — | S3 bucket name for skill and file storage |
| `path_style` | `boolean` | No | `false` | Use path-style S3 URLs (`true` for MinIO, `false` for AWS) |

## Constraints

- `mongo_uri` must be a non-empty string.
- All S3 fields except `region` and `path_style` are required.

## Example

```yaml
storage:
  mongo_uri: mongodb://localhost:27017
  s3:
    endpoint: http://minio:9000
    region: auto
    access_key: minioadmin
    secret_key: minioadmin
    bucket: llm-proxy-storage
    path_style: true
```
