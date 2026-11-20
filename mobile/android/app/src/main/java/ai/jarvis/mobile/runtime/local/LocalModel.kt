package ai.jarvis.mobile.runtime.local

import ai.jarvis.mobile.runtime.ModelProvider
import ai.jarvis.mobile.runtime.ModelRequest
import ai.jarvis.mobile.runtime.ModelResponse
import ai.jarvis.mobile.runtime.ProviderUnavailable
import android.content.Context
import android.os.StatFs
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.tool
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import android.app.DownloadManager
import android.net.Uri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/** An on-device model: where it comes from and how to check it. */
data class LocalModelSpec(
    val id: String,
    val file: String,
    val name: String,
    val summary: String,
    val license: String,
    val source: String,
    /** Pinned download (an exact revision, so the checksum below always applies). */
    val url: String,
    val sha256: String,
    val sizeBytes: Long,
)

/**
 * Google's Gemma 4 for phones (LiteRT-LM format; text, images and native function calling).
 * Sizes and memory from Google's model cards (Galaxy S26 Ultra): E2B ≈ 1.4–1.7 GB of RAM on the
 * CPU / ~0.7 GB on the GPU; E4B ≈ 2.8–3.3 GB / ~0.8 GB.
 */
object LocalModels {
    val GEMMA4_E2B = LocalModelSpec(
        id = "gemma4_e2b",
        file = "gemma-4-E2B-it.litertlm",
        name = "Gemma 4 E2B",
        summary = "Recommended: fast, light on memory — fine next to a game",
        license = "Apache-2.0 (Google)",
        source = "huggingface.co/litert-community/gemma-4-E2B-it-litert-lm",
        url = "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/2e12bfd869b2962984f97a1f2a26807316d534cc/gemma-4-E2B-it.litertlm",
        sha256 = "181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c",
        sizeBytes = 2_588_147_712L,
    )
    val GEMMA4_E4B = LocalModelSpec(
        id = "gemma4_e4b",
        file = "gemma-4-E4B-it.litertlm",
        name = "Gemma 4 E4B",
        summary = "Highest quality that fits a 12 GB phone; about twice as slow and memory-hungry",
        license = "Apache-2.0 (Google)",
        source = "huggingface.co/litert-community/gemma-4-E4B-it-litert-lm",
        url = "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/f254b5ba6e36f7d89cc7892e268e9877bc20f0a0/gemma-4-E4B-it.litertlm",
        sha256 = "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0",
        sizeBytes = 3_659_530_240L,
    )
    val ALL = listOf(GEMMA4_E2B, GEMMA4_E4B)
    fun byId(id: String?) = ALL.firstOrNull { it.id == id } ?: GEMMA4_E2B

    /** Files of models this version no longer uses (Qwen2.5 from 0.2.0): removed to free space. */
    fun removeRetired(context: Context) {
        val retired = listOf("qwen2.5-1.5b-instruct-q8.task")
        for (dir in listOfNotNull(File(context.filesDir, "models"), context.getExternalFilesDir("models")))
            dir.listFiles()?.filter { f -> retired.any { f.name.startsWith(it) } }?.forEach { it.delete() }
    }
}

/**
 * Where the on-device model lives and whether it's usable. Two sources:
 *  - bundled in the APK (builds with -Pjarvis.bundleModel=true): copied out once on first launch;
 *  - downloaded on the phone (the default APK, which stays small): fetched by [ModelDownloader],
 *    then checked against the pinned SHA-256 before it is ever loaded.
 */
class LocalModelStore(
    val spec: LocalModelSpec,
    /** The model as a bundled asset (stream + length), or null when this APK doesn't include it. */
    private val bundled: () -> Pair<InputStream, Long>?,
    /** Where a bundled model is unpacked. */
    private val unpackDir: File,
    /** Where a downloaded model lands (app-specific storage; removed with the app). */
    val downloadFile: File?,
    private val freeBytes: (File) -> Long = { runCatching { StatFs(it.path).availableBytes }.getOrDefault(Long.MAX_VALUE) },
    private val sha256Of: (File) -> String = ::sha256Hex,
) {
    sealed interface State {
        data object Checking : State
        /** Not on the phone yet: download it (default APK). */
        data object NotDownloaded : State
        data class Downloading(val fraction: Float) : State
        data object Verifying : State
        data class Preparing(val fraction: Float) : State
        data class Ready(val file: File) : State
        data class Failed(val reason: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Checking)
    val state: StateFlow<State> = _state
    private val lock = Mutex()

    fun setDownloading(fraction: Float) { _state.value = State.Downloading(fraction) }
    fun setFailed(reason: String) { _state.value = State.Failed(reason) }

    /** Work out the state without throwing (app start, after a download finishes). */
    suspend fun refresh(): State {
        runCatching { ensureReady() }
        return state.value
    }

    /** Returns the verified model file, unpacking a bundled model first if needed. */
    suspend fun ensureReady(): File = lock.withLock {
        (state.value as? State.Ready)?.let { if (it.file.isFile) return it.file }
        withContext(Dispatchers.IO) {
            bundled()?.let { (input, length) -> return@withContext input.use { unpack(it, length) } }
            val f = downloadFile?.takeIf { it.isFile }
            if (f == null) {
                if (state.value !is State.Downloading) _state.value = State.NotDownloaded
                throw ProviderUnavailable("The offline model isn't on this phone yet — tap “Download” on the home screen (${spec.sizeBytes / 1_000_000} MB)")
            }
            verify(f)
        }
    }

    /** Size + SHA-256 against the pinned values; a bad file is deleted. Remembered once verified. */
    private fun verify(f: File): File {
        val marker = File(f.path + ".verified")
        val stamp = "${spec.sha256}:${f.length()}:${f.lastModified()}"
        if (marker.isFile && marker.readText() == stamp) return f.also { _state.value = State.Ready(it) }
        if (f.length() != spec.sizeBytes) {
            f.delete()
            _state.value = State.Failed("The downloaded model was incomplete; download it again")
            throw ProviderUnavailable("The downloaded model was incomplete; download it again")
        }
        _state.value = State.Verifying
        val actual = sha256Of(f)
        if (!actual.equals(spec.sha256, ignoreCase = true)) {
            f.delete()
            marker.delete()
            _state.value = State.Failed("The downloaded model didn't match its checksum and was deleted; download it again")
            throw ProviderUnavailable("The downloaded model didn't match its checksum")
        }
        marker.writeText(stamp)
        _state.value = State.Ready(f)
        return f
    }

    private fun unpack(inp: InputStream, length: Long): File {
        val target = File(unpackDir, spec.file)
        if (target.isFile && target.length() == length) return target.also { _state.value = State.Ready(it) }
        unpackDir.mkdirs()
        val part = File(unpackDir, "${spec.file}.part").apply { delete() }
        val needed = length + 64L * 1024 * 1024 - (if (target.isFile) target.length() else 0)
        if (freeBytes(unpackDir) < needed) {
            val msg = "Not enough free storage to unpack the on-device model: needs ${needed / 1_000_000} MB"
            _state.value = State.Failed(msg)
            throw ProviderUnavailable(msg)
        }
        try {
            part.outputStream().use { out ->
                val buf = ByteArray(4 * 1024 * 1024)
                var done = 0L
                var last = -1
                while (true) {
                    val n = inp.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    done += n
                    val pct = ((done * 100) / length).toInt()
                    if (pct != last) { last = pct; _state.value = State.Preparing(done.toFloat() / length) }
                }
            }
            if (part.length() != length) throw ProviderUnavailable("The on-device model was not copied completely")
            target.delete()
            if (!part.renameTo(target)) throw ProviderUnavailable("Could not finish unpacking the on-device model")
        } catch (e: Exception) {
            part.delete()
            _state.value = State.Failed(e.message ?: "Could not unpack the on-device model")
            throw if (e is ProviderUnavailable) e else ProviderUnavailable(e.message ?: "Could not unpack the on-device model")
        }
        _state.value = State.Ready(target)
        return target
    }

    companion object {
        fun forApp(context: Context, spec: LocalModelSpec, bundledFile: String): LocalModelStore = LocalModelStore(
            spec = spec,
            bundled = {
                if (bundledFile != spec.file) null
                else runCatching { context.assets.openFd(bundledFile).let { fd -> fd.createInputStream() to fd.length } }.getOrNull()
            },
            unpackDir = File(context.filesDir, "models"),
            downloadFile = context.getExternalFilesDir("models")?.let { File(it, spec.file) },
        )
    }
}

fun sha256Hex(f: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    f.inputStream().use { inp ->
        val buf = ByteArray(4 * 1024 * 1024)
        while (true) { val n = inp.read(buf); if (n < 0) break; md.update(buf, 0, n) }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
}

/**
 * Downloads the model on the phone with Android's DownloadManager: it keeps going in the
 * background and across app restarts, resumes after network drops, and shows its own
 * notification. Only ever started by the user's tap.
 */
class ModelDownloader(
    private val context: Context,
    private val store: LocalModelStore,
    private val scope: CoroutineScope,
    private val freeBytes: (File) -> Long = { runCatching { StatFs(it.path).availableBytes }.getOrDefault(Long.MAX_VALUE) },
) {
    private val prefs = context.getSharedPreferences("jarvis_model_download", Context.MODE_PRIVATE)
    private val dm get() = context.getSystemService(DownloadManager::class.java)
    private var watcher: Job? = null

    /** Resume watching a download started before the app was closed. */
    fun resume() { if (prefs.getLong(key, -1) >= 0) watch() }

    fun start(allowMobileData: Boolean) {
        val target = store.downloadFile ?: return store.setFailed("This phone has no app storage available for the model")
        cancel()
        target.parentFile?.mkdirs()
        target.delete()
        File(target.path + ".verified").delete()
        if (freeBytes(target.parentFile!!) < store.spec.sizeBytes + 200L * 1024 * 1024) return store.setFailed("Not enough free storage: the model needs ${(store.spec.sizeBytes + 200L * 1024 * 1024) / 1_000_000} MB")
        val req = DownloadManager.Request(Uri.parse(store.spec.url))
            .setTitle("Jarvis offline AI model")
            .setDescription("${store.spec.name} · ${store.spec.sizeBytes / 1_000_000} MB")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalFilesDir(context, "models", target.name)
            .setAllowedOverMetered(allowMobileData)
            .setAllowedOverRoaming(false)
        prefs.edit().putLong(key, dm.enqueue(req)).apply()
        store.setDownloading(0f)
        watch()
    }

    fun cancel() {
        watcher?.cancel()
        prefs.getLong(key, -1).takeIf { it >= 0 }?.let { runCatching { dm.remove(it) } }
        prefs.edit().remove(key).apply()
    }

    private fun watch() {
        watcher?.cancel()
        watcher = scope.launch(Dispatchers.IO) {
            while (true) {
                val id = prefs.getLong(key, -1).takeIf { it >= 0 } ?: return@launch
                val row = dm.query(DownloadManager.Query().setFilterById(id))?.use { c ->
                    if (!c.moveToFirst()) null
                    else Triple(c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)), c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)), c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)))
                }
                when (row?.first) {
                    null -> { prefs.edit().remove(key).apply(); store.refresh(); return@launch }
                    DownloadManager.STATUS_SUCCESSFUL -> { prefs.edit().remove(key).apply(); store.refresh(); return@launch }
                    DownloadManager.STATUS_FAILED -> {
                        prefs.edit().remove(key).apply()
                        runCatching { dm.remove(id) }
                        store.setFailed("The download failed (${reason(row.third)}); tap Download to try again")
                        return@launch
                    }
                    DownloadManager.STATUS_PAUSED -> store.setDownloading(row.second.toFloat() / store.spec.sizeBytes)
                    else -> store.setDownloading(row.second.toFloat() / store.spec.sizeBytes)
                }
                delay(1000)
            }
        }
    }

    private fun reason(code: Int) = when (code) {
        DownloadManager.ERROR_INSUFFICIENT_SPACE -> "not enough storage"
        DownloadManager.ERROR_HTTP_DATA_ERROR, DownloadManager.ERROR_CANNOT_RESUME -> "connection problem"
        DownloadManager.ERROR_TOO_MANY_REDIRECTS, DownloadManager.ERROR_UNHANDLED_HTTP_CODE -> "server error"
        else -> "error $code"
    }

    /** One download per model. */
    private val key = "downloadId.${store.spec.id}"

    /** Delete the downloaded model (frees its storage). */
    fun delete() {
        cancel()
        store.downloadFile?.let { File(it.path + ".verified").delete(); it.delete() }
        scope.launch { store.refresh() }
    }
}

/**
 * Runs the selected on-device model with Google's LiteRT-LM (GPU when available, else CPU).
 * Nothing leaves the phone. The model's own chat template and native function calling are used;
 * the calls it proposes come back to the router (automatic tool calling is off), which validates
 * and authorizes each one. Loaded on first use, released under memory pressure or on model change.
 */
class OnDeviceProvider(private val context: Context, private val store: () -> LocalModelStore) : ModelProvider {
    override val id = "on_device"
    override val displayName get() = "${store().spec.name} (on this phone)"
    override val onDevice = true

    private val lock = Mutex()
    private var engine: Engine? = null
    private var loaded: File? = null
    @Volatile var backend: String? = null
        private set

    override suspend fun complete(request: ModelRequest): ModelResponse = lock.withLock {
        val file = store().ensureReady()
        val eng = engine?.takeIf { loaded == file } ?: run { release(); load(file).also { engine = it; loaded = file } }
        withContext(Dispatchers.Default) {
            val messages = LocalFormat.toMessages(request.turns)
            val config = ConversationConfig(
                systemInstruction = Contents.of(request.system),
                initialMessages = messages.dropLast(1),
                tools = request.tools.map { tool(LocalFormat.openApiTool(it)) },
                samplerConfig = SamplerConfig(topK = 40, topP = 0.95, temperature = 0.6),
                automaticToolCalling = false,
            )
            try {
                eng.createConversation(config).use { conv -> LocalFormat.fromMessage(conv.sendMessage(messages.last())) }
            } catch (e: Exception) {
                throw ProviderUnavailable("The on-device model failed: ${e.message ?: e.javaClass.simpleName}")
            }
        }
    }

    private suspend fun load(file: File): Engine = withContext(Dispatchers.Default) {
        fun open(b: Backend) = Engine(EngineConfig(modelPath = file.path, backend = b, maxNumTokens = MAX_TOKENS, cacheDir = context.cacheDir.path)).also { it.initialize() }
        try {
            open(Backend.GPU()).also { backend = "GPU" }
        } catch (gpu: Throwable) {
            try {
                open(Backend.CPU()).also { backend = "CPU" }
            } catch (cpu: Throwable) {
                throw ProviderUnavailable("Couldn't start the on-device model: ${cpu.message ?: cpu.javaClass.simpleName}")
            }
        }
    }

    private fun release() { runCatching { engine?.close() }; engine = null; loaded = null; backend = null }

    /** Free the memory the model holds (it reloads on the next message). */
    fun unload() {
        if (!lock.tryLock()) return
        try { release() } finally { lock.unlock() }
    }

    companion object { const val MAX_TOKENS = 4096 }
}
