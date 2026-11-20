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
import java.io.File
import java.io.InputStream

/** The model that ships inside the APK. */
data class LocalModelSpec(val file: String, val name: String, val license: String, val source: String)

val BUNDLED_QWEN = LocalModelSpec(
    file = "qwen2.5-1.5b-instruct-q8.task",
    name = "Qwen2.5 1.5B Instruct",
    license = "Apache-2.0 (Qwen team, Alibaba Cloud); on-device packaging by Google litert-community",
    source = "huggingface.co/litert-community/Qwen2.5-1.5B-Instruct",
)

/**
 * Makes the bundled model usable: the runtime needs a real file, so the first launch copies it out
 * of the APK into app storage (once; ~1.6 GB). Progress is observable for the UI.
 *
 * [source] opens the bundled model and gives its length (null = this build has no bundled model).
 */
class LocalModelStore(
    private val dir: File,
    val spec: LocalModelSpec?,
    private val source: () -> Pair<InputStream, Long>?,
    private val freeBytes: (File) -> Long = { runCatching { StatFs(it.path).availableBytes }.getOrDefault(Long.MAX_VALUE) },
) {
    sealed interface State {
        data object NotBundled : State
        data object Idle : State
        data class Preparing(val fraction: Float) : State
        data class Ready(val file: File) : State
        data class Failed(val reason: String) : State
    }

    private val _state = MutableStateFlow<State>(if (spec == null) State.NotBundled else State.Idle)
    val state: StateFlow<State> = _state
    private val lock = Mutex()

    /** Returns the model file, copying it out of the APK first if needed. */
    suspend fun ensureReady(): File = lock.withLock {
        (state.value as? State.Ready)?.let { if (it.file.isFile) return it.file }
        val s = spec ?: throw ProviderUnavailable("This build has no on-device model")
        withContext(Dispatchers.IO) {
            val target = File(dir, s.file)
            val (input, length) = source() ?: throw ProviderUnavailable("The on-device model is missing from this build").also { _state.value = State.Failed(it.message!!) }
            input.use { inp ->
                if (target.isFile && target.length() == length) {
                    _state.value = State.Ready(target)
                    return@withContext target
                }
                dir.mkdirs()
                File(dir, "${s.file}.part").delete()
                val needed = length + 64L * 1024 * 1024 - (if (target.isFile) target.length() else 0)
                if (freeBytes(dir) < needed) {
                    val msg = "Not enough free storage to unpack the on-device model: needs ${needed / 1_000_000} MB"
                    _state.value = State.Failed(msg)
                    throw ProviderUnavailable(msg)
                }
                val part = File(dir, "${s.file}.part")
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
                target
            }
        }
    }

    companion object {
        /** The model as an uncompressed asset in this APK (null when the build doesn't bundle one). */
        fun forApp(context: Context, bundledFile: String): LocalModelStore {
            val spec = BUNDLED_QWEN.takeIf { bundledFile.isNotBlank() && it.file == bundledFile }
            return LocalModelStore(File(context.filesDir, "models"), spec, {
                spec?.let { s -> runCatching { context.assets.openFd(s.file).let { fd -> fd.createInputStream() to fd.length } }.getOrNull() }
            })
        }
    }
}

/**
 * Runs the bundled model on the phone (MediaPipe LLM Inference: GPU when available, else CPU).
 * Nothing leaves the phone. Loaded on first use, kept while the app runs, released under memory pressure.
 */
class OnDeviceProvider(private val context: Context, private val store: LocalModelStore) : ModelProvider {
    override val id = "on_device"
    override val displayName = "${store.spec?.name ?: "On-device model"} (on this phone)"
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
