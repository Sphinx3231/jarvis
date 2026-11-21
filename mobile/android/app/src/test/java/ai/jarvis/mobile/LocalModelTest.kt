package ai.jarvis.mobile

import ai.jarvis.mobile.data.JarvisDatabase
import ai.jarvis.mobile.runtime.ActivityLog
import ai.jarvis.mobile.runtime.LocalIntents
import ai.jarvis.mobile.runtime.MobileConversationManager
import ai.jarvis.mobile.runtime.MobileExecutionRouter
import ai.jarvis.mobile.runtime.MobileMemoryManager
import ai.jarvis.mobile.runtime.MobilePermissionManager
import ai.jarvis.mobile.runtime.MobileTaskManager
import ai.jarvis.mobile.runtime.MobileTool
import ai.jarvis.mobile.runtime.MobileToolRegistry
import ai.jarvis.mobile.runtime.ModelProvider
import ai.jarvis.mobile.runtime.ModelRequest
import ai.jarvis.mobile.runtime.ModelResponse
import ai.jarvis.mobile.runtime.ToolCall
import ai.jarvis.mobile.runtime.ToolOutcome
import ai.jarvis.mobile.runtime.ToolSpec
import ai.jarvis.mobile.runtime.Turn
import ai.jarvis.mobile.runtime.local.LocalModelStore
import ai.jarvis.mobile.runtime.local.LocalFormat
import ai.jarvis.mobile.runtime.local.LocalModels
import ai.jarvis.mobile.runtime.tools.androidTools
import ai.jarvis.mobile.voice.Speaker
import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.File

/** Wraps a real capability but records calls instead of touching Android (TEST DOUBLE). */
class SpyTool(private val real: MobileTool, private val reply: String) : MobileTool by real {
    val calls = mutableListOf<JsonObject>()
    override fun availability(context: Context) = ai.jarvis.mobile.runtime.Availability.OK
    override suspend fun execute(context: Context, args: JsonObject): ToolOutcome { calls += args; return ToolOutcome.ok(reply) }
}

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [34])
class LocalModelTest {
    private lateinit var ctx: Context
    private lateinit var db: JarvisDatabase
    private lateinit var memory: MobileMemoryManager
    private lateinit var permissions: MobilePermissionManager
    private lateinit var spies: Map<String, SpyTool>
    private lateinit var registry: MobileToolRegistry
    private lateinit var activity: ActivityLog
    private val approver = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    /** Approvals the auto-approver granted (proves "ask first" capabilities still asked). */
    private val asked = mutableListOf<String>()

    @Before fun setUp() {
        ctx = ApplicationProvider.getApplicationContext()
        db = JarvisDatabase.inMemory(ctx)
        activity = ActivityLog(db.activity())
        memory = MobileMemoryManager(db.memories(), activity)
        permissions = MobilePermissionManager(db.activity()) { emptyMap() }
        val real = androidTools(memory, MobileTaskManager(ctx, db.tasks(), activity), Speaker(ctx))
        val replies = mapOf("device_battery" to """{"levelPercent":64,"charging":true}""", "device_network" to """{"online":true,"transport":"wifi","metered":false}""")
        spies = real.associate { it.name to SpyTool(it, replies[it.name] ?: "ok") }
        val testBrain = ai.jarvis.mobile.runtime.brain.Brain { ai.jarvis.mobile.runtime.brain.FileNoteStore(java.io.File(ctx.cacheDir, "brain-test"), "test") }
        registry = MobileToolRegistry(spies.values.toList() + ai.jarvis.mobile.runtime.brain.brainTools(testBrain))
        approver.launch { permissions.pending.collect { l -> l.forEach { asked += it.tool; permissions.resolve(it.id, true) } } }
    }

    @After fun tearDown() { approver.cancel(); db.close() }

    private fun intent(text: String) = runBlocking { LocalIntents.handle(text, ctx, registry, permissions, memory, activity) { _, _ -> } }
    private fun only(name: String): JsonObject = spies.values.filter { it.calls.isNotEmpty() }.let { used ->
        assertEquals("exactly one capability used", listOf(name), used.map { it.name }); used.single().calls.single()
    }

    // ------------------------------------------------------------------ direct commands

    @Test fun alarmsAndTimers() {
        assertTrue(intent("Hey Jarvis, set an alarm for 7:30 pm please")!!.first.contains("19:30"))
        only("set_alarm").let { assertEquals(19, it["hour"]!!.jsonPrimitive.int); assertEquals(30, it["minute"]!!.jsonPrimitive.int) }
        assertTrue("acting capabilities still ask first", "set_alarm" in asked)
        spies.values.forEach { it.calls.clear() }
        intent("wake me up at 6am")
        only("set_alarm").let { assertEquals(6, it["hour"]!!.jsonPrimitive.int); assertEquals(0, it["minute"]!!.jsonPrimitive.int) }
        spies.values.forEach { it.calls.clear() }
        assertTrue(intent("set a timer for 3 minutes")!!.first.contains("3 minutes"))
        assertEquals(180, only("set_timer")["seconds"]!!.jsonPrimitive.int)
        spies.values.forEach { it.calls.clear() }
        intent("5 min timer")
        assertEquals(300, only("set_timer")["seconds"]!!.jsonPrimitive.int)
    }

    @Test fun remindersSearchUrlsCalls() {
        intent("remind me to call mom in 20 minutes")
        only("reminder_schedule").let { assertEquals("call mom", it["text"]!!.jsonPrimitive.content); assertEquals(20, it["inMinutes"]!!.jsonPrimitive.int) }
        spies.values.forEach { it.calls.clear() }
        intent("search for best pizza in Cairo")
        assertEquals("best pizza in Cairo", only("web_search")["query"]!!.jsonPrimitive.content)
        spies.values.forEach { it.calls.clear() }
        intent("open youtube.com")
        assertEquals("https://youtube.com", only("open_url")["url"]!!.jsonPrimitive.content)
        spies.values.forEach { it.calls.clear() }
        intent("call +1 555 0134")
        assertEquals("+1 555 0134", only("phone_dial")["number"]!!.jsonPrimitive.content)
        val dial = registry.get("phone_dial")!!
        assertTrue(registry.validate(dial, JsonObject(mapOf("number" to JsonPrimitive("Alex"))))!!.contains("isn't valid"))
        assertNull(registry.validate(dial, JsonObject(mapOf("number" to JsonPrimitive("(020) 7946-0018")))))
    }

    @Test fun phoneStatusRepliesInPlainWords() {
        assertEquals("Battery is at 64% and charging.", intent("battery?")!!.first)
        assertEquals("You're online over Wi-Fi.", intent("am I on wifi")!!.first)
    }

    @Test fun memoryAndIdentity() {
        assertEquals("Got it — I'll remember that.", intent("remember that my name is Sam")!!.first)
        assertTrue(intent("What's my name?")!!.first.contains("my name is Sam"))
        assertTrue(intent("who are you")!!.first.startsWith("I'm Jarvis"))
    }

    @Test fun questionsAreLeftToTheModel() {
        for (q in listOf("my battery drains fast, any tips?", "how do I fix my wifi", "tell me a joke", "what's the capital of France", "I need to call my bank about a charge", "can you open up about your feelings", "open the door for my mother in law please"))
            assertNull(q, intent(q))
        assertTrue(spies.values.all { it.calls.isEmpty() })
    }

    // ------------------------------------------------------------------ prompt + parser

    @Test fun toolsAndMessagesMapToTheRuntimeFormat() {
        val alarm = registry.specs(ctx).first { it.name == "set_alarm" }
        val desc = Json.parseToJsonElement(LocalFormat.toolDescription(alarm)).jsonObject
        assertEquals("set_alarm", desc["name"]!!.jsonPrimitive.content)
        assertEquals(alarm.parameters, desc["parameters"])
        val msgs = LocalFormat.toMessages(listOf(
            Turn.User("battery?"),
            Turn.Assistant("", listOf(ToolCall("1", "device_battery", JsonObject(emptyMap())))),
            Turn.ToolResult("1", "device_battery", "{\"levelPercent\":64}", false),
            Turn.ToolResult("2", "device_network", "offline", true),
        ))
        assertEquals(listOf(com.google.ai.edge.litertlm.Role.USER, com.google.ai.edge.litertlm.Role.MODEL, com.google.ai.edge.litertlm.Role.TOOL), msgs.map { it.role })
        assertEquals("device_battery", msgs[1].toolCalls.single().name)
        val responses = msgs[2].contents.contents.filterIsInstance<com.google.ai.edge.litertlm.Content.ToolResponse>()
        assertEquals("consecutive results go in one tool message", 2, responses.size)
        assertEquals(mapOf("levelPercent" to 64L), responses[0].response)
        assertEquals(mapOf("error" to "offline"), responses[1].response)
    }

    @Test fun runtimeRepliesBecomeValidatedCalls() {
        // The runtime hands numbers back as doubles; tools need whole numbers to be integers.
        val reply = com.google.ai.edge.litertlm.Message.model(
            com.google.ai.edge.litertlm.Contents.of(emptyList<com.google.ai.edge.litertlm.Content>()),
            listOf(com.google.ai.edge.litertlm.ToolCall("set_alarm", mapOf("hour" to 7.0, "minute" to 30.0, "label" to "gym"))), emptyMap(),
        )
        val r = LocalFormat.fromMessage(reply)
        val call = r.toolCalls.single()
        assertEquals("set_alarm", call.name)
        assertEquals("{\"hour\":7,\"minute\":30,\"label\":\"gym\"}", call.arguments.toString())
        assertNull(registry.validate(registry.get("set_alarm")!!, call.arguments))
        assertEquals(1.5, LocalFormat.normalizeArgs(mapOf("x" to 1.5))["x"]!!.jsonPrimitive.content.toDouble(), 0.0)
        assertEquals("Paris.", LocalFormat.fromMessage(com.google.ai.edge.litertlm.Message.model("Paris.<end_of_turn>")).text)
        assertEquals("Answer.", LocalFormat.clean("<think>hmm</think>\n\nAnswer."))
    }

    // ------------------------------------------------------------------ the on-device path in the router

    @Test fun routerHandlesCommandsDirectlyAndIsHonestAboutClaims() = runBlocking {
        val seen = mutableListOf<ModelRequest>()
        val local = object : ModelProvider {
            override val id = "on_device"; override val displayName = "Test on-device model"; override val onDevice = true
            override suspend fun complete(request: ModelRequest): ModelResponse { seen += request; return ModelResponse("Sure, I've set an alarm for you.", emptyList(), "end_turn") }
        }
        val router = MobileExecutionRouter(ctx, { local }, registry, permissions, MobileConversationManager(db.conversations()), memory, activity)
        val r = router.handle(null, "battery")
        assertEquals("phone (direct command)", r.handledBy)
        assertTrue("the model never saw the command", seen.isEmpty())
        val chat = router.handle(r.conversationId, "can you help me wake up earlier")
        assertEquals(1, seen.size)
        assertTrue(chat.text, chat.text.contains("nothing was actually done"))
        assertFalse(seen.single().system.contains("Act only through the tools provided"))
    }

    // ------------------------------------------------------------------ unpacking the bundled model

    @Test fun bundledModelIsUnpackedOnceWithProgressAndSpaceCheck() = runBlocking {
        val dir = File(ctx.cacheDir, "models-test").apply { deleteRecursively() }
        val bytes = ByteArray(10 * 1024 * 1024) { (it % 251).toByte() }
        var opened = 0
        val store = LocalModelStore(LocalModels.GEMMA4_E2B, { opened++; ByteArrayInputStream(bytes) to bytes.size.toLong() }, dir, null, freeBytes = { Long.MAX_VALUE })
        val progress = mutableListOf<Float>()
        val watch = launch(Dispatchers.Default) { store.state.collect { (it as? LocalModelStore.State.Preparing)?.let { p -> progress += p.fraction } } }
        val f = store.ensureReady()
        watch.cancel()
        assertTrue(f.readBytes().contentEquals(bytes))
        assertTrue(store.state.value is LocalModelStore.State.Ready)
        assertTrue("reported progress", progress.isNotEmpty())
        assertEquals(f, store.ensureReady())
        assertEquals("not copied twice", 1, opened)
        // A fresh start with the file present only checks its size.
        val again = LocalModelStore(LocalModels.GEMMA4_E2B, { ByteArrayInputStream(ByteArray(0)) to bytes.size.toLong() }, dir, null, freeBytes = { Long.MAX_VALUE })
        assertEquals(bytes.size.toLong(), again.ensureReady().length())
        // Not enough space: a clear failure, no partial file left behind.
        val full = LocalModelStore(LocalModels.GEMMA4_E2B, { ByteArrayInputStream(bytes) to bytes.size.toLong() }, File(ctx.cacheDir, "models-full"), null, freeBytes = { 1000L })
        assertTrue(runCatching { full.ensureReady() }.exceptionOrNull()!!.message!!.contains("Not enough free storage"))
        assertTrue(full.state.value is LocalModelStore.State.Failed)
        assertFalse(File(ctx.cacheDir, "models-full/${LocalModels.GEMMA4_E2B.file}.part").exists())
    }

    @Test fun downloadedModelIsVerifiedAgainstThePinnedChecksum() = runBlocking {
        val dir = File(ctx.cacheDir, "dl-test").apply { deleteRecursively(); mkdirs() }
        val bytes = "the model".toByteArray()
        val goodSha = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val spec = LocalModels.GEMMA4_E2B.copy(sha256 = goodSha, sizeBytes = bytes.size.toLong())
        val file = File(dir, spec.file)
        var hashed = 0
        fun store() = LocalModelStore(spec, { null }, dir, file, sha256Of = { hashed++; ai.jarvis.mobile.runtime.local.sha256Hex(it) })

        // Not downloaded: a clear message, state says so.
        val none = store()
        assertTrue(runCatching { none.ensureReady() }.exceptionOrNull()!!.message!!.contains("isn't on this phone yet"))
        assertEquals(LocalModelStore.State.NotDownloaded, none.state.value)

        // The right file: accepted, and the checksum is computed only once across restarts.
        file.writeBytes(bytes)
        assertEquals(file, store().ensureReady())
        assertEquals(file, store().ensureReady())
        assertEquals(1, hashed)

        // A tampered file of the right size: rejected and deleted.
        file.writeBytes("THE MODEL".toByteArray())
        val bad = store()
        assertTrue(runCatching { bad.ensureReady() }.isFailure)
        assertTrue(bad.state.value is LocalModelStore.State.Failed)
        assertFalse(file.exists())

        // A truncated download: rejected and deleted.
        file.writeBytes("the".toByteArray())
        val short = store()
        assertTrue(runCatching { short.ensureReady() }.exceptionOrNull()!!.message!!.contains("incomplete"))
        assertFalse(file.exists())
    }

    @Test fun phoneDownloadsWithTheSystemDownloadManager() = runBlocking {
        val bytes = "the model".toByteArray()
        val sha = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val spec = LocalModels.GEMMA4_E2B.copy(sha256 = sha, sizeBytes = bytes.size.toLong())
        val target = File(ctx.getExternalFilesDir("models"), spec.file).apply { delete() }
        val store = LocalModelStore(spec, { null }, File(ctx.cacheDir, "unused"), target)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val dm = ctx.getSystemService(android.app.DownloadManager::class.java)
        val shadowDm = org.robolectric.Shadows.shadowOf(dm)
        try {
            assertEquals(LocalModelStore.State.NotDownloaded, store.refresh())
            // Too little space: refused before anything is requested.
            ai.jarvis.mobile.runtime.local.ModelDownloader(ctx, store, scope, freeBytes = { 10L }).start(allowMobileData = false)
            assertTrue((store.state.value as LocalModelStore.State.Failed).reason.contains("Not enough free storage"))
            assertEquals(0, shadowDm.requestCount)

            val dl = ai.jarvis.mobile.runtime.local.ModelDownloader(ctx, store, scope, freeBytes = { Long.MAX_VALUE })
            dl.start(allowMobileData = false)
            assertEquals(1, shadowDm.requestCount)
            val id = ctx.getSharedPreferences("jarvis_model_download", Context.MODE_PRIVATE).getLong("downloadId.${spec.id}", -1)
            val req = org.robolectric.shadow.api.Shadow.extract<org.robolectric.shadows.ShadowDownloadManager.ShadowRequest>(shadowDm.getRequest(id))
            assertEquals(spec.url, req.uri.toString())
            assertTrue(req.destination.toString(), req.destination.toString().endsWith("/models/${spec.file}"))
            assertFalse("Wi-Fi only was respected", req.allowedOverMetered)
            assertEquals("Jarvis offline AI model", req.title.toString())

            req.status = android.app.DownloadManager.STATUS_RUNNING
            req.bytesSoFar = 4
            kotlinx.coroutines.withTimeout(5000) { store.state.first { it is LocalModelStore.State.Downloading && it.fraction > 0.4f } }

            // The system finishes the download: the file is verified against the checksum, then ready.
            target.writeBytes(bytes)
            req.status = android.app.DownloadManager.STATUS_SUCCESSFUL
            assertEquals(target, (kotlinx.coroutines.withTimeout(5000) { store.state.first { it is LocalModelStore.State.Ready } } as LocalModelStore.State.Ready).file)

            // A failed download is reported with a retry hint.
            target.delete(); File(target.path + ".verified").delete()
            dl.start(allowMobileData = true)
            val id2 = ctx.getSharedPreferences("jarvis_model_download", Context.MODE_PRIVATE).getLong("downloadId.${spec.id}", -1)
            val req2 = org.robolectric.shadow.api.Shadow.extract<org.robolectric.shadows.ShadowDownloadManager.ShadowRequest>(shadowDm.getRequest(id2))
            assertTrue(req2.allowedOverMetered)
            req2.status = android.app.DownloadManager.STATUS_FAILED
            val failed = kotlinx.coroutines.withTimeout(5000) { store.state.first { it is LocalModelStore.State.Failed } } as LocalModelStore.State.Failed
            assertTrue(failed.reason, failed.reason.contains("try again"))
        } finally {
            scope.cancel()
        }
    }

    @Test fun gpuThatFailsAtFirstMessageFallsBackToCpuAndIsRemembered() = runBlocking {
        val dir = File(ctx.cacheDir, "gpu-test").apply { deleteRecursively(); mkdirs() }
        val bytes = "m".toByteArray()
        val sha = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val spec = LocalModels.GEMMA4_E2B.copy(sha256 = sha, sizeBytes = 1)
        File(dir, spec.file).writeBytes(bytes)
        val store = LocalModelStore(spec, { null }, dir, File(dir, spec.file))
        val opened = mutableListOf<String>()
        var remembered: String? = null
        val memory = ai.jarvis.mobile.runtime.local.GpuMemory({ remembered }, { remembered = it })
        // TEST DOUBLE runners: the GPU one starts fine but fails on the first message, like the phone did.
        fun runner(gpu: Boolean) = object : ai.jarvis.mobile.runtime.local.ModelRunner {
            override fun send(request: ModelRequest): ModelResponse =
                if (gpu) throw IllegalStateException("Failed to call nativeSendMessage: UNKNOWN:\n\nUNKNOWN: Can not find OpenCL library on this device")
                else ModelResponse("Hello from the CPU", emptyList(), "end_turn")
            override fun transcribe(wav: File) = "hello"
            override fun close() {}
        }
        val p = ai.jarvis.mobile.runtime.local.OnDeviceProvider({ store }, { _, gpu -> opened += if (gpu) "GPU" else "CPU"; runner(gpu) }, memory)
        val req = ModelRequest("sys", listOf(Turn.User("hi")), emptyList())
        assertEquals("Hello from the CPU", p.complete(req).text)
        assertEquals(listOf("GPU", "CPU"), opened)
        assertEquals("CPU", p.backend)
        assertEquals("Can not find OpenCL library on this device", p.gpuProblem)
        assertEquals("remembered for this app version", "Can not find OpenCL library on this device", remembered)
        // Later messages stay on the CPU; a fresh start (next launch) goes straight to the CPU.
        p.complete(req)
        assertEquals(listOf("GPU", "CPU"), opened)
        val next = ai.jarvis.mobile.runtime.local.OnDeviceProvider({ store }, { _, gpu -> opened += if (gpu) "GPU" else "CPU"; runner(gpu) }, memory)
        next.complete(req)
        assertEquals(listOf("GPU", "CPU", "CPU"), opened)
        // A GPU that fails to start at all also falls back.
        val opened2 = mutableListOf<String>()
        val p2 = ai.jarvis.mobile.runtime.local.OnDeviceProvider({ store }, { _, gpu -> opened2 += if (gpu) "GPU" else "CPU"; if (gpu) throw IllegalStateException("no gpu") else runner(false) }, ai.jarvis.mobile.runtime.local.GpuMemory({ null }, {}))
        assertEquals("Hello from the CPU", p2.complete(req).text)
        assertEquals(listOf("GPU", "CPU"), opened2)
    }

    @Test fun pinnedModelsMatchTheTestedFiles() {
        assertTrue(LocalModels.GEMMA4_E2B.url.contains("csabag76/gemma-4-E2B-it-abliterated-litert-lm/resolve/6e6d6e68ab2ff9873e01d69d6c3421658fb4c840/"))
        assertEquals("0ebc29dcd1533a46a84b0078656ffa7010eaa07282fd2b0b6586556373409fd9", LocalModels.GEMMA4_E2B.sha256)
        assertTrue(LocalModels.GEMMA4_E4B.url.contains("olekk/gemma-4-E4B-it-abliterated-litert-lm/resolve/a4eecccd3b0ba1777660180cda60a396eedcb8aa/"))
        assertEquals("f5a6625e0368e853743c91b39fa6ac6a8add1fc4825b18f98f518966610f2a88", LocalModels.GEMMA4_E4B.sha256)
        assertEquals("an older choice maps to the default", LocalModels.GEMMA4_E2B, LocalModels.byId("gemma4_e2b"))
    }

    // ------------------------------------------------------------------ real-model round trip (opt-in)

    private val scenarios = listOf(
        "How charged is my phone?" to "device_battery",
        "Set an alarm for 7:30 tomorrow morning" to "set_alarm",
        "Remind me in 20 minutes to call mom" to "reminder_schedule",
        "Look up the weather in Cairo online" to "web_search",
        "Please ring 555 0134" to "phone_dial",
        "Start a countdown of 3 minutes" to "set_timer",
        "Open Spotify" to "app_launch",
        "What did I write in my notes about the gym plan?" to "brain_search",
        "Save a note called Groceries with milk, eggs and bread" to "brain_write",
        "Tell me a short joke" to "",
        "What is 15% of 80?" to "",
        "Text Alex that I'm running late" to "share_text|-",
    )
    /** The router's own prompt builder, so the harness tests exactly what the phone sends. */
    private val harnessSystem = MobileExecutionRouter.systemPrompt(onDevice = true, now = java.time.ZonedDateTime.parse("2026-11-20T09:00:00Z"), known = listOf("my name is Sam"), notes = null)

    /** Writes the exact system prompt, tools and messages the app sends, for mobile/scripts/local-model-check.py. */
    @Test fun dumpPromptsForTheRealModel() {
        val out = System.getenv("JARVIS_PROMPT_DUMP"); assumeTrue("set by mobile/scripts/local-model-check.sh", !out.isNullOrBlank())
        val tools = buildJsonArray { registry.specs(ctx).forEach { add(Json.parseToJsonElement(LocalFormat.toolDescription(it))) } }
        fun user(q: String) = buildJsonObject { put("role", "user"); put("content", q) }
        val arr = buildJsonArray {
            scenarios.forEach { (q, expect) -> add(buildJsonObject { put("question", q); put("expect", expect); put("system", harnessSystem); put("tools", tools); put("messages", buildJsonArray { add(user(q)) }) }) }
            phoneCases().forEach { add(it) }
            add(buildJsonObject {
                put("question", "follow-up (battery result)"); put("expect", ""); put("system", harnessSystem); put("tools", tools)
                put("messages", Json.parseToJsonElement("""[{"role":"user","content":"How charged is my phone?"},{"role":"assistant","content":[],"tool_calls":[{"type":"function","function":{"name":"device_battery","arguments":{}}}]},{"role":"tool","content":[{"type":"tool_response","name":"device_battery","response":{"levelPercent":64,"charging":false}}]}]"""))
            })
        }
        File(out!!).writeText(arr.toString())
    }

    // ---- phone control on simulated screens (the exact text the app's screen reader produces)
    private val inbox = ai.jarvis.mobile.control.ScreenSnapshot("com.google.android.gm", "Gmail", listOf(
        ai.jarvis.mobile.control.UiElement(1, "button", "", "Open navigation drawer", clickable = true),
        ai.jarvis.mobile.control.UiElement(2, "field", "Search in mail", clickable = true, editable = true),
        ai.jarvis.mobile.control.UiElement(3, "text", "Primary"),
        ai.jarvis.mobile.control.UiElement(4, "item", "Amazon · Your order has shipped · Arriving Tuesday · 10:42", clickable = true),
        ai.jarvis.mobile.control.UiElement(5, "item", "Mum · Sunday lunch? · Are you coming this weekend… · 09:15", clickable = true),
        ai.jarvis.mobile.control.UiElement(6, "item", "GitHub · [jarvis] CI passed on main · Yesterday", clickable = true),
        ai.jarvis.mobile.control.UiElement(7, "button", "Compose", clickable = true),
    )).describe()
    private val mumEmail = ai.jarvis.mobile.control.ScreenSnapshot("com.google.android.gm", "Gmail", listOf(
        ai.jarvis.mobile.control.UiElement(1, "button", "", "Navigate up", clickable = true),
        ai.jarvis.mobile.control.UiElement(2, "text", "Sunday lunch?"),
        ai.jarvis.mobile.control.UiElement(3, "text", "Mum <mum@example.com> · 09:15"),
        ai.jarvis.mobile.control.UiElement(4, "text", "Hi love, are you coming for Sunday lunch at 1pm? Could you bring the dessert? Dad is making roast chicken."),
        ai.jarvis.mobile.control.UiElement(5, "button", "Reply", clickable = true),
        ai.jarvis.mobile.control.UiElement(6, "button", "Forward", clickable = true),
    )).describe()
    private val fortnite = ai.jarvis.mobile.control.ScreenSnapshot("com.epicgames.fortnite", "Fortnite", emptyList(), isGame = true).describe()

    private fun phoneCases(): List<JsonObject> {
        val tools = buildJsonArray {
            (registry.specs(ctx) + ai.jarvis.mobile.control.phoneControlTools().map { ToolSpec(it.name, it.description, it.parameters) }).forEach { add(Json.parseToJsonElement(LocalFormat.toolDescription(it))) }
        }
        val system = MobileExecutionRouter.systemPrompt(onDevice = true, now = java.time.ZonedDateTime.parse("2026-11-20T09:00:00Z"), known = listOf("my name is Sam"), notes = null, phoneControl = true)
        fun user(t: String) = buildJsonObject { put("role", "user"); put("content", t) }
        fun call(name: String, args: String) = Json.parseToJsonElement("""{"role":"assistant","content":[],"tool_calls":[{"type":"function","function":{"name":"$name","arguments":$args}}]}""")
        fun result(name: String, text: String) = buildJsonObject { put("role", "tool"); put("content", buildJsonArray { add(buildJsonObject { put("type", "tool_response"); put("name", name); put("response", buildJsonObject { put("result", text) }) }) }) }
        fun case(q: String, expect: String, check: String, vararg msgs: kotlinx.serialization.json.JsonElement) = buildJsonObject {
            put("question", q); put("expect", expect); put("check", check); put("system", system); put("tools", tools); put("messages", buildJsonArray { msgs.forEach { add(it) } })
        }
        val q1 = "Check my Gmail"
        val q2 = "Open the email from Mum and tell me what it says"
        val q4 = "Search my Gmail for flight tickets"
        val q5 = "Reply to Mum's email"
        val q6 = "Play Fortnite and find the pirate token"
        return listOf(
            case(q1, "app_launch", "app~gmail", user(q1)),
            case("$q1 (inbox on screen)", "-", "text~amazon", user(q1), call("app_launch", """{"app":"Gmail"}"""), result("app_launch", ai.jarvis.mobile.control.PhoneControl.afterLaunch("Gmail", inbox))),
            case("$q1 (inbox on screen, after Jarvis's nudge)", "screen_read|-", "text~amazon", user(q1), call("app_launch", """{"app":"Gmail"}"""), result("app_launch", ai.jarvis.mobile.control.PhoneControl.afterLaunch("Gmail", inbox)),
                buildJsonObject { put("role", "assistant"); put("content", "Hey Sam, I've opened your Gmail. What would you like to check or do there?") }, user(MobileExecutionRouter.READ_NUDGE)),
            case("$q1 (nudged, then re-read the screen)", "-", "text~amazon", user(q1), call("app_launch", """{"app":"Gmail"}"""), result("app_launch", ai.jarvis.mobile.control.PhoneControl.afterLaunch("Gmail", inbox)),
                buildJsonObject { put("role", "assistant"); put("content", "Hey Sam, I've opened your Gmail. What would you like to check or do there?") }, user(MobileExecutionRouter.READ_NUDGE),
                call("screen_read", "{}"), result("screen_read", inbox)),
            case("$q2 (inbox on screen)", "screen_tap", "element=5", user(q2), call("app_launch", """{"app":"Gmail"}"""), result("app_launch", ai.jarvis.mobile.control.PhoneControl.afterLaunch("Gmail", inbox))),
            case("$q2 (email open)", "-", "text~lunch", user(q2), call("app_launch", """{"app":"Gmail"}"""), result("app_launch", ai.jarvis.mobile.control.PhoneControl.afterLaunch("Gmail", inbox)), call("screen_tap", """{"element":5}"""), result("screen_tap", ai.jarvis.mobile.control.PhoneControl.afterTap(5, "Mum · Sunday lunch? · Are you coming this weekend… · 09:15", mumEmail))),
            case("$q4 (inbox on screen)", "screen_type|screen_tap", "element=2", user(q4), call("app_launch", """{"app":"Gmail"}"""), result("app_launch", ai.jarvis.mobile.control.PhoneControl.afterLaunch("Gmail", inbox))),
            case("$q5 (email open)", "screen_tap|-", "element=5", user(q5), call("app_launch", """{"app":"Gmail"}"""), result("app_launch", ai.jarvis.mobile.control.PhoneControl.afterLaunch("Gmail", inbox)), call("screen_tap", """{"element":5}"""), result("screen_tap", ai.jarvis.mobile.control.PhoneControl.afterTap(5, "Mum · Sunday lunch? · Are you coming this weekend… · 09:15", mumEmail))),
            case("$q6 (game on screen)", "-", "", user(q6), call("app_launch", """{"app":"Fortnite"}"""), result("app_launch", ai.jarvis.mobile.control.PhoneControl.afterLaunch("Fortnite", fortnite))),
        )
    }

    /** Converts what the real model answered the way the app does, validates the calls, and checks each scenario. */
    @Test fun realModelOutputsParseIntoTheRightCalls() {
        val path = System.getenv("JARVIS_MODEL_OUTPUTS"); assumeTrue("set by mobile/scripts/local-model-check.sh", !path.isNullOrBlank())
        val results = Json.parseToJsonElement(File(path!!).readText()).jsonArray.map { it.jsonObject }
        val report = StringBuilder()
        var ok = 0
        for (r in results) {
            val reply = r["reply"]!!.jsonObject
            val text0 = LocalFormat.clean((reply["content"] as? JsonArray).orEmpty().joinToString("") { (it as? JsonObject)?.get("text")?.jsonPrimitive?.content ?: "" })
            val calls = (reply["tool_calls"] as? JsonArray).orEmpty().map { it.jsonObject }.map { tc ->
                val f = tc["function"]?.jsonObject ?: tc
                ToolCall("x", f["name"]!!.jsonPrimitive.content, LocalFormat.normalizeArgs((f["arguments"] as? JsonObject).orEmpty().mapValues { (_, v) -> plain(v) }))
            }
            // What the router does next: a lone "speak" for an ordinary reply becomes text; extra arguments are dropped.
            val spoken = MobileExecutionRouter.speakAsReply(calls, r["question"]!!.jsonPrimitive.content)
            val text = spoken ?: text0
            val got = if (spoken != null) null else calls.firstOrNull()?.let { c -> registry.get(c.name)?.let { c.copy(arguments = registry.sanitize(it, c.arguments)) } ?: c }
            val expect = r["expect"]!!.jsonPrimitive.content
            val answerOk = expect.isEmpty() || "-" in expect.split('|')
            val valid = got?.let { c -> registry.get(c.name)?.let { registry.validate(it, c.arguments) == null } ?: false }
            val risky = got?.let { registry.get(it.name)?.risk == ai.jarvis.mobile.runtime.Risk.ACT } ?: false
            // A wrong call that validation refuses never runs: safe, but reported as such.
            val refused = answerOk && got != null && valid != true && !got.name.startsWith("screen_")
            val check = r["check"]?.jsonPrimitive?.content.orEmpty()
            val checkOk = when {
                check.isEmpty() -> true
                check.startsWith("text~") -> got != null || text.lowercase().contains(check.removePrefix("text~"))
                // Argument checks apply to calls; asking the user instead is judged by "expect".
                got == null -> true
                "~" in check -> check.split("~").let { (k, v) -> got?.arguments?.get(k)?.jsonPrimitive?.content?.lowercase()?.contains(v) == true }
                "=" in check -> check.split("=").let { (k, v) -> got?.arguments?.get(k)?.jsonPrimitive?.content == v }
                else -> true
            }
            // Screen tools aren't in this test's registry (they need the phone); judge them by the check.
            val validOrScreen = valid == true || (got != null && got.name.startsWith("screen_"))
            val pass = checkOk && ((answerOk && got == null && text.isNotBlank()) || refused || (got != null && got.name in expect.split('|') && validOrScreen))
            if (pass) ok++
            val label = when { refused -> "SAFE (bad call refused by validation)"; pass -> "PASS"; got != null && valid == true && risky -> "MISS (would ask you first)"; else -> "MISS" }
            report.append("$label  ${r["question"]!!.jsonPrimitive.content}  →  ${got?.let { "${it.name} ${it.arguments}" } ?: text.take(90)}  [${r["seconds"]?.jsonPrimitive?.content}s]\n")
        }
        println(report)
        File(path).resolveSibling("local-model-report.txt").writeText(report.toString() + "\n$ok/${results.size} as expected\n")
        assertTrue("at least ${results.size - 3} of ${results.size} scenarios behave as expected:\n$report", ok >= results.size - 3)
    }

    private fun plain(e: kotlinx.serialization.json.JsonElement): Any? = when (e) {
        is JsonObject -> e.mapValues { plain(it.value) }
        is JsonArray -> e.map { plain(it) }
        is kotlinx.serialization.json.JsonNull -> null
        is JsonPrimitive -> if (e.isString) e.content else e.content.toBooleanStrictOrNull() ?: e.content.toDoubleOrNull()
    }
}
