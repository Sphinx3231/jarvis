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
import ai.jarvis.mobile.runtime.local.LocalPrompt
import ai.jarvis.mobile.runtime.local.QWEN_1_5B
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
        registry = MobileToolRegistry(spies.values.toList())
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

    @Test fun promptIsChatMlWithToolsAndResults() {
        val p = LocalPrompt.build("SYS", listOf(Turn.User("battery?"), Turn.Assistant("", listOf(ToolCall("1", "device_battery", JsonObject(emptyMap())))), Turn.ToolResult("1", "device_battery", "{\"levelPercent\":64}", false)), registry.specs(ctx).take(2))
        assertTrue(p, p.startsWith("<|im_start|>system\nSYS\n\nPhone tools you can use:\n- device_battery(): Battery level and whether the phone is charging.\n"))
        assertTrue(p.contains("<|im_start|>assistant\nCALL device_battery {}<|im_end|>"))
        assertTrue(p.contains("[Tool result for device_battery: {\"levelPercent\":64}]\nAnswer my question using this result.<|im_end|>"))
        assertTrue(p.endsWith("<|im_start|>assistant\n"))
        val alarm = registry.specs(ctx).first { it.name == "set_alarm" }
        assertTrue(LocalPrompt.toolBlock(listOf(alarm)).contains("- set_alarm(hour, minute, label?): "))
    }

    @Test fun parserHandlesRealWorldOutputs() {
        LocalPrompt.parse("CALL set_alarm {\"hour\": 7, \"minute\": 30}").let { assertEquals("set_alarm", it.toolCalls.single().name); assertEquals(7, it.toolCalls.single().arguments["hour"]!!.jsonPrimitive.int) }
        LocalPrompt.parse("Sure! CALL web_search {\"query\": \"a {b} \\\"c\\\"\"} thanks").let { assertEquals("a {b} \"c\"", it.toolCalls.single().arguments["query"]!!.jsonPrimitive.content); assertEquals("Sure!", it.text) }
        LocalPrompt.parse("CALL device_battery").let { assertEquals("device_battery", it.toolCalls.single().name); assertTrue(it.toolCalls.single().arguments.isEmpty()) }
        // The placeholder some models echo becomes an (unknown) call the router refuses.
        assertEquals("tool_name", LocalPrompt.parse("CALL tool_name {JSON arguments}").toolCalls.single().name)
        LocalPrompt.parse("Paris is the capital.<|im_end|>").let { assertTrue(it.toolCalls.isEmpty()); assertEquals("Paris is the capital.", it.text) }
        assertEquals("Answer.", LocalPrompt.clean("<think>hmm</think>\n\nAnswer."))
        assertEquals("Answer.", LocalPrompt.clean("reasoning…</think>Answer."))
        assertEquals("Lights, camera 🎥", LocalPrompt.clean("Lights, cameraĠðŁİ¥"))
        assertEquals("Café ð", LocalPrompt.clean("Café ð"))
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
        val store = LocalModelStore(QWEN_1_5B, { opened++; ByteArrayInputStream(bytes) to bytes.size.toLong() }, dir, null, freeBytes = { Long.MAX_VALUE })
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
        val again = LocalModelStore(QWEN_1_5B, { ByteArrayInputStream(ByteArray(0)) to bytes.size.toLong() }, dir, null, freeBytes = { Long.MAX_VALUE })
        assertEquals(bytes.size.toLong(), again.ensureReady().length())
        // Not enough space: a clear failure, no partial file left behind.
        val full = LocalModelStore(QWEN_1_5B, { ByteArrayInputStream(bytes) to bytes.size.toLong() }, File(ctx.cacheDir, "models-full"), null, freeBytes = { 1000L })
        assertTrue(runCatching { full.ensureReady() }.exceptionOrNull()!!.message!!.contains("Not enough free storage"))
        assertTrue(full.state.value is LocalModelStore.State.Failed)
        assertFalse(File(ctx.cacheDir, "models-full/${QWEN_1_5B.file}.part").exists())
    }

    @Test fun downloadedModelIsVerifiedAgainstThePinnedChecksum() = runBlocking {
        val dir = File(ctx.cacheDir, "dl-test").apply { deleteRecursively(); mkdirs() }
        val bytes = "the model".toByteArray()
        val goodSha = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val spec = QWEN_1_5B.copy(sha256 = goodSha, sizeBytes = bytes.size.toLong())
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
        val spec = QWEN_1_5B.copy(sha256 = sha, sizeBytes = bytes.size.toLong())
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
            val id = ctx.getSharedPreferences("jarvis_model_download", Context.MODE_PRIVATE).getLong("downloadId", -1)
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
            val id2 = ctx.getSharedPreferences("jarvis_model_download", Context.MODE_PRIVATE).getLong("downloadId", -1)
            val req2 = org.robolectric.shadow.api.Shadow.extract<org.robolectric.shadows.ShadowDownloadManager.ShadowRequest>(shadowDm.getRequest(id2))
            assertTrue(req2.allowedOverMetered)
            req2.status = android.app.DownloadManager.STATUS_FAILED
            val failed = kotlinx.coroutines.withTimeout(5000) { store.state.first { it is LocalModelStore.State.Failed } } as LocalModelStore.State.Failed
            assertTrue(failed.reason, failed.reason.contains("try again"))
        } finally {
            scope.cancel()
        }
    }

    @Test fun pinnedModelMatchesTheTestedFile() {
        assertTrue(QWEN_1_5B.url.contains("/resolve/60257f9f1d00ca1f24cc5ce3b829b4139be1ca2b/"))
        assertEquals("82968d0a6c3872cf016fdbcfc591571605f4c7fd2b0f64d2533df502cc6596b3", QWEN_1_5B.sha256)
    }

    // ------------------------------------------------------------------ real-model round trip (opt-in)

    private val scenarios = listOf(
        "How charged is my phone?" to "device_battery",
        "Set an alarm for 7:30 tomorrow morning" to "set_alarm",
        "Remind me in 20 minutes to call mom" to "reminder_schedule",
        "Look up the weather in Cairo online" to "web_search",
        "Please ring 555 0134" to "phone_dial",
        "Start a countdown of 3 minutes" to "set_timer",
        "Tell me a short joke" to "",
        "What is 15% of 80?" to "",
        "Text Alex that I'm running late" to "",
    )

    /** Writes the exact prompts the app sends, for mobile/scripts/local-model-check.py. */
    @Test fun dumpPromptsForTheRealModel() {
        val out = System.getenv("JARVIS_PROMPT_DUMP"); assumeTrue("set by mobile/scripts/local-model-check.sh", !out.isNullOrBlank())
        val system = "You are Jarvis, the user's personal assistant, running on their Android phone (not their PC). Be brief and friendly.\nCurrent time: 2026-11-20 09:00 (Friday).\nWhat you know about the user:\n- my name is Sam\n"
        val arr = buildJsonArray {
            scenarios.forEach { (q, expect) -> add(buildJsonObject { put("question", q); put("expect", expect); put("prompt", LocalPrompt.build(system, listOf(Turn.User(q)), registry.specs(ctx))) }) }
            add(buildJsonObject { put("question", "follow-up"); put("expect", ""); put("prompt", LocalPrompt.build(system, listOf(Turn.User("How charged is my phone?"), Turn.Assistant("", listOf(ToolCall("1", "device_battery", JsonObject(emptyMap())))), Turn.ToolResult("1", "device_battery", "{\"levelPercent\":64,\"charging\":false}", false)), registry.specs(ctx))) })
        }
        File(out!!).writeText(arr.toString())
    }

    /** Parses what the real model answered with the app's own parser and checks each scenario. */
    @Test fun realModelOutputsParseIntoTheRightCalls() {
        val path = System.getenv("JARVIS_MODEL_OUTPUTS"); assumeTrue("set by mobile/scripts/local-model-check.sh", !path.isNullOrBlank())
        val results = Json.parseToJsonElement(File(path!!).readText()).jsonArray.map { it.jsonObject }
        val report = StringBuilder()
        var ok = 0
        for (r in results) {
            val parsed = LocalPrompt.parse(r["output"]!!.jsonPrimitive.content)
            val expect = r["expect"]!!.jsonPrimitive.content
            val got = parsed.toolCalls.firstOrNull()
            val valid = got?.let { c -> registry.get(c.name)?.let { registry.validate(it, c.arguments) == null } ?: false }
            // A wrong call that validation refuses never runs: safe, but reported as such.
            val refused = expect.isEmpty() && got != null && valid != true
            val pass = if (expect.isEmpty()) (got == null && parsed.text.isNotBlank()) || refused else got?.name == expect && valid == true
            if (pass) ok++
            report.append("${if (refused) "SAFE (bad call refused by validation)" else if (pass) "PASS" else "FAIL"}  ${r["question"]!!.jsonPrimitive.content}  →  ${got?.let { "${it.name} ${it.arguments}" } ?: parsed.text.take(90)}\n")
        }
        println(report)
        File(path).resolveSibling("local-model-report.txt").writeText(report.toString() + "\n$ok/${results.size} as expected\n")
        assertTrue("at least 8 of ${results.size} scenarios behave as expected:\n$report", ok >= 8)
    }
}
