import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { API_ENV } from '../env.js';
import type { ApiEnv } from '../env.js';

@Injectable()
export class UploadsService {
  private readonly storage: S3Client;
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {
    this.storage = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: true,
      maxAttempts: 1,
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });
  }
  async put(organizationId: string, key: string, bytes: Buffer, mediaType: string) {
    if (!this.env.S3_ACCESS_KEY_ID || !this.env.S3_SECRET_ACCESS_KEY)
      throw new Error('Upload storage credentials are not configured');
    const digest = createHash('sha256').update(key).digest('hex');
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const objectKey = `organizations/${organizationId}/uploads/${id}`;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await this.storage.send(
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: objectKey,
        Body: bytes,
        ContentType: mediaType,
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    return { objectKey, sha256, sizeBytes: bytes.length, mediaType };
  }
  onModuleDestroy() {
    this.storage.destroy();
  }
}
