package ai.jarvis.mobile.data

import ai.jarvis.mobile.protocol.JarvisJson
import ai.jarvis.mobile.remote.PairedPc
import ai.jarvis.mobile.remote.PairingStore
import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.store by preferencesDataStore("jarvis_prefs")

/** Which device executes commands right now. */
enum class Mode { REMOTE_PC, MOBILE }

/** kind: on_device (the model bundled in the app — default) | anthropic | openai_compatible | none */
data class ProviderConfig(val kind: String = "on_device", val baseUrl: String = "", val model: String = "")

/** App preferences (DataStore). Secrets are not here — see SecretStore. */
class Prefs(private val context: Context) : PairingStore {
    private object K {
        val MODE = stringPreferencesKey("mode")
        val ONBOARDED = booleanPreferencesKey("onboarded")
        val PROVIDER_KIND = stringPreferencesKey("provider.kind")
        val PROVIDER_URL = stringPreferencesKey("provider.baseUrl")
        val PROVIDER_MODEL = stringPreferencesKey("provider.model")
        val SPEAK_REPLIES = booleanPreferencesKey("voice.speakReplies")
        val PAIRED_PC = stringPreferencesKey("remote.pairedPc")
        fun policy(tool: String) = stringPreferencesKey("policy.$tool")
    }

    val mode: Flow<Mode?> = context.store.data.map { p -> p[K.MODE]?.let { runCatching { Mode.valueOf(it) }.getOrNull() } }
    val onboarded: Flow<Boolean> = context.store.data.map { it[K.ONBOARDED] ?: false }
    val provider: Flow<ProviderConfig> = context.store.data.map { ProviderConfig(it[K.PROVIDER_KIND] ?: "on_device", it[K.PROVIDER_URL] ?: "", it[K.PROVIDER_MODEL] ?: "") }
    val speakReplies: Flow<Boolean> = context.store.data.map { it[K.SPEAK_REPLIES] ?: true }
    val policies: Flow<Map<String, String>> = context.store.data.map { p -> p.asMap().filterKeys { it.name.startsWith("policy.") }.map { (k, v) -> k.name.removePrefix("policy.") to v.toString() }.toMap() }

    suspend fun setMode(m: Mode) = context.store.edit { it[K.MODE] = m.name; it[K.ONBOARDED] = true }
    suspend fun setProvider(c: ProviderConfig) = context.store.edit { it[K.PROVIDER_KIND] = c.kind; it[K.PROVIDER_URL] = c.baseUrl; it[K.PROVIDER_MODEL] = c.model }
    suspend fun setSpeakReplies(on: Boolean) = context.store.edit { it[K.SPEAK_REPLIES] = on }
    suspend fun setPolicy(tool: String, policy: String) = context.store.edit { it[K.policy(tool)] = policy }

    override suspend fun load(): PairedPc? = context.store.data.first()[K.PAIRED_PC]?.let { runCatching { JarvisJson.decodeFromString(PairedPc.serializer(), it) }.getOrNull() }
    override suspend fun save(pc: PairedPc?) {
        context.store.edit { if (pc == null) it.remove(K.PAIRED_PC) else it[K.PAIRED_PC] = JarvisJson.encodeToString(PairedPc.serializer(), pc) }
    }

    @Suppress("unused") private fun Preferences.dump() = asMap()
}
