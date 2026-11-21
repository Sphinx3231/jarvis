package ai.jarvis.mobile

import ai.jarvis.mobile.control.ActionRisk
import ai.jarvis.mobile.control.ScreenSnapshot
import ai.jarvis.mobile.control.UiElement
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
import ai.jarvis.mobile.runtime.Policy
import ai.jarvis.mobile.runtime.Risk
import ai.jarvis.mobile.runtime.ToolCall
import ai.jarvis.mobile.runtime.ToolOutcome
import ai.jarvis.mobile.runtime.Turn
import ai.jarvis.mobile.runtime.int
import ai.jarvis.mobile.runtime.schema
import ai.jarvis.mobile.voice.Vad
import ai.jarvis.mobile.voice.VoiceRecorder
import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.nio.ByteBuffer
import java.nio.ByteOrder

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [34])
class PhoneControlTest {
    private val gmail = ScreenSnapshot("com.google.android.gm", "Gmail", listOf(
        UiElement(1, "button", "", "Open navigation drawer", clickable = true),
        UiElement(2, "field", "Search in mail", clickable = true, editable = true),
        UiElement(3, "item", "Amazon · Your order has shipped · 10:42", clickable = true),
        UiElement(4, "item", "Mum · Sunday lunch? · 09:15", clickable = true),
        UiElement(5, "field", "", password = true, editable = true),
        UiElement(6, "list", "", scrollable = true),
    ), truncated = true)

    @Test fun screensReadAsNumberedElementsWithoutPasswords() {
        val d = gmail.describe()
        assertTrue(d.startsWith("Screen: Gmail (com.google.android.gm)\n"))
        assertTrue(d, d.contains("[2] field \"Search in mail\" {tap,type}"))
        assertTrue(d.contains("[3] item \"Amazon · Your order has shipped · 10:42\" {tap}"))
        assertTrue(d.contains("[5] field (password, hidden)"))
        assertFalse("password fields can't be typed into", d.contains("[5] field (password, hidden) {type"))
        assertTrue(d.contains("[6] list {scroll}"))
        assertTrue(d.trimEnd().endsWith("(more below — use screen_scroll down)"))
        val body = "Hi love, are you coming for Sunday lunch at 1pm? Could you bring the dessert? Dad is making roast chicken and your aunt is coming too."
        assertTrue("message text is read in full", ScreenSnapshot("p", "Gmail", listOf(UiElement(1, "text", body))).describe().contains(body))
        val game = ScreenSnapshot("com.epicgames.fortnite", "Fortnite", emptyList(), isGame = true)
        assertTrue(game.blocked)
        assertTrue(game.describe().contains("doesn't play or control games"))
        assertTrue(ScreenSnapshot("ai.jarvis.mobile", "Jarvis", emptyList(), ownApp = true).blocked)
    }

    @Test fun consequentialTapsSensitiveAppsAndGamesAreRecognized() {
        for (label in listOf("Send", "Reply all", "Delete", "Pay now", "Buy", "Place order", "Confirm transfer", "Post", "Sign out", "Install", "Send message to Alex now please"))
            assertTrue(label, ActionRisk.isConsequential(label))
        for (label in listOf("Inbox", "Amazon · Your order has shipped · 10:42", "Mum · Can you send me the photos? · 09:15", "Back", "Search in mail", "Open navigation drawer", "Primary"))
            assertFalse(label, ActionRisk.isConsequential(label))
        for (pkg in listOf("com.chase.sig.android", "com.infonow.bofa", "com.squareup.cash", "com.paypal.android.p2pmobile", "com.coinbase.android", "com.google.android.apps.walletnfcrel", "com.android.settings", "com.android.vending"))
            assertTrue(pkg, ActionRisk.isSensitiveApp(pkg))
        for (pkg in listOf("com.google.android.gm", "com.spotify.music", "com.whatsapp", "com.google.android.youtube")) assertFalse(pkg, ActionRisk.isSensitiveApp(pkg))
        assertTrue(ActionRisk.isKnownGame("com.epicgames.fortnite"))
        assertFalse(ActionRisk.isKnownGame("com.spotify.music"))
    }

    @Test fun permissionsJudgeEachCallNotJustTheTool() {
        val ctx: Context = ApplicationProvider.getApplicationContext()
        val db = JarvisDatabase.inMemory(ctx)
        val tap = object : MobileTool {
            override val name = "screen_tap"; override val title = "Tap"; override val description = "t"
            override val parameters = schema(listOf("element"), "element" to int("n", 1, 99)); override val risk = Risk.READ
            override fun riskFor(args: JsonObject) = if (args["element"]?.jsonPrimitive?.content == "9") Risk.ACT else Risk.READ
            override fun summarize(args: JsonObject) = "tap"
            override suspend fun execute(context: Context, args: JsonObject) = ToolOutcome.ok("ok")
        }
        val pm = MobilePermissionManager(db.activity()) { emptyMap() }
        assertEquals(Policy.ALLOW, pm.policyFor(tap, JsonObject(mapOf("element" to JsonPrimitive(3)))))
        assertEquals("tapping a Send button asks first", Policy.ASK, pm.policyFor(tap, JsonObject(mapOf("element" to JsonPrimitive(9)))))
        db.close()
    }

    @Test fun onlyTheLatestScreenIsShownInFull() {
        val screen = "Screen: Gmail (com.google.android.gm)\n" + (1..40).joinToString("\n") { "[$it] item \"Mail $it\" {tap}" }
        val turns = listOf(
            Turn.User("check my gmail"),
            Turn.Assistant("", listOf(ToolCall("1", "app_launch", JsonObject(emptyMap())))),
            Turn.ToolResult("1", "app_launch", "Opened Gmail.\n\n$screen", false),
            Turn.Assistant("", listOf(ToolCall("2", "screen_tap", JsonObject(emptyMap())))),
            Turn.ToolResult("2", "screen_tap", "Tapped [3].\n\n$screen", false),
        )
        val out = MobileExecutionRouter.compactScreens(turns)
        assertEquals("Opened Gmail. … (earlier screen, no longer shown)", (out[2] as Turn.ToolResult).content)
        assertEquals(turns[4], out[4])
    }

    @Test fun aCheckRequestAnsweredWithAQuestionGetsOneNudge() {
        val screen = listOf(Turn.User("check my gmail"), Turn.ToolResult("1", "app_launch", "Opened Gmail…", false))
        assertTrue(MobileExecutionRouter.needsReadNudge("Check my Gmail", screen, "What would you like to check?"))
        assertTrue(MobileExecutionRouter.needsReadNudge("hey jarvis, what's new in WhatsApp", screen, "Which chat?"))
        assertFalse("an answer is fine", MobileExecutionRouter.needsReadNudge("Check my Gmail", screen, "You have 3 new emails: Amazon, Mum and GitHub."))
        assertFalse("other requests may need a question", MobileExecutionRouter.needsReadNudge("Reply to Mum", screen, "What should I say?"))
        assertFalse("no screen yet", MobileExecutionRouter.needsReadNudge("Check my Gmail", listOf(Turn.User("check my gmail")), "Which account?"))
    }

    @Test fun appTasksGetMoreSteps() = runBlocking {
        val ctx: Context = ApplicationProvider.getApplicationContext()
        val db = JarvisDatabase.inMemory(ctx)
        var reads = 0
        val read = object : MobileTool {
            override val name = "screen_read"; override val title = "Read"; override val description = "r"
            override val parameters = schema(emptyList()); override val risk = Risk.READ
            override fun summarize(args: JsonObject) = "read"
            override suspend fun execute(context: Context, args: JsonObject): ToolOutcome { reads++; return ToolOutcome.ok("Screen: X (x)\n[1] item \"a\" {tap}") }
        }
        // TEST DOUBLE: a model that keeps reading the screen 10 times, then answers.
        var calls = 0
        val model = object : ModelProvider {
            override val id = "t"; override val displayName = "t"; override val onDevice = true
            override suspend fun complete(request: ModelRequest): ModelResponse =
                if (++calls <= 10) ModelResponse("", listOf(ToolCall("c$calls", "screen_read", JsonObject(emptyMap()))), "tool_use") else ModelResponse("All done.", emptyList(), "end_turn")
        }
        val activity = ActivityLog(db.activity())
        val router = MobileExecutionRouter(ctx, { model }, MobileToolRegistry(listOf(read)), MobilePermissionManager(db.activity()) { emptyMap() },
            MobileConversationManager(db.conversations()), MobileMemoryManager(db.memories(), activity), activity)
        assertEquals("All done.", router.handle(null, "do it in the app").text)
        assertEquals(10, reads)
        db.close()
    }

    @Test fun voiceStopsAfterAPauseAndWritesAWav() {
        val vad = Vad()
        var stoppedAt = -1
        // 300 ms of room noise, 1 s of speech, then quiet.
        for (ms in 0 until 6000 step 20) {
            val level = when { ms < 300 -> 120f; ms < 1300 -> 2500f; else -> 130f }
            if (vad.feed(level, 20)) { stoppedAt = ms; break }
        }
        assertTrue(vad.heardSpeech)
        assertTrue("stops ~1.2 s after speech ends (was $stoppedAt)", stoppedAt in 2400..2600)
        val silent = Vad()
        var t = 0
        while (!silent.feed(100f, 20)) t += 20
        assertFalse(silent.heardSpeech)
        assertTrue(t in 5900..6100)

        val wav = VoiceRecorder.wav(ByteArray(3200), 16_000)
        val b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals("RIFF", String(wav, 0, 4)); assertEquals("WAVE", String(wav, 8, 4)); assertEquals("data", String(wav, 36, 4))
        assertEquals(16_000, b.getInt(24)); assertEquals(1.toShort(), b.getShort(22)); assertEquals(16.toShort(), b.getShort(34)); assertEquals(3200, b.getInt(40))
    }
}
