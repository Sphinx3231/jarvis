package ai.jarvis.mobile.crypto

import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Jarvis Mobile cryptography — the same construction as shared/protocol/crypto.ts, with JCA only:
 *  identity: ECDSA P-256 (SHA256withECDSA, DER); device id = hex SHA-256 of the SPKI DER
 *  end-to-end: P-256 ECDH → HKDF-SHA256 (RFC 5869) → AES-256-GCM, one key per direction,
 *              AAD "jarvis-msg-v1|from|to", 96-bit random nonce, output nonce‖ciphertext‖tag
 *  pairing: AES-256-GCM with HKDF(QR secret, room)
 * Verified against Node with the vectors in shared/protocol/fixtures/crypto-vectors.json.
 */
object E2E {
    private val rng = SecureRandom()
    fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    fun unb64(s: String): ByteArray = if (s.contains('-') || s.contains('_')) Base64.getUrlDecoder().decode(s) else Base64.getDecoder().decode(s)

    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)
    fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    fun deviceIdOf(spkiB64: String): String = hex(sha256(unb64(spkiB64)))

    fun publicKey(spkiB64: String): PublicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(unb64(spkiB64)))

    fun relayAuthMessage(nonce: String, deviceId: String) = "jarvis-relay-auth-v1|$nonce|$deviceId".toByteArray()
    fun msgAad(from: String, to: String) = "jarvis-msg-v1|$from|$to".toByteArray()
    fun pairAad(room: String, from: String) = "jarvis-pair-v1|$room|$from".toByteArray()

    fun verify(signPubB64: String, data: ByteArray, sigB64: String): Boolean = try {
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(publicKey(signPubB64)); update(data); verify(unb64(sigB64))
        }
    } catch (e: Exception) {
        false
    }

    /** RFC 5869 HKDF-SHA256; salt = SHA-256(saltLabel) to match the Node side. */
    fun hkdf(ikm: ByteArray, saltLabel: String, info: String, length: Int = 32): ByteArray {
        val salt = sha256(saltLabel.toByteArray())
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var t = ByteArray(0)
        var pos = 0
        var i = 1
        while (pos < length) {
            mac.update(t); mac.update(info.toByteArray()); mac.update(i.toByte())
            t = mac.doFinal()
            val n = minOf(t.size, length - pos)
            System.arraycopy(t, 0, out, pos, n)
            pos += n; i++
        }
        return out
    }

    fun messageKey(sharedSecret: ByteArray, from: String, to: String) = hkdf(sharedSecret, "jarvis-e2e-v1", "msg|$from|$to")
    fun pairingKey(secretB64: String, room: String) = hkdf(unb64(secretB64), "jarvis-pair-v1", "pair|$room")

    fun seal(key: ByteArray, plaintext: String, aad: ByteArray, nonce: ByteArray = ByteArray(12).also { rng.nextBytes(it) }): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        c.updateAAD(aad)
        return b64(nonce + c.doFinal(plaintext.toByteArray(Charsets.UTF_8)))
    }

    /** Throws if anything was tampered with (ciphertext, tag, nonce, or the AAD/addressing). */
    fun open(key: ByteArray, sealedB64: String, aad: ByteArray): String {
        val raw = unb64(sealedB64)
        require(raw.size >= 28) { "Ciphertext too short" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, raw, 0, 12))
        c.updateAAD(aad)
        return String(c.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
    }

    fun randomId(prefix: String, bytes: Int = 9): String {
        val b = ByteArray(bytes).also { rng.nextBytes(it) }
        return prefix + hex(b)
    }
}

/** A device identity: a signing key (relay authentication) and an agreement key (E2E). */
interface DeviceIdentity {
    val deviceId: String
    val signPubB64: String
    val agreePubB64: String
    fun sign(data: ByteArray): String
    /** P-256 ECDH with a peer's agreement public key → the shared secret (x-coordinate). */
    fun agree(peerAgreePubB64: String): ByteArray
}

/** Keys held in memory — used by tests and the Node-compatible vectors; the app uses KeystoreIdentity. */
class SoftwareIdentity(private val sign: KeyPair, private val agreeKeys: KeyPair) : DeviceIdentity {
    override val signPubB64: String = E2E.b64(sign.public.encoded)
    override val agreePubB64: String = E2E.b64(agreeKeys.public.encoded)
    override val deviceId: String = E2E.deviceIdOf(signPubB64)

    override fun sign(data: ByteArray): String = Signature.getInstance("SHA256withECDSA").run {
        initSign(sign.private); update(data); E2E.b64(sign())
    }

    override fun agree(peerAgreePubB64: String): ByteArray = KeyAgreement.getInstance("ECDH").run {
        init(agreeKeys.private); doPhase(E2E.publicKey(peerAgreePubB64), true); generateSecret()
    }

    companion object {
        fun generate(): SoftwareIdentity {
            fun pair() = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
            return SoftwareIdentity(pair(), pair())
        }

        fun fromDer(signPriv: String, signPub: String, agreePriv: String, agreePub: String): SoftwareIdentity {
            val kf = KeyFactory.getInstance("EC")
            fun priv(s: String): PrivateKey = kf.generatePrivate(PKCS8EncodedKeySpec(E2E.unb64(s)))
            return SoftwareIdentity(KeyPair(E2E.publicKey(signPub), priv(signPriv)), KeyPair(E2E.publicKey(agreePub), priv(agreePriv)))
        }
    }
}
