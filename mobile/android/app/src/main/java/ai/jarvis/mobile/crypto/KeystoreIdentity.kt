package ai.jarvis.mobile.crypto

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import javax.crypto.KeyAgreement

/**
 * The phone's identity in the Android Keystore: the private keys are generated inside it
 * (hardware-backed where the device has a TEE/StrongBox) and can never be exported. Only the
 * public keys leave the device.
 */
class KeystoreIdentity private constructor() : DeviceIdentity {
    private val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    init {
        if (!ks.containsAlias(SIGN)) generate(SIGN, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
        if (!ks.containsAlias(AGREE)) generate(AGREE, KeyProperties.PURPOSE_AGREE_KEY)
    }

    private fun generate(alias: String, purposes: Int) {
        val spec = KeyGenParameterSpec.Builder(alias, purposes)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .apply { if (purposes and KeyProperties.PURPOSE_SIGN != 0) setDigests(KeyProperties.DIGEST_SHA256) }
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
    }

    override val signPubB64: String = E2E.b64(ks.getCertificate(SIGN).publicKey.encoded)
    override val agreePubB64: String = E2E.b64(ks.getCertificate(AGREE).publicKey.encoded)
    override val deviceId: String = E2E.deviceIdOf(signPubB64)

    override fun sign(data: ByteArray): String = Signature.getInstance("SHA256withECDSA").run {
        initSign(ks.getKey(SIGN, null) as PrivateKey); update(data); E2E.b64(sign())
    }

    override fun agree(peerAgreePubB64: String): ByteArray = KeyAgreement.getInstance("ECDH", "AndroidKeyStore").run {
        init(ks.getKey(AGREE, null) as PrivateKey); doPhase(E2E.publicKey(peerAgreePubB64), true); generateSecret()
    }

    /** Throw the identity away (unpair everywhere): new keys = a new device id. */
    fun destroy() {
        ks.deleteEntry(SIGN)
        ks.deleteEntry(AGREE)
    }

    companion object {
        private const val SIGN = "jarvis.identity.sign.v1"
        private const val AGREE = "jarvis.identity.agree.v1"
        @Volatile private var instance: KeystoreIdentity? = null
        fun get(): KeystoreIdentity = instance ?: synchronized(this) { instance ?: KeystoreIdentity().also { instance = it } }
        fun reset() = synchronized(this) { instance?.destroy(); instance = null }
    }
}
