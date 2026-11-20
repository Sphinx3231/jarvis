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
import ai.jarvis.mobile.runtime.brain.Brain
import ai.jarvis.mobile.runtime.brain.BrainSettings
import ai.jarvis.mobile.runtime.brain.FileNoteStore
import ai.jarvis.mobile.runtime.brain.NoteStore
import ai.jarvis.mobile.runtime.brain.SafNoteStore
import ai.jarvis.mobile.runtime.brain.brainTools
import ai.jarvis.mobile.runtime.local.LocalModelStore
import ai.jarvis.mobile.runtime.local.LocalModels
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File
import ai.jarvis.mobile.runtime.local.ModelDownloader
import ai.jarvis.mobile.runtime.local.OnDeviceProvider
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
    private val relayLazy = lazy { RelayConnection(http, identity, scope) }
    val relay by relayLazy
    val remote by lazy { RemoteSession(identity, relay, prefs, scope, BuildConfig.VERSION_NAME, "${Build.MANUFACTURER} ${Build.MODEL}".trim()) }

    // ---------------------------------------------------------------- Mobile mode (independent of the PC)
    // The live brain: the user's Obsidian vault (once connected) or a built-in notes folder.
    val brainSettings = BrainSettings(context)
    private val internalBrain = FileNoteStore(File(context.filesDir, "brain"), "Jarvis Brain (on this phone)")
    @Volatile private var vaultStore: NoteStore? = brainSettings.vaultUri?.let { SafNoteStore(context, it) }
    val brain = Brain { vaultStore ?: internalBrain }
    val memory = MobileMemoryManager(db.memories(), activity) { kind, content -> brain.logMemory(kind, content) }
    val conversations = MobileConversationManager(db.conversations())
    val tasks = MobileTaskManager(context, db.tasks(), activity)
    val registry = MobileToolRegistry(androidTools(memory, tasks, speaker) + brainTools(brain))
    @Volatile private var policies: Map<String, String> = emptyMap()
    val permissions = MobilePermissionManager(db.activity()) { policies }
    @Volatile private var providerConfig = ProviderConfig()
    /** On-device models (Gemma 4 E2B / E4B): downloaded on the phone, or bundled in custom builds. */
    val modelStores: Map<String, LocalModelStore> = LocalModels.ALL.associate { it.id to LocalModelStore.forApp(context, it, BuildConfig.BUNDLED_MODEL) }
    val modelDownloaders: Map<String, ModelDownloader> = modelStores.mapValues { (_, s) -> ModelDownloader(context, s, scope) }
    val selectedModel = MutableStateFlow(LocalModels.GEMMA4_E2B.id)
    val localModel: LocalModelStore get() = modelStores.getValue(selectedModel.value)
    val modelDownloader: ModelDownloader get() = modelDownloaders.getValue(selectedModel.value)
    val onDevice = OnDeviceProvider(context) { localModel }
    val router = MobileExecutionRouter(context, ::provider, registry, permissions, conversations, memory, activity, brain = brain, logToBrain = { brainSettings.saveConversations })
    val agents = MobileAgents(context, db.tasks(), db.activity(), registry, permissions, activity)
    @Volatile private var speakReplies = true
    val mobile = MobileSession(scope, router, activity, speaker) { speakReplies }

    init {
        scope.launch { prefs.policies.collect { policies = it } }
        scope.launch { prefs.provider.collect { providerConfig = it } }
        scope.launch {
            prefs.localModel.collect { id ->
                val changed = selectedModel.value != LocalModels.byId(id).id
                selectedModel.value = LocalModels.byId(id).id
                if (changed) onDevice.unload()
            }
        }
        scope.launch {
            LocalModels.removeRetired(context)
            seedBrain()
            // Know each model's state (unpack a bundled one / verify a downloaded one) before the first message.
            modelStores.values.forEach { launch { it.refresh() } }
        }
        scope.launch { prefs.speakReplies.collect { speakReplies = it } }
        watchNetwork()
        modelDownloaders.values.forEach { it.resume() }
    }

    /**
     * A pairing stays until the user unpairs (or revokes the phone on the PC); the connection to it is
     * re-established automatically. This just skips the backoff wait when the app comes to the
     * foreground or the phone gets a network again. (Android may suspend the socket while the app is
     * in the background; there is no always-on background service.)
     */
    fun reconnectNow() { if (relayLazy.isInitialized()) relay.reconnectNow() }

    private fun watchNetwork() {
        val cm = context.getSystemService(android.net.ConnectivityManager::class.java) ?: return
        runCatching {
            cm.registerDefaultNetworkCallback(object : android.net.ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: android.net.Network) = reconnectNow()
            })
        }
    }

    /** Point the brain at an Obsidian vault folder the user picked (null = the built-in brain). */
    fun setVault(uri: android.net.Uri?) {
        val old = brainSettings.vaultUri
        if (old != null && old != uri) runCatching { context.contentResolver.releasePersistableUriPermission(old, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
        if (uri != null) context.contentResolver.takePersistableUriPermission(uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        brainSettings.vaultUri = uri
        vaultStore = uri?.let { SafNoteStore(context, it) }
        brain.reset()
    }

    private suspend fun seedBrain() {
        if (internalBrain.read("Welcome.md") != null) return
        internalBrain.write("Welcome.md", """
            # Jarvis Brain

            This is Jarvis's notes vault on your phone. Jarvis reads relevant notes here when it answers, and files
            your conversations (Jarvis/Conversations) and the things you ask it to remember (Jarvis/Memory.md).

            Add notes about anything you want Jarvis to know: your routines, projects, preferences, people.

            Use Obsidian? In Jarvis → System → Brain, connect your vault folder and Jarvis will use that instead.
        """.trimIndent() + "\n")
    }

    /** The configured model provider, or null (Mobile Jarvis then handles direct commands only). */
    fun provider(): ModelProvider? {
        val c = providerConfig
        val key = secrets.get(API_KEY)
        return when (c.kind) {
            "on_device" -> onDevice
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

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        // In the background and the system wants memory back: release the on-device model (~2 GB).
        if (level >= TRIM_MEMORY_BACKGROUND && ::container.isInitialized) container.onDevice.unload()
    }
}
