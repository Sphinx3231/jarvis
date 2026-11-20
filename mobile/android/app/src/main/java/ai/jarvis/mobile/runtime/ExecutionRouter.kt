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
                runModel(conv, text, model)
            } catch (e: ProviderUnavailable) {
                activity.log("error", "provider", "Model unavailable: ${e.message}")
                LocalIntents.handle(text, context, registry, permissions, memory, activity, this::setPhase)
                    ?.let { Result(conv, "${it.first}\n\n(Your model is unreachable — ${e.message?.take(120)} — so I handled this as a direct command.)", it.second, "phone (direct command)") }
                    ?: Result(conv, "I couldn't reach your model (${e.message?.take(160)}). Check your connection or the model settings, or switch to Remote PC mode.", emptyList(), "none")
            }
        }
        conversations.add(conv, "assistant", r.text, """{"handledBy":"${r.handledBy}","tools":${r.toolsUsed.joinToString(prefix = "[", postfix = "]") { "\"$it\"" }}}""")
        setPhase(Phase.DONE, "Done")
        return r
    }

    private fun setPhase(p: Phase, detail: String) { _status.value = Status(p, detail) }

    private suspend fun runModel(conv: String, text: String, model: ModelProvider): Result {
        setPhase(Phase.THINKING, "Thinking with ${model.displayName}")
        val standing = memory.standing()
        val relevant = memory.search(text, 6).filter { m -> standing.none { it.id == m.id } }
        val system = buildString {
            append("You are Jarvis Mobile, the user's assistant running on their Android phone. The PHONE is executing this request (not the user's PC). ")
            append("You can only act through the tools listed; each is a narrow phone capability. Actions that change something may wait for the user's approval on screen — you cannot approve anything yourself. ")
            append("Never claim an action happened unless its tool result says so. Be concise.\n")
            append("Current time: ${java.time.ZonedDateTime.now()}\n")
            if (standing.isNotEmpty()) append("The user's standing rules and preferences:\n" + standing.joinToString("\n") { "- ${it.content}" } + "\n")
            if (relevant.isNotEmpty()) append("Relevant memories:\n" + relevant.joinToString("\n") { "- [${it.kind}] ${it.content}" } + "\n")
        }
        val history = conversations.history(conv, 16).dropLast(1).mapNotNull { m ->
            when (m.role) { "user" -> Turn.User(m.content); "assistant" -> Turn.Assistant(m.content); else -> null }
        }.dropWhile { it !is Turn.User }
        val turns = (history + Turn.User(text)).toMutableList()
        val used = mutableListOf<String>()
        repeat(maxSteps) {
            val resp = model.complete(ModelRequest(system, turns, registry.specs(context)))
            if (resp.toolCalls.isEmpty()) return Result(conv, resp.text.ifBlank { "Done." }, used, model.displayName)
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

/**
 * Direct commands that work with no model at all (offline, or no provider configured). They go
 * through the same validation and authorization as model-proposed calls.
 */
object LocalIntents {
    suspend fun handle(
        text: String,
        context: Context,
        registry: MobileToolRegistry,
        permissions: MobilePermissionManager,
        memory: MobileMemoryManager,
        activity: ActivityLog,
        phase: (MobileExecutionRouter.Phase, String) -> Unit,
    ): Pair<String, List<String>>? {
        val t = text.trim()
        suspend fun run(name: String, args: Map<String, Any>): Pair<String, List<String>> {
            val tool = registry.get(name)!!
            val json = JsonObject(args.mapValues { (_, v) -> if (v is Number) JsonPrimitive(v) else JsonPrimitive(v.toString()) })
            registry.validate(tool, json)?.let { return "I couldn't do that: $it" to emptyList() }
            if (!tool.availability(context).available) return "${tool.title} isn't available: ${tool.availability(context).reason}" to emptyList()
            phase(MobileExecutionRouter.Phase.WAITING_FOR_APPROVAL, tool.summarize(json))
            val d = permissions.authorize(tool, json)
            if (d is MobilePermissionManager.Decision.Denied) return "Not done: ${d.reason}." to emptyList()
            phase(MobileExecutionRouter.Phase.WORKING, tool.summarize(json))
            val out = tool.execute(context, json)
            activity.log(if (out.ok) "success" else "warning", "tool", "${tool.summarize(json)} → ${out.content.take(120)}")
            return (if (out.ok) "${tool.summarize(json)} — done. ${out.content.takeIf { it.startsWith("{") || it.startsWith("[") } ?: ""}".trim() else "That didn't work: ${out.content}") to listOf(name)
        }
        Regex("^(?:jarvis,?\\s+)?remember(?: that)?[:,]?\\s+(.{3,})$", RegexOption.IGNORE_CASE).find(t)?.let {
            val (m, merged) = memory.remember(it.groupValues[1], if (Regex("\\b(from now on|always|never)\\b", RegexOption.IGNORE_CASE).containsMatchIn(it.groupValues[1])) "rule" else "fact", "user")
            return (if (merged) "I already knew that." else "Got it — I'll remember that on this phone.") to listOf("memory_remember")
        }
        Regex("^remind me in (\\d{1,5}) ?(minutes?|mins?|hours?|h)\\b(?: to)?\\s*(.+)$", RegexOption.IGNORE_CASE).find(t)?.let {
            val n = it.groupValues[1].toInt()
            val minutes = if (it.groupValues[2].lowercase().startsWith("h")) n * 60 else n
            return run("reminder_schedule", mapOf("text" to it.groupValues[3], "inMinutes" to minutes))
        }
        if (Regex("\\bbattery\\b", RegexOption.IGNORE_CASE).containsMatchIn(t)) return run("device_battery", emptyMap())
        if (Regex("\\b(network|wi-?fi|online|connection)\\b", RegexOption.IGNORE_CASE).containsMatchIn(t) && t.length < 60) return run("device_network", emptyMap())
        Regex("^open (https?://\\S+)$", RegexOption.IGNORE_CASE).find(t)?.let { return run("open_url", mapOf("url" to it.groupValues[1])) }
        return null
    }
}
