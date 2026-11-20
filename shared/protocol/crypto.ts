/**
 * Jarvis Mobile cryptography (Node side). Standard primitives only, all from node:crypto:
 *  - identity: ECDSA P-256 (signing, relay authentication); device id = hex SHA-256 of the SPKI DER
 *  - end-to-end: P-256 ECDH → HKDF-SHA256 → AES-256-GCM, one key per direction, sender and
 *    recipient bound in the AAD; 96-bit random nonces
 *  - pairing: AES-256-GCM with a key derived (HKDF) from the one-time QR secret
 * The Android client implements the same construction with JCA (see crypto/E2E.kt); the test
 * vectors in shared/protocol/fixtures/crypto-vectors.json keep both sides in lockstep.
 */
import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign as edSign, verify as edVerify, createCipheriv, createDecipheriv, type KeyObject } from 'node:crypto';

export const RELAY_AUTH_CONTEXT = 'jarvis-relay-auth-v1';

export interface DeviceKeys {
  /** PKCS#8 DER, base64 — private; store only in an encrypted secret store. */
  signPriv: string;
  signPub: string;
  agreePriv: string;
  agreePub: string;
  deviceId: string;
}

const der = (k: KeyObject, type: 'spki' | 'pkcs8') => (type === 'spki' ? k.export({ type: 'spki', format: 'der' }) : k.export({ type: 'pkcs8', format: 'der' })).toString('base64');

export function deviceIdOf(spkiB64: string): string {
  return createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex');
}

export function generateDeviceKeys(): DeviceKeys {
  const s = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const a = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signPub = der(s.publicKey, 'spki');
  return { signPriv: der(s.privateKey, 'pkcs8'), signPub, agreePriv: der(a.privateKey, 'pkcs8'), agreePub: der(a.publicKey, 'spki'), deviceId: deviceIdOf(signPub) };
}

const priv = (b64: string) => createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
const pub = (b64: string) => {
  const k = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  if (k.asymmetricKeyType !== 'ec' || k.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Expected a P-256 public key');
  return k;
};

export function relayAuthMessage(nonce: string, deviceId: string): Buffer {
  return Buffer.from(`${RELAY_AUTH_CONTEXT}|${nonce}|${deviceId}`);
}

/** ECDSA P-256 / SHA-256, DER-encoded (what Java's SHA256withECDSA produces). */
export function signB64(signPrivB64: string, data: Buffer): string {
  return edSign('sha256', data, priv(signPrivB64)).toString('base64');
}

export function verifyB64(signPubB64: string, data: Buffer, sigB64: string): boolean {
  try {
    return edVerify('sha256', data, pub(signPubB64), Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

function hkdf(ikm: Buffer, salt: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, createHash('sha256').update(salt).digest(), Buffer.from(info), 32));
}

/** The directional message key from `from` to `to`, derived from the static ECDH secret. */
export function messageKey(myAgreePrivB64: string, peerAgreePubB64: string, fromId: string, toId: string): Buffer {
  const z = diffieHellman({ privateKey: priv(myAgreePrivB64), publicKey: pub(peerAgreePubB64) });
  return hkdf(z, 'jarvis-e2e-v1', `msg|${fromId}|${toId}`);
}

/** The pairing key, from the one-time secret shown only in the QR code. */
export function pairingKey(secretB64: string, room: string): Buffer {
  return hkdf(Buffer.from(secretB64, 'base64'), 'jarvis-pair-v1', `pair|${room}`);
}

export const msgAad = (fromId: string, toId: string) => Buffer.from(`jarvis-msg-v1|${fromId}|${toId}`);
export const pairAad = (room: string, fromId: string) => Buffer.from(`jarvis-pair-v1|${room}|${fromId}`);

/** AES-256-GCM: base64(nonce ‖ ciphertext ‖ tag). */
export function seal(key: Buffer, plaintext: string, aad: Buffer, nonce: Buffer = randomBytes(12)): string {
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad);
  const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]).toString('base64');
}

/** Throws if the ciphertext, nonce, tag or AAD were tampered with. */
export function open(key: Buffer, sealedB64: string, aad: Buffer): string {
  const raw = Buffer.from(sealedB64, 'base64');
  if (raw.length < 12 + 16) throw new Error('Ciphertext too short');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(aad);
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
}

export const randomB64Url = (bytes: number) => randomBytes(bytes).toString('base64url');
