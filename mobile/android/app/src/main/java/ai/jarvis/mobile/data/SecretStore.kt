package ai.jarvis.mobile.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Secrets (model-provider API keys) encrypted with an AES-256-GCM key that lives in the Android
 * Keystore and can't be exported. Only ciphertext is written to app storage.
 */
class SecretStore(context: Context) {
    private val prefs = context.getSharedPreferences("jarvis_secrets", Context.MODE_PRIVATE)
    private val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun key(): SecretKey {
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        return gen.generateKey()
    }

    fun set(name: String, value: String?) {
        if (value.isNullOrEmpty()) return prefs.edit().remove(name).apply()
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val out = c.iv + c.doFinal(value.toByteArray())
        prefs.edit().putString(name, Base64.getEncoder().encodeToString(out)).apply()
    }

    fun get(name: String): String? {
        val raw = prefs.getString(name, null)?.let { Base64.getDecoder().decode(it) } ?: return null
        return runCatching {
            val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12)) }
            String(c.doFinal(raw, 12, raw.size - 12))
        }.getOrNull()
    }

    fun has(name: String) = prefs.contains(name)

    companion object { private const val ALIAS = "jarvis.secrets.v1" }
}
