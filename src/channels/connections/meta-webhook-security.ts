import crypto from 'node:crypto';

export function validMetaWebhookSignature(rawBody: Buffer | undefined, signature: string, secret: string): boolean {
  if (!rawBody || !secret || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(signature.toLowerCase()), Buffer.from(expected));
}
