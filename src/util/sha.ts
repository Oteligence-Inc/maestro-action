import * as crypto from 'crypto';
import * as fs from 'fs';

/** Lower-case hex SHA-256 of a file's bytes — what file-service dedups on. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Lower-case hex SHA-256 of an in-memory buffer (used in tests + small payloads). */
export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
