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
    /**
     * Gemma 4 E2B, abliterated (refusal-reduced) in place: only the text-decoder weights differ from
     * Google's litert-community build; vision, audio, tokenizer and chat template are byte-identical
     * (so native tool calling and on-device speech recognition work the same).
     */
    val GEMMA4_E2B = LocalModelSpec(
        id = "gemma4_e2b_abliterated",
        file = "gemma-4-E2B-it-abliterated.litertlm",
        name = "Gemma 4 E2B · abliterated",
        summary = "Recommended: fast and light on memory; refusals removed",
        license = "Apache-2.0 (Google Gemma 4; abliteration by csabag76, method by oknyshuk)",
        source = "huggingface.co/csabag76/gemma-4-E2B-it-abliterated-litert-lm",
        url = "https://huggingface.co/csabag76/gemma-4-E2B-it-abliterated-litert-lm/resolve/6e6d6e68ab2ff9873e01d69d6c3421658fb4c840/gemma-4-E2B-it-abliterated.litertlm",
        sha256 = "0ebc29dcd1533a46a84b0078656ffa7010eaa07282fd2b0b6586556373409fd9",
        sizeBytes = 2_588_147_712L,
    )
    val GEMMA4_E4B = LocalModelSpec(
        id = "gemma4_e4b_abliterated",
        file = "gemma-4-E4B-it-abliterated.litertlm",
        name = "Gemma 4 E4B · abliterated",
        summary = "Highest quality that fits a 12 GB phone; about twice as slow; refusals removed",
        license = "Apache-2.0 (Google Gemma 4; abliteration by olekk / oknyshuk)",
        source = "huggingface.co/olekk/gemma-4-E4B-it-abliterated-litert-lm",
        url = "https://huggingface.co/olekk/gemma-4-E4B-it-abliterated-litert-lm/resolve/a4eecccd3b0ba1777660180cda60a396eedcb8aa/gemma-4-E4B-it-abliterated.litertlm",
        sha256 = "f5a6625e0368e853743c91b39fa6ac6a8add1fc4825b18f98f518966610f2a88",
        sizeBytes = 3_659_530_240L,
    )
    val ALL = listOf(GEMMA4_E2B, GEMMA4_E4B)
    fun byId(id: String?) = ALL.firstOrNull { it.id == id } ?: GEMMA4_E2B

    /** Files of models this version no longer uses (Qwen2.5 from 0.2.0): removed to free space. */
    fun removeRetired(context: Context) {
        // Qwen2.5 (0.2.0) and the stock Gemma 4 builds (0.3.x), replaced by the abliterated ones.
        val retired = listOf("qwen2.5-1.5b-instruct-q8.task", "gemma-4-E2B-it.litertlm", "gemma-4-E4B-it.litertlm")
        for (dir in listOfNotNull(File(context.filesDir, "models"), context.getExternalFilesDir("models")))
            dir.listFiles()?.filter { f -> retired.any { f.name == it || f.name.startsWith("$it.") } }?.forEach { it.delete() }
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

/** A loaded model that answers one request at a time. */
interface ModelRunner : AutoCloseable {
    fun send(request: ModelRequest): ModelResponse
    /** Speech to text with the model's own audio encoder (16 kHz mono WAV). */
    fun transcribe(wav: File): String
}

/** LiteRT-LM: the model's own chat template, native function calling, no automatic tool calls. */
class LiteRtRunner(file: File, gpu: Boolean, cacheDir: File) : ModelRunner {
    // The audio encoder runs on the CPU (as Google recommends); it is only loaded when audio is sent.
    private val engine = Engine(EngineConfig(modelPath = file.path, backend = if (gpu) Backend.GPU() else Backend.CPU(), audioBackend = Backend.CPU(), maxNumTokens = OnDeviceProvider.MAX_TOKENS, cacheDir = cacheDir.path)).also { it.initialize() }

    override fun send(request: ModelRequest): ModelResponse {
        val messages = LocalFormat.toMessages(request.turns)
        val config = ConversationConfig(
            systemInstruction = Contents.of(request.system),
            initialMessages = messages.dropLast(1),
            tools = request.tools.map { tool(LocalFormat.openApiTool(it)) },
            samplerConfig = SamplerConfig(topK = 40, topP = 0.95, temperature = 0.6),
            automaticToolCalling = false,
        )
        return engine.createConversation(config).use { conv -> LocalFormat.fromMessage(conv.sendMessage(messages.last())) }
    }

    override fun transcribe(wav: File): String {
        // Greedy decoding: a transcript should be the most likely words, not a creative variation.
        val config = ConversationConfig(systemInstruction = Contents.of("You are a speech-to-text engine."), samplerConfig = SamplerConfig(topK = 1, topP = 1.0, temperature = 0.0))
        return engine.createConversation(config).use { conv ->
            val reply = conv.sendMessage(com.google.ai.edge.litertlm.Message.user(Contents.of(com.google.ai.edge.litertlm.Content.AudioFile(wav.path), com.google.ai.edge.litertlm.Content.Text(TRANSCRIBE))))
            LocalFormat.fromMessage(reply).text
        }
    }

    override fun close() = engine.close()

    companion object {
        /** Measured best on real speech (mobile/scripts: plain wording beat "context" hints). */
        const val TRANSCRIBE = "Transcribe this audio exactly, word for word. Reply with only the transcript."
    }
}

/**
 * Runs the selected on-device model (GPU when the phone allows it, else CPU). Nothing leaves the
 * phone. The calls the model proposes come back to the router, which validates and authorizes them.
 *
 * The GPU can fail late — some phones only refuse when the first message runs (e.g. the GPU driver
 * library can't be loaded). Any GPU failure falls back to the CPU and retries that same message; the
 * failure is remembered for this app version, so later launches start on the CPU straight away.
 */
class OnDeviceProvider(
    private val store: () -> LocalModelStore,
    private val open: (file: File, gpu: Boolean) -> ModelRunner,
    private val gpuMemory: GpuMemory,
) : ModelProvider {
    constructor(context: Context, store: () -> LocalModelStore) : this(store, { f, gpu -> LiteRtRunner(f, gpu, context.cacheDir) }, GpuMemory.forApp(context))

    override val id = "on_device"
    override val displayName get() = "${store().spec.name} (on this phone)"
    override val onDevice = true

    private val lock = Mutex()
    private var runner: ModelRunner? = null
    private var loaded: File? = null
    @Volatile var backend: String? = null
        private set
    /** Why the GPU isn't used (shown in Settings), if it failed. */
    @Volatile var gpuProblem: String? = gpuMemory.failure()
        private set

    override suspend fun complete(request: ModelRequest): ModelResponse = run { it.send(request) }

    /** Speech to text on the phone with the same model (no audio leaves the device). */
    suspend fun transcribe(wav: File): String = run { it.transcribe(wav) }

    private suspend fun <T> run(work: (ModelRunner) -> T): T = lock.withLock {
        val file = store().ensureReady()
        withContext(Dispatchers.Default) {
            val r = runner?.takeIf { loaded == file } ?: load(file)
            try {
                work(r)
            } catch (e: Throwable) {
                if (backend != "GPU") throw ProviderUnavailable("The on-device model failed: ${e.message ?: e.javaClass.simpleName}")
                gpuFailed(e)
                val cpu = openCpu(file)
                try { work(cpu) } catch (e2: Throwable) { throw ProviderUnavailable("The on-device model failed: ${e2.message ?: e2.javaClass.simpleName}") }
            }
        }
    }

    /** Whether the model is on the phone and ready (speech recognition can use it). */
    fun ready(): Boolean = store().state.value is LocalModelStore.State.Ready

    private fun load(file: File): ModelRunner {
        release()
        if (gpuProblem == null) {
            try {
                return open(file, true).also { runner = it; loaded = file; backend = "GPU" }
            } catch (e: Throwable) {
                gpuFailed(e)
            }
        }
        return openCpu(file)
    }

    private fun openCpu(file: File): ModelRunner {
        release()
        return try {
            open(file, false).also { runner = it; loaded = file; backend = "CPU" }
        } catch (e: Throwable) {
            throw ProviderUnavailable("Couldn't start the on-device model: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    private fun gpuFailed(e: Throwable) {
        // Native errors read "Failed to call …: UNKNOWN:\n\nUNKNOWN: <reason>": keep the reason.
        val why = (e.message ?: e.javaClass.simpleName).lineSequence().map { it.trim().removePrefix("UNKNOWN:").trim() }.filter { it.isNotEmpty() }.lastOrNull() ?: "GPU unavailable"
        gpuProblem = why.take(160)
        gpuMemory.remember(gpuProblem!!)
        release()
    }

    private fun release() { runCatching { runner?.close() }; runner = null; loaded = null; backend = null }

    /** Free the memory the model holds (it reloads on the next message). */
    fun unload() {
        if (!lock.tryLock()) return
        try { release() } finally { lock.unlock() }
    }

    companion object { const val MAX_TOKENS = 8192 }
}

/** Remembers that the GPU failed, for this app version only (an update may fix it, so it's retried). */
class GpuMemory(private val get: () -> String?, private val set: (String?) -> Unit) {
    fun failure(): String? = get()
    fun remember(why: String) = set(why)

    companion object {
        fun forApp(context: Context): GpuMemory {
            val prefs = context.getSharedPreferences("jarvis_model", Context.MODE_PRIVATE)
            val key = "gpuFailed.${ai.jarvis.mobile.BuildConfig.VERSION_CODE}"
            return GpuMemory({ prefs.getString(key, null) }, { prefs.edit().putString(key, it).apply() })
        }
    }
}
