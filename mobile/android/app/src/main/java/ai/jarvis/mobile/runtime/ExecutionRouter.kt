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
        val system = buildString {
            append("You are Jarvis, the user's personal assistant, running on their Android phone (not their PC). Be brief and friendly.\n")
            val now = java.time.ZonedDateTime.now()
            append("Current time: ${now.toLocalDate()} ${"%02d:%02d".format(now.hour, now.minute)} (${now.dayOfWeek.name.lowercase().replaceFirstChar { it.uppercase() }}).\n")
            val known = standing + relevant
            if (known.isNotEmpty()) append("What you know about the user:\n" + known.joinToString("\n") { "- ${it.content}" } + "\n")
            if (!model.onDevice) append("Act only through the tools provided; actions that change something may wait for the user's approval on screen, and you cannot approve anything yourself. Never say something happened unless its tool result says so.\n")
        }
        val history = conversations.history(conv, 16).dropLast(1).mapNotNull { m ->
            when (m.role) { "user" -> Turn.User(m.content); "assistant" -> Turn.Assistant(m.content); else -> null }
        }.dropWhile { it !is Turn.User }
        val turns = (history + Turn.User(text)).toMutableList()
        val used = mutableListOf<String>()
        repeat(maxSteps) {
            val resp = model.complete(ModelRequest(system, turns, registry.specs(context)))
            if (resp.toolCalls.isEmpty()) return Result(conv, honest(resp.text.ifBlank { if (used.isEmpty()) "I'm not sure how to help with that." else "Done." }, used, model), used, model.displayName)
            turns += Turn.Assistant(resp.text, resp.toolCalls)
            for (call in resp.toolCalls) {
                val out = execute(call)
                used += call.name
                turns += Turn.ToolResult(call.id, call.name, out.content.take(8000), !out.ok)
            }
            setPhase(Phase.THINKING, "Thinking with ${model.displayName}")
        }
        return Result(conv, "I stopped after $maxSteps steps without finishing. Try a simpler request.", used, model.displayName)
    }

    /** Validate → check availability → authorize → execute. Every outcome is logged. */
    suspend fun execute(call: ToolCall): ToolOutcome {
        val tool = registry.get(call.name) ?: return ToolOutcome.fail("Unknown capability \"${call.name}\" — it doesn't exist on this phone").also { activity.log("warning", "tool", "Refused unknown capability ${call.name}") }
        registry.validate(tool, call.arguments)?.let { err -> activity.log("warning", "tool", "Invalid arguments for ${tool.name}: $err"); return ToolOutcome.fail("Invalid arguments: $err") }
        val avail = tool.availability(context)
        if (!avail.available) return ToolOutcome.fail("${tool.title} is unavailable: ${avail.reason}")
        setPhase(Phase.WAITING_FOR_APPROVAL, tool.summarize(call.arguments))
        when (val d = permissions.authorize(tool, call.arguments)) {
            is MobilePermissionManager.Decision.Denied -> return ToolOutcome.fail("Not done: ${d.reason}")
            MobilePermissionManager.Decision.Allowed -> {}
        }
        setPhase(Phase.WORKING, tool.summarize(call.arguments))
        return try {
            tool.execute(context, call.arguments).also { activity.log(if (it.ok) "success" else "warning", "tool", "${tool.summarize(call.arguments)} → ${it.content.take(120)}") }
        } catch (e: Exception) {
            activity.log("error", "tool", "${tool.name} failed: ${e.message}")
            ToolOutcome.fail("${tool.title} failed: ${e.message}")
        }
    }
}
