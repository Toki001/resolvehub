import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { IngestionSource } from '@resolvehub/db';
import { IngestionFailure } from './failure.js';

export class DocumentStorage {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}
  async fetch(source: IngestionSource, organizationId: string, signal: AbortSignal) {
    if (
      !new RegExp(`^organizations/${organizationId}/uploads/[a-f0-9-]{36}$`).test(source.objectKey)
    )
      throw new IngestionFailure('INVALID_OBJECT_KEY', true);
    if (!['text/plain', 'text/markdown', 'application/pdf'].includes(source.mediaType))
      throw new IngestionFailure('INVALID_TYPE', true);
    if (source.sizeBytes < 1 || source.sizeBytes > 10485760)
      throw new IngestionFailure('INVALID_SIZE', true);
    try {
      const result = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: source.objectKey }),
        { abortSignal: signal },
      );
      const body = result.Body;
      if (!(body instanceof Readable)) throw new IngestionFailure('STORAGE_UNAVAILABLE');
      try {
        if (result.ContentType?.split(';')[0]?.trim().toLowerCase() !== source.mediaType)
          throw new IngestionFailure('INVALID_TYPE', true);
        if (result.ContentLength !== undefined && result.ContentLength !== source.sizeBytes)
          throw new IngestionFailure('INVALID_SIZE', true);
        const buffers: Buffer[] = [];
        let size = 0;
        for await (const chunk of body) {
          const value: unknown = chunk;
          if (!(value instanceof Uint8Array)) throw new IngestionFailure('INVALID_CONTENT', true);
          size += value.byteLength;
          if (size > source.sizeBytes || size > 10485760)
            throw new IngestionFailure('INVALID_SIZE', true);
          buffers.push(Buffer.from(value));
        }
        if (size !== source.sizeBytes) throw new IngestionFailure('INVALID_SIZE', true);
        const bytes = Buffer.concat(buffers);
        if (createHash('sha256').update(bytes).digest('hex') !== source.sha256)
          throw new IngestionFailure('HASH_MISMATCH', true);
        return bytes;
      } finally {
        body.destroy();
      }
    } catch (error) {
      if (error instanceof IngestionFailure) throw error;
      if (error instanceof Error && ['NoSuchKey', 'NotFound', 'NoSuchBucket'].includes(error.name))
        throw new IngestionFailure('OBJECT_NOT_FOUND', true);
      throw new IngestionFailure(signal.aborted ? 'STORAGE_TIMEOUT' : 'STORAGE_UNAVAILABLE');
    }
  }
}
