package ai.jarvis.mobile

import ai.jarvis.mobile.crypto.KeystoreIdentity
import ai.jarvis.mobile.data.JarvisDatabase
import ai.jarvis.mobile.data.Prefs
import ai.jarvis.mobile.data.ProviderConfig
import ai.jarvis.mobile.data.SecretStore
import ai.jarvis.mobile.remote.RelayConnection
import ai.jarvis.mobile.remote.RemoteSession
import ai.jarvis.mobile.runtime.ActivityLog
import ai.jarvis.mobile.runtime.AnthropicProvider
import ai.jarvis.mobile.runtime.MobileAgents
import ai.jarvis.mobile.runtime.MobileConversationManager
import ai.jarvis.mobile.runtime.MobileExecutionRouter
import ai.jarvis.mobile.runtime.MobileMemoryManager
import ai.jarvis.mobile.runtime.MobileSession
import ai.jarvis.mobile.runtime.MobilePermissionManager
import ai.jarvis.mobile.runtime.MobileTaskManager
import ai.jarvis.mobile.runtime.MobileToolRegistry
import ai.jarvis.mobile.runtime.ModelProvider
import ai.jarvis.mobile.runtime.OpenAiCompatibleProvider
import ai.jarvis.mobile.runtime.tools.androidTools
import ai.jarvis.mobile.voice.SpeechInput
import ai.jarvis.mobile.voice.Speaker
import android.app.Application
import android.content.Context
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Manual dependency container: one instance per process. */
class AppContainer(val context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val http: OkHttpClient = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).connectTimeout(15, TimeUnit.SECONDS).readTimeout(180, TimeUnit.SECONDS).build()
    val db: JarvisDatabase = JarvisDatabase.open(context)
    val prefs = Prefs(context)
    val secrets = SecretStore(context)
    val activity = ActivityLog(db.activity())
    val speaker = Speaker(context)
    val speech = SpeechInput(context)

    // ---------------------------------------------------------------- Remote PC mode
    val identity by lazy { KeystoreIdentity.get() }
    val relay by lazy { RelayConnection(http, identity, scope) }
    val remote by lazy { RemoteSession(identity, relay, prefs, scope, BuildConfig.VERSION_NAME, "${Build.MANUFACTURER} ${Build.MODEL}".trim()) }

    // ---------------------------------------------------------------- Mobile mode (independent of the PC)
    val memory = MobileMemoryManager(db.memories(), activity)
    val conversations = MobileConversationManager(db.conversations())
    val tasks = MobileTaskManager(context, db.tasks(), activity)
    val registry = MobileToolRegistry(androidTools(memory, tasks, speaker))
    @Volatile private var policies: Map<String, String> = emptyMap()
    val permissions = MobilePermissionManager(db.activity()) { policies }
    @Volatile private var providerConfig = ProviderConfig()
    val router = MobileExecutionRouter(context, ::provider, registry, permissions, conversations, memory, activity)
    val agents = MobileAgents(context, db.tasks(), db.activity(), registry, permissions, activity)
    @Volatile private var speakReplies = true
    val mobile = MobileSession(scope, router, activity, speaker) { speakReplies }

    init {
        scope.launch { prefs.policies.collect { policies = it } }
        scope.launch { prefs.provider.collect { providerConfig = it } }
        scope.launch { prefs.speakReplies.collect { speakReplies = it } }
    }

    /** The configured model provider, or null (Mobile Jarvis then handles direct commands only). */
    fun provider(): ModelProvider? {
        val c = providerConfig
        val key = secrets.get(API_KEY)
        return when (c.kind) {
            "anthropic" -> if (key.isNullOrBlank() || c.model.isBlank()) null else AnthropicProvider(http, key, c.model)
            "openai_compatible" -> if (c.baseUrl.isBlank() || c.model.isBlank()) null else OpenAiCompatibleProvider(http, c.baseUrl, key, c.model)
            else -> null
        }
    }

    companion object { const val API_KEY = "provider.apiKey" }
}

class JarvisApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
