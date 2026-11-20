package ai.jarvis.mobile.runtime.local

import ai.jarvis.mobile.runtime.ModelProvider
import ai.jarvis.mobile.runtime.ModelRequest
import ai.jarvis.mobile.runtime.ModelResponse
import ai.jarvis.mobile.runtime.ProviderUnavailable
import android.content.Context
import android.os.StatFs
import com.google.mediapipe.tasks.genai.llminference.LlmInference
import com.google.mediapipe.tasks.genai.llminference.LlmInferenceSession
import com.google.mediapipe.tasks.genai.llminference.PromptTemplates
import kotlinx.coroutines.CompletableDeferred
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

/** The on-device model: where it comes from and how to check it. */
data class LocalModelSpec(
    val file: String,
    val name: String,
    val license: String,
    val source: String,
    /** Pinned download (an exact revision, so the checksum below always applies). */
    val url: String,
    val sha256: String,
    val sizeBytes: Long,
)

val QWEN_1_5B = LocalModelSpec(
    file = "qwen2.5-1.5b-instruct-q8.task",
    name = "Qwen2.5 1.5B Instruct",
    license = "Apache-2.0 (Qwen team, Alibaba Cloud); on-device packaging by Google litert-community",
    source = "huggingface.co/litert-community/Qwen2.5-1.5B-Instruct",
    url = "https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct/resolve/60257f9f1d00ca1f24cc5ce3b829b4139be1ca2b/Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.task",
    sha256 = "82968d0a6c3872cf016fdbcfc591571605f4c7fd2b0f64d2533df502cc6596b3",
    sizeBytes = 1_598_556_720L,
)

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
        fun forApp(context: Context, bundledFile: String): LocalModelStore = LocalModelStore(
            spec = QWEN_1_5B,
            bundled = {
                if (bundledFile.isBlank()) null
                else runCatching { context.assets.openFd(bundledFile).let { fd -> fd.createInputStream() to fd.length } }.getOrNull()
            },
            unpackDir = File(context.filesDir, "models"),
            downloadFile = context.getExternalFilesDir("models")?.let { File(it, QWEN_1_5B.file) },
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
    fun resume() { if (prefs.getLong(KEY, -1) >= 0) watch() }

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
        prefs.edit().putLong(KEY, dm.enqueue(req)).apply()
        store.setDownloading(0f)
        watch()
    }

    fun cancel() {
        watcher?.cancel()
        prefs.getLong(KEY, -1).takeIf { it >= 0 }?.let { runCatching { dm.remove(it) } }
        prefs.edit().remove(KEY).apply()
    }

    private fun watch() {
        watcher?.cancel()
        watcher = scope.launch(Dispatchers.IO) {
            while (true) {
                val id = prefs.getLong(KEY, -1).takeIf { it >= 0 } ?: return@launch
                val row = dm.query(DownloadManager.Query().setFilterById(id))?.use { c ->
                    if (!c.moveToFirst()) null
                    else Triple(c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)), c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)), c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)))
                }
                when (row?.first) {
                    null -> { prefs.edit().remove(KEY).apply(); store.refresh(); return@launch }
                    DownloadManager.STATUS_SUCCESSFUL -> { prefs.edit().remove(KEY).apply(); store.refresh(); return@launch }
                    DownloadManager.STATUS_FAILED -> {
                        prefs.edit().remove(KEY).apply()
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

    companion object { private const val KEY = "downloadId" }
}

/**
 * Runs the bundled model on the phone (MediaPipe LLM Inference: GPU when available, else CPU).
 * Nothing leaves the phone. Loaded on first use, kept while the app runs, released under memory pressure.
 */
class OnDeviceProvider(private val context: Context, private val store: LocalModelStore) : ModelProvider {
    override val id = "on_device"
    override val displayName = "${store.spec.name} (on this phone)"
    override val onDevice = true

    private val lock = Mutex()
    private var engine: LlmInference? = null
    @Volatile var backend: String? = null
        private set

    /** Live token count of the reply being generated (for the "thinking" indicator). */
    val generating = MutableStateFlow<Int?>(null)

    override suspend fun complete(request: ModelRequest): ModelResponse = lock.withLock {
        val file = store.ensureReady()
        val llm = engine ?: load(file).also { engine = it }
        val prompt = LocalPrompt.build(request.system, request.turns, request.tools)
        val raw = withContext(Dispatchers.Default) { generate(llm, prompt) }
        LocalPrompt.parse(raw)
    }

    private suspend fun load(file: File): LlmInference = withContext(Dispatchers.Default) {
        fun open(b: LlmInference.Backend) = LlmInference.createFromOptions(
            context,
            LlmInference.LlmInferenceOptions.builder().setModelPath(file.path).setMaxTokens(MAX_TOKENS).setMaxTopK(40).setPreferredBackend(b).build(),
        )
        try {
            open(LlmInference.Backend.GPU).also { backend = "GPU" }
        } catch (gpu: Throwable) {
            try {
                open(LlmInference.Backend.CPU).also { backend = "CPU" }
            } catch (cpu: Throwable) {
                throw ProviderUnavailable("Couldn't start the on-device model: ${cpu.message ?: cpu.javaClass.simpleName}")
            }
        }
    }

    private suspend fun generate(llm: LlmInference, prompt: String): String {
        // Empty templates: the prompt above is already fully formatted, so nothing is wrapped around it.
        val session = LlmInferenceSession.createFromOptions(
            llm,
            LlmInferenceSession.LlmInferenceSessionOptions.builder().setTopK(40).setTopP(0.9f).setTemperature(0.4f)
                .setPromptTemplates(PromptTemplates.builder().setUserPrefix("").setUserSuffix("").setModelPrefix("").setModelSuffix("").setSystemPrefix("").setSystemSuffix("").build())
                .build(),
        )
        try {
            val budget = MAX_TOKENS - session.sizeInTokens(prompt) - 8
            if (budget < 64) throw ProviderUnavailable("This conversation is too long for the on-device model; start a new one")
            session.addQueryChunk(prompt)
            val done = CompletableDeferred<String>()
            val out = StringBuilder()
            var pieces = 0
            generating.value = 0
            val future = session.generateResponseAsync { partial, finished ->
                if (partial != null) { out.append(partial); generating.value = ++pieces }
                if (finished) done.complete(out.toString())
            }
            future.addListener({ runCatching { future.get() }.onFailure { done.completeExceptionally(it.cause ?: it) } }, Runnable::run)
            return try {
                done.await()
            } catch (e: kotlinx.coroutines.CancellationException) {
                runCatching { session.cancelGenerateResponseAsync() }
                throw e
            } catch (e: Throwable) {
                throw ProviderUnavailable("The on-device model failed: ${e.message ?: e.javaClass.simpleName}")
            }
        } finally {
            generating.value = null
            runCatching { session.close() }
        }
    }

    /** Free the ~2 GB the model holds (it reloads on the next message). */
    fun unload() {
        if (!lock.tryLock()) return
        try { engine?.close(); engine = null } finally { lock.unlock() }
    }

    companion object { const val MAX_TOKENS = 4096 }
}
