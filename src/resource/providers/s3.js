'use strict';

/** S3 兼容 provider（OSS / MinIO / AWS 共用）；SDK 懒加载（可选依赖） */
function create(options = {}) {
  const {
    S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
  } = require('@aws-sdk/client-s3'); // 懒加载：未安装时仅该 provider 报错，不影响其他
  const bucket = options.bucket;
  if (!bucket) throw new Error('s3 provider 需要 options.bucket');
  const client = options.client || new S3Client({
    region: options.region || 'us-east-1',
    endpoint: options.endpoint,
    // MinIO / 自建网关需 path-style；显式优先
    forcePathStyle: options.forcePathStyle ?? !!options.endpoint,
    credentials: options.credentials,
  });
  const keyOf = (key) => (options.prefix ? `${String(options.prefix).replace(/\/$/, '')}/${key}` : key);
  return {
    kind: options.kind || 's3',
    async put(key, bytes, opts = {}) {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: keyOf(key), Body: bytes,
        ContentType: (opts && opts.mime) || 'application/octet-stream',
      }));
    },
    async get(key) {
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: keyOf(key) }));
      return Buffer.from(await r.Body.transformToByteArray());
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyOf(key) }));
    },
    async exists(key) {
      try { await client.send(new HeadObjectCommand({ Bucket: bucket, Key: keyOf(key) })); return true; }
      catch (e) {
        const code = e && e.$metadata && e.$metadata.httpStatusCode;
        if (code === 404 || (e && (e.name === 'NotFound' || e.name === 'NoSuchKey'))) return false;
        throw e; // 非 404 一律抛出（禁掩盖）
      }
    },
  };
}

module.exports = { create };
