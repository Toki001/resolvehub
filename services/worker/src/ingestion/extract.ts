import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { IndexedChunk } from '@resolvehub/db';
import { IngestionFailure } from './failure.js';

export function normalizeText(text: string) {
  if (text.length > 200000 || text.includes('\0'))
    throw new IngestionFailure('INVALID_CONTENT', true);
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || (code >= 32 && code !== 127);
    })
    .join('')
    .trim();
  if (!normalized) throw new IngestionFailure('EMPTY_DOCUMENT', true);
  return normalized;
}
export function extractText(
  bytes: Uint8Array,
  mediaType: string,
  pdf: (bytes: Uint8Array, signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
) {
  if (mediaType === 'application/pdf') {
    if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-')
      throw new IngestionFailure('INVALID_CONTENT', true);
    return pdf(bytes, signal).then(normalizeText);
  }
  if (!['text/plain', 'text/markdown'].includes(mediaType))
    throw new IngestionFailure('INVALID_TYPE', true);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.startsWith('%PDF-') || text.startsWith('PK\x03\x04') || text.startsWith('MZ'))
      throw new Error('Binary document');
    return Promise.resolve(normalizeText(text));
  } catch {
    throw new IngestionFailure('INVALID_CONTENT', true);
  }
}
export function chunkText(text: string, versionId: string) {
  const normalized = normalizeText(text);
  const chunks: IndexedChunk[] = [];
  for (let start = 0; start < normalized.length; start += 900) {
    const content = normalized.slice(start, start + 1000);
    const ordinal = chunks.length;
    const contentHash = createHash('sha256').update(content).digest('hex');
    const idHash = createHash('sha256')
      .update(`${versionId}:${ordinal}:${contentHash}`)
      .digest('hex');
    const id = `${idHash.slice(0, 8)}-${idHash.slice(8, 12)}-4${idHash.slice(13, 16)}-a${idHash.slice(17, 20)}-${idHash.slice(20, 32)}`;
    chunks.push({ id, ordinal, text: content, contentHash });
    if (start + 1000 >= normalized.length) break;
  }
  if (chunks.length > 256) throw new IngestionFailure('INVALID_CONTENT', true);
  return chunks;
}
export function pdfExtractor(url: URL) {
  return (bytes: Uint8Array, signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        reject(new IngestionFailure('EXTRACTION_TIMEOUT'));
        return;
      }
      const worker = new Worker(url, {
        workerData: bytes,
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
      const abort = () => {
        reject(new IngestionFailure('EXTRACTION_TIMEOUT'));
        void worker.terminate();
      };
      signal.addEventListener('abort', abort, { once: true });
      worker.once('message', (message: unknown) => {
        const parsed = z.object({ text: z.string() }).safeParse(message);
        if (parsed.success) resolve(parsed.data.text);
        else reject(new IngestionFailure('INVALID_CONTENT', true));
        void worker.terminate();
      });
      worker.once('error', () => reject(new IngestionFailure('INVALID_CONTENT', true)));
      worker.once('exit', (code) => {
        signal.removeEventListener('abort', abort);
        if (code !== 0) reject(new IngestionFailure('INVALID_CONTENT', true));
      });
    });
}
