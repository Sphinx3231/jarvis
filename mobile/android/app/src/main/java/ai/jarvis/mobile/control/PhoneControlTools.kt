package ai.jarvis.mobile.control

import ai.jarvis.mobile.runtime.Availability
import ai.jarvis.mobile.runtime.MobileTool
import ai.jarvis.mobile.runtime.Risk
import ai.jarvis.mobile.runtime.ToolOutcome
import ai.jarvis.mobile.runtime.int
import ai.jarvis.mobile.runtime.schema
import ai.jarvis.mobile.runtime.str
import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/** Shared state for a task that operates other apps. */
object PhoneControl {
    /** True while the current request is operating the phone (shows the STOP pill). */
    val inUse = MutableStateFlow(false)
    fun service(): PhoneControlService? = PhoneControlService.instance
    val NOT_ON = Availability(false, "Phone control is off — turn it on in Capabilities → Phone control")

    /** Tool-result wording (shared with the real-model tests, so they test exactly this). */
    fun afterLaunch(app: String, screen: String) = "Opened $app. This is what it shows now — if the user wanted to check or read something, tell them what's here; otherwise continue with screen_tap or screen_type:\n\n$screen"
    fun afterTap(id: Int, label: String, screen: String) = "Tapped [$id] “$label”. This is the screen now — if it has what the user asked for, tell them:\n\n$screen"

    /** Read the screen after an action, giving the app a moment to update. */
    suspend fun screenAfter(waitMs: Long = 900): String {
        delay(waitMs)
        return withContext(Dispatchers.Main) { service()?.snapshot()?.describe() } ?: "(phone control is off)"
    }
}

private fun JsonObject.i(k: String) = this[k]?.jsonPrimitive?.intOrNull
private fun JsonObject.s(k: String) = this[k]?.jsonPrimitive?.content

/** A tool that works on the current screen of another app. */
private abstract class ScreenTool : MobileTool {
    override fun availability(context: Context) = if (PhoneControl.service() != null) Availability.OK else PhoneControl.NOT_ON
    protected fun label(id: Int?): String = id?.let { PhoneControl.service()?.last?.elements?.firstOrNull { e -> e.id == id }?.label?.take(60) }.orEmpty()
    protected suspend fun guard(): String? {
        PhoneControl.inUse.value = true
        val last = withContext(Dispatchers.Main) { PhoneControl.service()?.last }
        return when {
            last == null -> "Read the screen first with screen_read."
            last.isGame -> ScreenSnapshot.GAME_NOTICE
            last.ownApp -> ScreenSnapshot.OWN_APP_NOTICE
            else -> null
        }
    }
}

fun phoneControlTools(): List<MobileTool> = listOf(
    object : ScreenTool() {
        override val name = "screen_read"
        override val title = "Read the screen"
        override val description = "Read what is on the phone's screen right now: numbered elements (buttons, text, fields, list items). Use the numbers with screen_tap and screen_type."
        override val parameters = schema(emptyList())
        override val risk = Risk.READ
        override fun summarize(args: JsonObject) = "Read the screen"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            PhoneControl.inUse.value = true
            val s = withContext(Dispatchers.Main) { PhoneControl.service()?.snapshot() } ?: return ToolOutcome.fail(PhoneControl.NOT_ON.reason)
            return if (s.blocked) ToolOutcome.fail(s.describe()) else ToolOutcome.ok(s.describe())
        }
    },
    object : ScreenTool() {
        override val name = "screen_tap"
        override val title = "Tap on screen"
        override val description = "Tap an element on the screen by its number from the latest screen_read. Returns the screen after the tap."
        override val parameters = schema(listOf("element"), "element" to int("Element number", 1, 500))
        override val risk = Risk.READ
        /** Sending, paying, deleting, posting… and anything in a banking/payment app asks first. */
        override fun riskFor(args: JsonObject): Risk {
            val last = PhoneControl.service()?.last ?: return Risk.ACT
            val e = last.elements.firstOrNull { it.id == args.i("element") } ?: return Risk.ACT
            return if (ActionRisk.isSensitiveApp(last.packageName) || ActionRisk.isConsequential(e.label)) Risk.ACT else Risk.READ
        }
        override fun summarize(args: JsonObject) = "Tap “${label(args.i("element")).ifBlank { "element ${args.i("element")}" }}” in ${PhoneControl.service()?.last?.appName ?: "the app"}"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            guard()?.let { return ToolOutcome.fail(it) }
            val id = args.i("element")!!
            if (PhoneControl.service()?.last?.elements?.none { it.id == id } == true) return ToolOutcome.fail("There's no element $id on the last screen read. Use screen_read.")
            val ok = withContext(Dispatchers.Main) { PhoneControl.service()?.tap(id) } == true
            if (!ok) return ToolOutcome.fail("Couldn't tap element $id")
            val tapped = label(id)
            return ToolOutcome.ok(PhoneControl.afterTap(id, tapped, PhoneControl.screenAfter()))
        }
    },
    object : ScreenTool() {
        override val name = "screen_type"
        override val title = "Type into a field"
        override val description = "Type text into a text field on the screen (by its number from screen_read). Replaces what's in the field. Never used for passwords."
        override val parameters = schema(listOf("element", "text"), "element" to int("Field number", 1, 500), "text" to str("Text to type", 2000))
        override val risk = Risk.READ
        override fun riskFor(args: JsonObject): Risk = if (PhoneControl.service()?.last?.packageName?.let(ActionRisk::isSensitiveApp) != false) Risk.ACT else Risk.READ
        override fun summarize(args: JsonObject) = "Type “${args.s("text")?.take(60)}” into “${label(args.i("element")).ifBlank { "the field" }}”"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            guard()?.let { return ToolOutcome.fail(it) }
            val id = args.i("element")!!
            val e = PhoneControl.service()?.last?.elements?.firstOrNull { it.id == id } ?: return ToolOutcome.fail("There's no element $id on the last screen read")
            if (e.password) return ToolOutcome.fail("Jarvis never types into password fields")
            if (!e.editable) return ToolOutcome.fail("Element $id isn't a text field")
            val ok = withContext(Dispatchers.Main) { PhoneControl.service()?.type(id, args.s("text")!!) } == true
            if (!ok) return ToolOutcome.fail("Couldn't type into element $id")
            return ToolOutcome.ok("Typed into [$id].\n\n" + PhoneControl.screenAfter(600))
        }
    },
    object : ScreenTool() {
        override val name = "screen_scroll"
        override val title = "Scroll"
        override val description = "Scroll the screen up or down to see more. Returns the screen after scrolling."
        override val parameters = schema(listOf("direction"), "direction" to str("up or down", 10, listOf("up", "down")))
        override val risk = Risk.READ
        override fun summarize(args: JsonObject) = "Scroll ${args.s("direction")}"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            guard()?.let { return ToolOutcome.fail(it) }
            val ok = withContext(Dispatchers.Main) { PhoneControl.service()?.scroll(args.s("direction") != "up") } == true
            if (!ok) return ToolOutcome.fail("Couldn't scroll")
            return ToolOutcome.ok("Scrolled ${args.s("direction")}.\n\n" + PhoneControl.screenAfter(700))
        }
    },
    object : ScreenTool() {
        override val name = "screen_back"
        override val title = "Go back"
        override val description = "Press the phone's Back button. Returns the screen after."
        override val parameters = schema(emptyList())
        override val risk = Risk.READ
        override fun summarize(args: JsonObject) = "Press Back"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            PhoneControl.inUse.value = true
            withContext(Dispatchers.Main) { PhoneControl.service()?.back() }
            return ToolOutcome.ok("Pressed Back.\n\n" + PhoneControl.screenAfter(700))
        }
    },
    object : ScreenTool() {
        override val name = "screen_home"
        override val title = "Go home"
        override val description = "Go to the phone's home screen."
        override val parameters = schema(emptyList())
        override val risk = Risk.READ
        override fun summarize(args: JsonObject) = "Go to the home screen"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            PhoneControl.inUse.value = true
            withContext(Dispatchers.Main) { PhoneControl.service()?.home() }
            return ToolOutcome.ok("On the home screen.")
        }
    },
)
