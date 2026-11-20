package ai.jarvis.mobile

import ai.jarvis.mobile.data.JarvisDatabase
import ai.jarvis.mobile.runtime.ActivityLog
import ai.jarvis.mobile.runtime.MobileConversationManager
import ai.jarvis.mobile.runtime.MobileExecutionRouter
import ai.jarvis.mobile.runtime.MobileMemoryManager
import ai.jarvis.mobile.runtime.MobilePermissionManager
import ai.jarvis.mobile.runtime.MobileToolRegistry
import ai.jarvis.mobile.runtime.ModelProvider
import ai.jarvis.mobile.runtime.ModelRequest
import ai.jarvis.mobile.runtime.ModelResponse
import ai.jarvis.mobile.runtime.Risk
import ai.jarvis.mobile.runtime.brain.Brain
import ai.jarvis.mobile.runtime.brain.FileNoteStore
import ai.jarvis.mobile.runtime.brain.brainTools
import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [34])
class BrainTest {
    private lateinit var ctx: Context
    private lateinit var dir: File
    private lateinit var brain: Brain
    private lateinit var db: JarvisDatabase

    @Before fun setUp() = runBlocking {
        ctx = ApplicationProvider.getApplicationContext()
        dir = File(ctx.cacheDir, "vault-test").apply { deleteRecursively(); mkdirs() }
        File(dir, "Gym plan.md").writeText("# Gym plan\n\nMonday: legs and core. Wednesday: back. Friday: chest and shoulders.\n")
        File(dir, "Projects").mkdirs()
        File(dir, "Projects/Garden.md").writeText("Tomatoes need watering every second day. The gym is closed on Sundays.\n")
        File(dir, ".obsidian").mkdirs()
        File(dir, ".obsidian/workspace.md").writeText("gym gym gym") // app config: never read
        brain = Brain { FileNoteStore(dir, "Test vault") }
        db = JarvisDatabase.inMemory(ctx)
    }

    @After fun tearDown() = db.close()

    @Test fun searchRanksTitlesFirstAndSkipsHiddenFolders() = runBlocking {
        val notes = brain.notes().map { it.path }.toSet()
        assertEquals(setOf("Gym plan.md", "Projects/Garden.md"), notes)
        val hits = brain.search("what's my gym plan?")
        assertEquals("Gym plan.md", hits.first().note.path)
        assertTrue(hits.first().snippet.contains("Monday: legs"))
        assertTrue(hits.any { it.note.path == "Projects/Garden.md" })
        assertTrue(brain.search("the and of").isEmpty())
    }

    @Test fun relevantNotesReachTheModelAndExchangesAreFiled() = runBlocking {
        val seen = mutableListOf<ModelRequest>()
        val model = object : ModelProvider {
            override val id = "test"; override val displayName = "Test model"
            override suspend fun complete(request: ModelRequest): ModelResponse { seen += request; return ModelResponse("Legs and core on Monday.", emptyList(), "end_turn") }
        }
        val activity = ActivityLog(db.activity())
        val memory = MobileMemoryManager(db.memories(), activity) { k, c -> brain.logMemory(k, c) }
        val router = MobileExecutionRouter(ctx, { model }, MobileToolRegistry(brainTools(brain)), MobilePermissionManager(db.activity()) { emptyMap() },
            MobileConversationManager(db.conversations()), memory, activity, brain = brain, logToBrain = { true })
        val r = router.handle(null, "What's on my gym plan for Monday?")
        assertTrue(seen.single().system, seen.single().system.contains("From the user's notes") && seen.single().system.contains("Monday: legs"))
        // The exchange is filed as a note, and a second turn appends to the same note.
        router.handle(r.conversationId, "And Friday?")
        val convo = brain.notes().single { it.path.startsWith("Jarvis/Conversations/") }
        val text = brain.read(convo.path)!!
        assertTrue(text, text.startsWith("# What's on my gym plan for Monday?"))
        assertTrue(text.contains("**You**") && text.contains("And Friday?") && text.contains("Legs and core on Monday."))
        // Remembered facts are mirrored to Jarvis/Memory.md.
        memory.remember("I train at 7am", "preference", "user")
        assertTrue(brain.read("Jarvis/Memory.md")!!.contains("- [preference] I train at 7am"))
        // Nothing is filed when the user turns it off.
        val quiet = MobileExecutionRouter(ctx, { model }, MobileToolRegistry(emptyList()), MobilePermissionManager(db.activity()) { emptyMap() },
            MobileConversationManager(db.conversations()), memory, activity, brain = brain, logToBrain = { false })
        val before = brain.notes().size
        quiet.handle(null, "Something private")
        assertEquals(before, brain.notes().size)
    }

    @Test fun toolsReadFreelyButWritingAsksFirst() = runBlocking {
        val tools = brainTools(brain).associateBy { it.name }
        assertEquals(Risk.READ, tools.getValue("brain_search").risk)
        assertEquals(Risk.READ, tools.getValue("brain_read").risk)
        assertEquals(Risk.ACT, tools.getValue("brain_write").risk)
        assertTrue(tools.getValue("brain_search").execute(ctx, JsonObject(mapOf("query" to JsonPrimitive("tomatoes")))).content.contains("Projects/Garden.md"))
        assertTrue(tools.getValue("brain_read").execute(ctx, JsonObject(mapOf("title" to JsonPrimitive("gym plan")))).content.contains("Friday: chest"))
        tools.getValue("brain_write").execute(ctx, JsonObject(mapOf("title" to JsonPrimitive("Lists/Groceries"), "content" to JsonPrimitive("- milk"))))
        tools.getValue("brain_write").execute(ctx, JsonObject(mapOf("title" to JsonPrimitive("Lists/Groceries"), "content" to JsonPrimitive("- eggs"), "append" to JsonPrimitive(true))))
        assertEquals("- milk\n\n- eggs\n", File(dir, "Lists/Groceries.md").readText())
    }

    @Test fun notePathsCannotLeaveTheVault() = runBlocking {
        assertEquals("etc/passwd.md", Brain.notePath("../../etc/passwd"))
        assertEquals("Untitled.md", Brain.notePath("../.."))
        brain.write("../../escape", "x", append = false)
        assertTrue(File(dir, "escape.md").exists())
        assertNull(File(dir.parentFile, "escape.md").takeIf { it.exists() })
        val store = FileNoteStore(dir, "t")
        assertNull(store.read("../outside.md"))
        assertNotNull(runCatching { store.write("../outside.md", "x") }.exceptionOrNull())
    }
}
