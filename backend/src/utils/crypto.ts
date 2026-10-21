import crypto from 'node:crypto';
import { env, isProduction } from '../config/env';

/**
 * Encryption for third-party credentials we hold on a tenant's behalf.
 *
 * A Tech Provider stores an access token that can send messages as somebody
 * else's business. A leaked database must therefore not be enough to use those
 * tokens, so they are encrypted at rest with a key that lives only in the
 * environment.
 *
 * AES-256-GCM is used rather than CBC because it authenticates the ciphertext:
 * a tampered row fails to decrypt instead of silently producing wrong bytes.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_BYTES = 32;

/**
 * Derives the 32-byte key from PLATFORM_ENCRYPTION_KEY.
 *
 * Accepts hex or base64 so the operator can paste whatever `openssl rand`
 * produced. Outside production a key is derived from the JWT secret, so tests
 * and local development need no extra configuration — but production refuses
 * to start without a real one, because a predictable key is not encryption.
 */
function encryptionKey(): Buffer {
  const configured = env.platformEncryptionKey.trim();

  if (configured === '') {
    if (isProduction) {
      throw new Error(
        'PLATFORM_ENCRYPTION_KEY is required in production: it protects tenant access tokens at rest. ' +
          'Generate one with: openssl rand -hex 32'
      );
    }
    // Deterministic, clearly non-production fallback.
    return crypto.createHash('sha256').update(`dev-key:${env.jwtAccessSecret}`).digest();
  }

  // Exactly 32 bytes of hex or base64 is used as the key directly.
  const decoded = /^[0-9a-fA-F]{64}$/.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64');

  if (decoded.length === KEY_BYTES) return decoded;

  // Anything else with enough entropy is derived with SHA-256 rather than
  // rejected. Platforms that generate secrets for you (Render's
  // generateValue, for one) do not promise a particular length or encoding,
  // and refusing them would mean a deployment that cannot start.
  if (configured.length >= 32) {
    return crypto.createHash('sha256').update(configured).digest();
  }

  throw new Error(
    'PLATFORM_ENCRYPTION_KEY is too short to be a key: supply 32 bytes of hex or base64, ' +
      'or at least 32 random characters. Generate one with: openssl rand -hex 32'
  );
}

/**
 * Returns "v1.<iv>.<authTag>.<ciphertext>", all base64url.
 *
 * The version prefix means a future key rotation or algorithm change can be
 * introduced without guessing how existing rows were written.
 */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return ['v1', iv.toString('base64url'), authTag.toString('base64url'), ciphertext.toString('base64url')].join(
    '.'
  );
}

/** Reverses encryptSecret. Throws if the value was tampered with or truncated. */
export function decryptSecret(encoded: string): string {
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Encrypted value is malformed or uses an unsupported version.');
  }

  const [, iv, authTag, ciphertext] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * A short, stable, non-reversible label for a secret.
 *
 * Lets an operator confirm "the token on this connection is the one I just
 * issued" from a log line or the console, without the log ever containing
 * anything usable.
 */
export function fingerprint(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

/** Full SHA-256 hex, used to store API keys for exact lookup. */
export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison that tolerates differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first; length is not the secret here, the content is.
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Generates an API key in the form sdk_<env>_<prefix><secret>.
 *
 * The prefix is stored in the clear so a key is recognisable in the console and
 * in logs; only the hash of the whole key is persisted, so a stolen database
 * cannot be used to call the API.
 */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const label = isProduction ? 'live' : 'test';
  const prefixPart = crypto.randomBytes(6).toString('hex'); // 12 chars
  const secretPart = crypto.randomBytes(24).toString('base64url');

  const prefix = `sdk_${label}_${prefixPart}`;
  const key = `${prefix}${secretPart}`;

  return { key, prefix, hash: sha256(key) };
}

/** A webhook signing secret handed to a tenant. */
export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
}

/**
 * Signs an outbound webhook body the way Stripe and Meta do: the signature
 * covers the timestamp as well as the body, so a captured request cannot be
 * replayed later against a receiver that checks the age.
 */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
