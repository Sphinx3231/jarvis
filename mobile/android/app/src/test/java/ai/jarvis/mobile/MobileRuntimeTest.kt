package ai.jarvis.mobile

import ai.jarvis.mobile.data.JarvisDatabase
import ai.jarvis.mobile.runtime.ActivityLog
import ai.jarvis.mobile.runtime.MobileConversationManager
import ai.jarvis.mobile.runtime.MobileExecutionRouter
import ai.jarvis.mobile.runtime.MobileMemoryManager
import ai.jarvis.mobile.runtime.MobilePermissionManager
import ai.jarvis.mobile.runtime.MobileTool
import ai.jarvis.mobile.runtime.MobileToolRegistry
import ai.jarvis.mobile.runtime.ModelProvider
import ai.jarvis.mobile.runtime.ModelRequest
import ai.jarvis.mobile.runtime.ModelResponse
import ai.jarvis.mobile.runtime.ProviderUnavailable
import ai.jarvis.mobile.runtime.Risk
import ai.jarvis.mobile.runtime.ToolCall
import ai.jarvis.mobile.runtime.ToolOutcome
import ai.jarvis.mobile.runtime.Turn
import ai.jarvis.mobile.runtime.schema
import ai.jarvis.mobile.runtime.str
import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * TEST DOUBLE — a scripted model that returns pre-written responses. It exists only in the test
 * source set and is never shipped; it lets these tests drive the real router, real permission
 * manager, real Room database and real tool registry deterministically.
 */
class ScriptedTestModel(vararg responses: ModelResponse) : ModelProvider {
    override val id = "test-scripted"
    override val displayName = "Scripted test model"
    private val queue = ArrayDeque(responses.toList())
    val requests = mutableListOf<ModelRequest>()
    override suspend fun complete(request: ModelRequest): ModelResponse {
        requests += request
        return queue.removeFirstOrNull() ?: ModelResponse("(script exhausted)", emptyList(), "end_turn")
    }
}

/** A capability that counts its executions, to prove whether it actually ran. */
class CountingTool(override val name: String, override val risk: Risk) : MobileTool {
    var runs = 0
    override val title = "Counting $name"
    override val description = "Test capability"
    override val parameters = schema(listOf("note"), "note" to str("A note", maxLength = 20))
    override fun summarize(args: JsonObject) = "$title (${args["note"]?.jsonPrimitive?.content})"
    override suspend fun execute(context: Context, args: JsonObject): ToolOutcome { runs++; return ToolOutcome.ok("ran $name") }
}

private fun call(name: String, vararg args: Pair<String, String>) = ToolCall("c_${name}_${args.size}", name, JsonObject(args.associate { (k, v) -> k to JsonPrimitive(v) }))
private fun toolsThenText(calls: List<ToolCall>, text: String) = arrayOf(ModelResponse("", calls, "tool_use"), ModelResponse(text, emptyList(), "end_turn"))

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [34])
class MobileRuntimeTest {
    private lateinit var ctx: Context
    private lateinit var db: JarvisDatabase
    private lateinit var activity: ActivityLog
    private lateinit var memory: MobileMemoryManager
    private lateinit var conversations: MobileConversationManager
    private val policies = mutableMapOf<String, String>()
    private lateinit var permissions: MobilePermissionManager
    private val reader = CountingTool("test_read", Risk.READ)
    private val actor = CountingTool("test_act", Risk.ACT)
    private var model: ModelProvider? = null
    private lateinit var router: MobileExecutionRouter

    @Before fun setUp() {
        ctx = ApplicationProvider.getApplicationContext()
        db = JarvisDatabase.inMemory(ctx)
        activity = ActivityLog(db.activity())
        memory = MobileMemoryManager(db.memories(), activity)
        conversations = MobileConversationManager(db.conversations())
        permissions = MobilePermissionManager(db.activity()) { policies }
        router = MobileExecutionRouter(ctx, { model }, MobileToolRegistry(listOf(reader, actor)), permissions, conversations, memory, activity)
    }

    @After fun tearDown() = db.close()

    @Test fun readCapabilityRunsWithoutPrompt() = runBlocking {
        model = ScriptedTestModel(*toolsThenText(listOf(call("test_read", "note" to "hi")), "All read."))
        val r = router.handle(null, "read something")
        assertEquals("All read.", r.text)
        assertEquals(1, reader.runs)
        assertEquals(listOf("test_read"), r.toolsUsed)
        val toolResult = (model as ScriptedTestModel).requests[1].turns.filterIsInstance<Turn.ToolResult>().single()
        assertFalse(toolResult.isError)
        assertEquals("ran test_read", toolResult.content)
    }

    @Test fun actingCapabilityWaitsForTheUserAndRunsOnlyWhenApproved() = runBlocking {
        model = ScriptedTestModel(*toolsThenText(listOf(call("test_act", "note" to "go")), "Done it."))
        val job = async(Dispatchers.Default) { router.handle(null, "do something") }
        val pending = withTimeout(5000) { permissions.pending.first { it.isNotEmpty() } }.single()
        assertEquals("test_act", pending.tool)
        assertEquals(0, actor.runs) // nothing happens before the tap
        permissions.resolve(pending.id, true)
        val r = job.await()
        assertEquals(1, actor.runs)
        assertEquals("Done it.", r.text)
        assertTrue(permissions.pending.value.isEmpty())
    }

    @Test fun deniedApprovalNeverExecutesAndTellsTheModel() = runBlocking {
        val m = ScriptedTestModel(*toolsThenText(listOf(call("test_act", "note" to "go")), "Okay, I won't."))
        model = m
        val job = async(Dispatchers.Default) { router.handle(null, "do something") }
        val pending = withTimeout(5000) { permissions.pending.first { it.isNotEmpty() } }.single()
        permissions.resolve(pending.id, false)
        job.await()
        assertEquals(0, actor.runs)
        val result = m.requests[1].turns.filterIsInstance<Turn.ToolResult>().single()
        assertTrue(result.isError)
        assertTrue(result.content, result.content.contains("declined"))
    }

    @Test fun blockedPolicyRefusesWithoutAsking() = runBlocking {
        policies["test_act"] = "DENY"
        model = ScriptedTestModel(*toolsThenText(listOf(call("test_act", "note" to "go")), "Blocked."))
        router.handle(null, "do something")
        assertEquals(0, actor.runs)
        assertTrue(permissions.pending.value.isEmpty())
        assertTrue(db.activity().since(0).any { it.message.startsWith("Blocked:") })
    }

    @Test fun approvalTimesOutAsDenied() = runBlocking {
        val tool = CountingTool("slow", Risk.ACT)
        val d = permissions.authorize(tool, JsonObject(mapOf("note" to JsonPrimitive("x"))), timeoutMs = 200)
        assertTrue(d is MobilePermissionManager.Decision.Denied)
        assertEquals(0, tool.runs)
    }

    @Test fun unknownCapabilityAndInvalidArgumentsAreRefused() = runBlocking {
        val m = ScriptedTestModel(*toolsThenText(listOf(call("format_phone"), call("test_read", "note" to "x".repeat(50)), call("test_read")), "Couldn't."))
        model = m
        router.handle(null, "try bad things")
        assertEquals(0, reader.runs)
        val results = m.requests[1].turns.filterIsInstance<Turn.ToolResult>()
        assertEquals(3, results.size)
        assertTrue(results.all { it.isError })
        assertTrue(results[0].content.contains("Unknown capability"))
        assertTrue(results[1].content.contains("Invalid arguments"))
        assertTrue(results[2].content.contains("Invalid arguments"))
    }

    @Test fun modelCannotLoopForever() = runBlocking {
        model = ScriptedTestModel(*Array(10) { ModelResponse("", listOf(call("test_read", "note" to "again")), "tool_use") })
        val r = router.handle(null, "loop")
        assertTrue(r.text.contains("stopped after"))
        assertEquals(6, reader.runs)
    }

    @Test fun withoutAModelDirectCommandsStillWork() = runBlocking {
        model = null
        val r = router.handle(null, "remember that my locker code is on the blue card")
        assertEquals("phone (direct command)", r.handledBy)
        assertEquals("my locker code is on the blue card", memory.search("locker").single().content)
        val again = router.handle(r.conversationId, "remember that my locker code is on the blue card")
        assertEquals("I already knew that.", again.text)
        assertEquals(1, db.memories().count())
        val none = router.handle(r.conversationId, "write me a poem")
        assertEquals("none", none.handledBy)
        assertTrue(none.text.contains("No AI model is set up"))
    }

    @Test fun unreachableModelFallsBackToDirectCommands() = runBlocking {
        model = object : ModelProvider {
            override val id = "down"; override val displayName = "Down"
            override suspend fun complete(request: ModelRequest): ModelResponse = throw ProviderUnavailable("HTTP 503")
        }
        val r = router.handle(null, "remember that the wifi password is on the fridge")
        assertTrue(r.text, r.text.contains("unreachable"))
        assertEquals(1, db.memories().count())
        assertTrue(db.activity().since(0).any { it.category == "provider" && it.level == "error" })
    }

    @Test fun conversationAndMemoryPersistAndFeedTheModel() = runBlocking {
        memory.remember("Always answer in French", "rule", "user")
        val m = ScriptedTestModel(ModelResponse("Bonjour", emptyList(), "end_turn"), ModelResponse("Encore", emptyList(), "end_turn"))
        model = m
        val first = router.handle(null, "hello")
        router.handle(first.conversationId, "again")
        assertTrue(m.requests[0].system.contains("Always answer in French"))
        // the second request carries the first exchange as history
        val turns = m.requests[1].turns
        assertEquals(listOf("hello", "Bonjour", "again"), turns.map { when (it) { is Turn.User -> it.text; is Turn.Assistant -> it.text; else -> "" } })
        val stored = conversations.messages(first.conversationId).first()
        assertEquals(listOf("user", "assistant", "user", "assistant"), stored.map { it.role })
        delay(1)
    }
}
