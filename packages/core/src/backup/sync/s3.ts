// S3-compatible BackupTarget. `@aws-sdk/client-s3` is an OPTIONAL, lazy-loaded
// dependency — it is NOT required to build or install @librarian/core; it's only
// needed at runtime when S3 sync is actually used (works with AWS, Cloudflare R2,
// MinIO, Backblaze via the `endpoint` override + path-style addressing).

import type { S3SyncConfig } from "./config.js";
import type { BackupTarget } from "./types.js";

// A variable specifier so TypeScript does not resolve the module at build time
// (keeps the package optional). The module is typed as `any` at the call site.
const S3_PACKAGE = "@aws-sdk/client-s3";

interface AwsS3Module {
  S3Client: new (cfg: unknown) => { send(command: unknown): Promise<unknown> };
  PutObjectCommand: new (input: unknown) => unknown;
  GetObjectCommand: new (input: unknown) => unknown;
  ListObjectsV2Command: new (input: unknown) => unknown;
  DeleteObjectCommand: new (input: unknown) => unknown;
}

export async function createS3Target(config: S3SyncConfig): Promise<BackupTarget> {
  let aws: AwsS3Module;
  try {
    aws = (await import(S3_PACKAGE)) as unknown as AwsS3Module;
  } catch {
    throw new Error(
      "@aws-sdk/client-s3 is not installed — run `npm i @aws-sdk/client-s3` to enable S3 backup sync",
    );
  }
  const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    ListObjectsV2Command,
    DeleteObjectCommand,
  } = aws;

  const client = new S3Client({
    region: config.region ?? "us-east-1",
    ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const prefix = config.prefix ? `${config.prefix.replace(/\/+$/, "")}/` : "";

  // Object names (relative to the configured prefix) under a list prefix.
  async function listNames(p: string): Promise<string[]> {
    const res = (await client.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix + p }),
    )) as { Contents?: { Key?: string }[] };
    return (res.Contents ?? [])
      .map((o) => o.Key ?? "")
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }

  return {
    async put(name, data) {
      await client.send(
        new PutObjectCommand({ Bucket: config.bucket, Key: prefix + name, Body: data }),
      );
    },
    async get(name) {
      const res = (await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: prefix + name }),
      )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
      if (!res.Body) throw new Error(`empty object: ${name}`);
      return Buffer.from(await res.Body.transformToByteArray());
    },
    list: listNames,
    async deleteBundle(bundleName) {
      const names = await listNames(`${bundleName}/`);
      for (const name of names) {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: prefix + name }));
      }
    },
  };
}
