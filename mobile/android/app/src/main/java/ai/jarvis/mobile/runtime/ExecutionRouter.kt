package ai.jarvis.mobile.runtime

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Mobile Jarvis's orchestrator, fully on the phone:
 *   model reasoning  →  tool selection (the model proposes)  →  validation (schema, availability)
 *   →  authorization (MobilePermissionManager: policy / user approval)  →  native execution
 *   →  results back to the model  →  answer, saved with the conversation.
 * The model never calls an Android API; it can only propose a call to a registered capability,
 * and nothing runs until this router has validated and authorized that exact call.
 */
class MobileExecutionRouter(
    private val context: Context,
    private val provider: () -> ModelProvider?,
    private val registry: MobileToolRegistry,
    private val permissions: MobilePermissionManager,
    private val conversations: MobileConversationManager,
    private val memory: MobileMemoryManager,
    private val activity: ActivityLog,
    private val maxSteps: Int = 6,
    /** The user's notes vault: relevant notes go to the model; exchanges are filed there. */
    private val brain: ai.jarvis.mobile.runtime.brain.Brain? = null,
    private val logToBrain: () -> Boolean = { false },
) {
    enum class Phase { IDLE, THINKING, WORKING, WAITING_FOR_APPROVAL, DONE, ERROR }
    data class Status(val phase: Phase = Phase.IDLE, val detail: String = "Ready")

    data class Result(val conversationId: String, val text: String, val toolsUsed: List<String>, val handledBy: String)

    private val _status = MutableStateFlow(Status())
    val status: StateFlow<Status> = _status

    suspend fun handle(conversationId: String?, text: String): Result {
        val conv = conversations.ensure(conversationId, text)
        conversations.add(conv, "user", text)
        val model = provider()
        val r = if (model == null) {
            LocalIntents.handle(text, context, registry, permissions, memory, activity, this::setPhase)
                ?.let { Result(conv, it.first, it.second, "phone (direct command)") }
                ?: Result(conv, "No AI model is set up for Mobile Jarvis yet, so I can only do direct commands: “remember that …”, “remind me in 10 minutes to …”, “battery”, “network”, “open https://…”. Add a model in Settings → Model, or switch to Remote PC mode to use your PC's Jarvis.", emptyList(), "none")
        } else {
            try {
                // A small on-device model is unreliable at choosing tools, so clear commands are
                // handled directly first (same validation and approvals); the model handles the rest.
                (if (model.onDevice) LocalIntents.handle(text, context, registry, permissions, memory, activity, this::setPhase)?.let { Result(conv, it.first, it.second, "phone (direct command)") } else null)
                    ?: runModel(conv, text, model)
            } catch (e: ProviderUnavailable) {
                activity.log("error", "provider", "Model unavailable: ${e.message}")
                LocalIntents.handle(text, context, registry, permissions, memory, activity, this::setPhase)
                    ?.let { Result(conv, "${it.first}\n\n(Your model ${if (model.onDevice) "isn't available" else "is unreachable"} — ${e.message?.take(120)} — so I handled this as a direct command.)", it.second, "phone (direct command)") }
                    ?: Result(conv, if (model.onDevice) "The on-device model isn't available right now (${e.message?.take(160)}). Direct commands still work: “battery”, “set an alarm for 7:30”, “remind me in 10 minutes to …”, “remember that …”." else "I couldn't reach your model (${e.message?.take(160)}). Check your connection or the model settings, or switch to Remote PC mode.", emptyList(), "none")
            }
        }
        val b = brain
        if (b != null && logToBrain()) runCatching { b.logExchange(conv, conversations.title(conv) ?: text, text, r.text, r.handledBy) }
            .onFailure { activity.log("warning", "brain", "Couldn't save the conversation to the brain: ${it.message}") }
        conversations.add(conv, "assistant", r.text, """{"handledBy":"${r.handledBy}","tools":${r.toolsUsed.joinToString(prefix = "[", postfix = "]") { "\"$it\"" }}}""")
        setPhase(Phase.DONE, "Done")
        return r
    }

    private fun setPhase(p: Phase, detail: String) { _status.value = Status(p, detail) }

    /**
     * Small models sometimes describe an action or a reading as if it happened ("I've set your alarm",
     * "your battery is 50%") without using a tool. Say so plainly instead of letting it stand.
     */
    private fun honest(text: String, used: List<String>, model: ModelProvider): String {
        if (!model.onDevice || used.isNotEmpty()) return text
        val claim = Regex("""\b(I('ve| have)\s+(set|saved|scheduled|created|added|sent|opened|remembered|noted|started|turned)|I('ll| will) remind you|(battery|charge)( level)? is (at )?\d+\s?%|you('re| are) (connected|on wi-?fi|online|offline)|(searching|opening|calling|dialing) (the web|now|it))""", RegexOption.IGNORE_CASE)
        if (!claim.containsMatchIn(text)) return text
        return "$text\n\n(Note: nothing was actually done on the phone — the on-device model only replied. For actions, try a direct command such as “set an alarm for 7:30”, “remind me in 10 minutes to …”, “remember that …” or “battery”.)"
    }

    private suspend fun runModel(conv: String, text: String, model: ModelProvider): Result {
        setPhase(Phase.THINKING, "Thinking with ${model.displayName}")
        val standing = memory.standing()
        val relevant = memory.search(text, 6).filter { m -> standing.none { it.id == m.id } }
        val notes = brain?.let { bn -> runCatching { bn.contextFor(text) }.getOrNull() }
        val specs = registry.specs(context)
        val system = systemPrompt(model.onDevice, java.time.ZonedDateTime.now(), (standing + relevant).map { it.content }, notes, phoneControl = specs.any { it.name == "screen_read" })
        val history = conversations.history(conv, 16).dropLast(1).mapNotNull { m ->
            when (m.role) { "user" -> Turn.User(m.content); "assistant" -> Turn.Assistant(m.content); else -> null }
        }.dropWhile { it !is Turn.User }
        val turns = (history + Turn.User(text)).toMutableList()
        val used = mutableListOf<String>()
        var steps = 0
        var nudged = false
        while (true) {
            // Working inside apps takes more steps than a single action.
            val limit = if (used.any { isScreenTool(it) }) PHONE_STEPS else maxSteps
            if (steps++ >= limit) break
            val resp = model.complete(ModelRequest(system, compactScreens(turns), specs))
            // A small model sometimes "speaks" an ordinary reply; unless the user asked for it out loud, show it as text.
            if (model.onDevice) speakAsReply(resp.toolCalls, text)?.let { return Result(conv, it, used, model.displayName) }
            // "Check my Gmail": a small model sometimes asks what to check instead of reading the screen it has. Nudge once.
            if (resp.toolCalls.isEmpty() && !nudged && needsReadNudge(text, turns, resp.text)) {
                nudged = true
                turns += Turn.Assistant(resp.text)
                turns += Turn.User(READ_NUDGE)
                continue
            }
            if (resp.toolCalls.isEmpty()) return Result(conv, honest(resp.text.ifBlank { if (used.isEmpty()) "I'm not sure how to help with that." else "Done." }, used, model), used, model.displayName)
            turns += Turn.Assistant(resp.text, resp.toolCalls)
            for (call in resp.toolCalls) {
                val out = execute(call)
                used += call.name
                turns += Turn.ToolResult(call.id, call.name, out.content.take(8000), !out.ok)
            }
            setPhase(Phase.THINKING, "Thinking with ${model.displayName}")
        }
        return Result(conv, "I stopped after ${steps - 1} steps without finishing. Try a simpler request.", used, model.displayName)
    }

    /** Validate → check availability → authorize → execute. Every outcome is logged. */
    suspend fun execute(call: ToolCall): ToolOutcome {
        val tool = registry.get(call.name) ?: return ToolOutcome.fail("Unknown capability \"${call.name}\" — it doesn't exist on this phone").also { activity.log("warning", "tool", "Refused unknown capability ${call.name}") }
        val args = registry.sanitize(tool, call.arguments)
        registry.validate(tool, args)?.let { err -> activity.log("warning", "tool", "Invalid arguments for ${tool.name}: $err"); return ToolOutcome.fail("Invalid arguments: $err") }
        val avail = tool.availability(context)
        if (!avail.available) return ToolOutcome.fail("${tool.title} is unavailable: ${avail.reason}")
        setPhase(Phase.WAITING_FOR_APPROVAL, tool.summarize(args))
        when (val d = permissions.authorize(tool, args)) {
            is MobilePermissionManager.Decision.Denied -> return ToolOutcome.fail("Not done: ${d.reason}")
            MobilePermissionManager.Decision.Allowed -> {}
        }
        setPhase(Phase.WORKING, tool.summarize(args))
        return try {
            tool.execute(context, args).also { activity.log(if (it.ok) "success" else "warning", "tool", "${tool.summarize(args)} → ${it.content.take(120)}") }
        } catch (e: Exception) {
            activity.log("error", "tool", "${tool.name} failed: ${e.message}")
            ToolOutcome.fail("${tool.title} failed: ${e.message}")
        }
    }

    companion object {
        const val PHONE_STEPS = 20
        const val READ_NUDGE = "Just tell me what's there — summarize what the screen shows (for messages: who they're from and what they're about)."

        /** The user asked to check/read something, the model has a screen, and it answered with a question. */
        fun needsReadNudge(userText: String, turns: List<Turn>, reply: String): Boolean {
            val asked = Regex("^(?:(?:hey |ok )?jarvis,? )?(?:please |can you |could you )?(check|read|look at|show me|go through|what'?s (?:in|on|new in)|any new)\\b", RegexOption.IGNORE_CASE).containsMatchIn(userText.trim())
            val hasScreen = turns.lastOrNull() is Turn.ToolResult && isScreenTool((turns.last() as Turn.ToolResult).name)
            return asked && hasScreen && reply.trim().endsWith("?")
        }

        fun isScreenTool(name: String) = name.startsWith("screen_") || name == "app_launch"

        /**
         * Only the latest screen matters: earlier screen results are cut to their first line, so a long
         * task inside an app doesn't overflow a small model's context.
         */
        fun compactScreens(turns: List<Turn>): List<Turn> {
            val lastScreen = turns.indexOfLast { it is Turn.ToolResult && isScreenTool(it.name) }
            return turns.mapIndexed { i, t ->
                if (t is Turn.ToolResult && isScreenTool(t.name) && i != lastScreen && t.content.length > 200)
                    t.copy(content = t.content.lineSequence().first().take(160) + " … (earlier screen, no longer shown)")
                else t
            }
        }

        /** The text of a lone `speak` call when the user didn't ask for anything to be said aloud. */
        fun speakAsReply(calls: List<ToolCall>, userText: String): String? {
            val c = calls.singleOrNull()?.takeIf { it.name == "speak" } ?: return null
            if (Regex("\\b(say|speak|read|aloud|out loud|tell me out loud|announce)\\b", RegexOption.IGNORE_CASE).containsMatchIn(userText)) return null
            return (c.arguments["text"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.takeIf { it.isNotBlank() }
        }

        /** The instructions every model gets. The on-device wording was tuned against Gemma 4 E2B (mobile/scripts/local-model-check.sh). */
        fun systemPrompt(onDevice: Boolean, now: java.time.ZonedDateTime, known: List<String>, notes: String?, phoneControl: Boolean = false): String = buildString {
            append("You are Jarvis, the user's personal assistant, running on their Android phone (not their PC). Be brief and friendly.\n")
            append("Current time: ${now.toLocalDate()} ${"%02d:%02d".format(now.hour, now.minute)} (${now.dayOfWeek.name.lowercase().replaceFirstChar { it.uppercase() }}).\n")
            if (known.isNotEmpty()) append("What you know about the user:\n" + known.joinToString("\n") { "- $it" } + "\n")
            if (notes != null) append("From the user's notes (their brain), possibly relevant:\n$notes\n")
            if (onDevice) {
                append("Answer questions, jokes, maths, advice and chat directly in text, without any tool. ")
                append("Use a tool only when the user asks you to do something on the phone, or asks about the phone, their notes or what you remember. ")
                append("\"Notes\" means the user's notes vault: use the brain_ tools for notes, and the memory_ tools only for short facts. ")
                append("If no tool fits a request, say you can't do that on the phone yet. Never say something happened unless a tool result says so.\n")
                if (phoneControl) {
                    append("You can also operate apps like a person: open the app with app_launch (you get its screen back as numbered elements), then use screen_tap with an element number, screen_type, screen_scroll or screen_back. ")
                    append("Each action returns the new screen. Read the screen before acting, pick elements only from the latest screen, and when you have what the user asked for, stop and answer in text. ")
                    append("You can't control games.\n")
                }
            } else {
                append("Act only through the tools provided; actions that change something may wait for the user's approval on screen, and you cannot approve anything yourself. Never say something happened unless its tool result says so.\n")
            }
        }
    }
}
