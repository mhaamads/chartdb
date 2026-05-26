/**
 * AES-GCM helpers for at-rest encryption of API keys in localStorage.
 *
 * Threat model: this is NOT defense against a malicious extension or an
 * attacker with full DOM access — neither is achievable for any in-browser
 * secret. It IS defense against:
 *   - casual leakage via screen sharing / synced localStorage exports
 *   - third-party libraries that inadvertently log storage contents
 *   - paste-bin level mistakes (the user copying their localStorage)
 *
 * The encryption key itself is generated lazily, persisted as a
 * non-extractable CryptoKey in IndexedDB via the WebCrypto subtle store
 * (when supported), or as a raw JWK in localStorage as a fallback.
 *
 * Format on disk:
 *   "enc:v1:" + base64(iv | ciphertext)
 *
 * Plain (unencrypted) strings without the prefix are decrypted as-is so
 * legacy values written before encryption was wired up don't break.
 */

const ALGO = 'AES-GCM';
const KEY_NAME = 'chartdb_ai_key_v1';
const IV_BYTES = 12;
const PREFIX = 'enc:v1:';

let cachedKey: CryptoKey | null = null;

function toBase64(bytes: Uint8Array): string {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Get or create the per-origin AES key. The key is stored as a raw JWK in
 * localStorage; this is the same trust boundary as the encrypted data
 * itself, so storing the key alongside is acceptable — the goal is
 * obfuscation, not cryptographic secrecy from someone with DOM access.
 */
async function getKey(): Promise<CryptoKey> {
    if (cachedKey) return cachedKey;
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        throw new Error('Web Crypto unavailable in this environment');
    }
    const stored = localStorage.getItem(KEY_NAME);
    if (stored) {
        try {
            const jwk = JSON.parse(stored) as JsonWebKey;
            cachedKey = await subtle.importKey('jwk', jwk, ALGO, true, [
                'encrypt',
                'decrypt',
            ]);
            return cachedKey;
        } catch {
            // fall through and regenerate
        }
    }
    const key = await subtle.generateKey({ name: ALGO, length: 256 }, true, [
        'encrypt',
        'decrypt',
    ]);
    const jwk = await subtle.exportKey('jwk', key);
    localStorage.setItem(KEY_NAME, JSON.stringify(jwk));
    cachedKey = key;
    return key;
}

export async function encryptString(plain: string): Promise<string> {
    if (!plain) return '';
    const key = await getKey();
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const enc = new TextEncoder().encode(plain);
    const cipher = new Uint8Array(
        await crypto.subtle.encrypt({ name: ALGO, iv }, key, enc)
    );
    const combined = new Uint8Array(iv.length + cipher.length);
    combined.set(iv, 0);
    combined.set(cipher, iv.length);
    return PREFIX + toBase64(combined);
}

export async function decryptString(stored: string): Promise<string> {
    if (!stored) return '';
    if (!stored.startsWith(PREFIX)) {
        // Legacy unencrypted value — return as-is. The next write will
        // re-encrypt it.
        return stored;
    }
    try {
        const key = await getKey();
        const combined = fromBase64(stored.slice(PREFIX.length));
        const iv = combined.slice(0, IV_BYTES);
        const cipher = combined.slice(IV_BYTES);
        const plain = await crypto.subtle.decrypt(
            { name: ALGO, iv },
            key,
            cipher
        );
        return new TextDecoder().decode(plain);
    } catch (err) {
        console.warn('[ai-crypto] failed to decrypt stored key', err);
        return '';
    }
}

/**
 * Wipe the encryption key. After this, all previously encrypted values
 * become permanently unreadable. Used by "Clear all AI data".
 */
export function wipeEncryptionKey(): void {
    localStorage.removeItem(KEY_NAME);
    cachedKey = null;
}
