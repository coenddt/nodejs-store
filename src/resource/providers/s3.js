'use strict';

/** S3 兼容 provider（OSS / MinIO / AWS 共用）；SDK 懒加载（可选依赖） */
function create(options = {}) {
  const awsSdk = require('@aws-sdk/client-s3'); // 懒加载：未安装时仅该 provider 报错，不影响其他
  const {
    S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
  } = awsSdk;
  const { bucket } = options;
  if (!bucket) throw new Error('s3 provider 需要 options.bucket');
  const client = options.client || new S3Client({
    credentials: options.credentials,
    region: options.region || 'us-east-1',
    endpoint: options.endpoint,
    // MinIO / 自建网关需 path-style；显式优先
    forcePathStyle: options.forcePathStyle ?? !!options.endpoint,
  });
  const keyOf = (key) => {
    if (!options.prefix) return key;   // 无前缀直返（与三元同值）
    return `${String(options.prefix).replace(/\/$/, '')}/${key}`;
  };
  return {
    kind: options.kind || 's3',
    async put(key, bytes, opts = {}) {
      await client.send(new PutObjectCommand({
        Key: keyOf(key), Bucket: bucket, Body: bytes,
        ContentType: (opts && opts.mime) || 'application/octet-stream',
      }));
    },
    async get(key) {
      const r = await client.send(new GetObjectCommand({ Key: keyOf(key), Bucket: bucket }));
      return Buffer.from(await r.Body.transformToByteArray());
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Key: keyOf(key), Bucket: bucket }));
    },
    async exists(key) {
      // 404/NotFound/NoSuchKey ⇒ 不存在；其余一律抛出（禁掩盖）
      try {
        await client.send(new HeadObjectCommand({ Key: keyOf(key), Bucket: bucket }));
        return true;
      } catch (e) {
        const code = e && e.$metadata && e.$metadata.httpStatusCode;
        const notFound = code === 404 || (e && (e.name === 'NotFound' || e.name === 'NoSuchKey'));
        if (notFound) return false;
        throw e;
      }
    },
  };
}

module.exports = { create };
