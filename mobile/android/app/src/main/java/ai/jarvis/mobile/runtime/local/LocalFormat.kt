package ai.jarvis.mobile.runtime.local

import ai.jarvis.mobile.runtime.ModelResponse
import ai.jarvis.mobile.runtime.ToolCall
import ai.jarvis.mobile.runtime.ToolSpec
import ai.jarvis.mobile.runtime.Turn
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.OpenApiTool
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import com.google.ai.edge.litertlm.ToolCall as LmToolCall

/**
 * Conversion between Jarvis's model-neutral turns and the LiteRT-LM conversation API (the model's
 * own chat template and native function calling). Tool calls come back to the router — the
 * runtime never runs a tool by itself (automatic tool calling is off).
 */
object LocalFormat {
    /** A tool as the runtime wants it: an OpenAPI function. `execute` is never called (no auto-calls). */
    fun openApiTool(spec: ToolSpec): OpenApiTool = object : OpenApiTool {
        override fun getToolDescriptionJsonString(): String = toolDescription(spec)
        override fun execute(paramsJsonString: String): String = throw IllegalStateException("Jarvis runs tools itself, after validation and approval")
    }

    fun toolDescription(spec: ToolSpec): String =
        JsonObject(mapOf("name" to JsonPrimitive(spec.name), "description" to JsonPrimitive(spec.description), "parameters" to spec.parameters)).toString()

    /** All turns as runtime messages; the last one is what gets sent (a user or tool message). */
    fun toMessages(turns: List<Turn>): List<Message> {
        val out = mutableListOf<Message>()
        var i = 0
        while (i < turns.size) {
            when (val t = turns[i]) {
                is Turn.User -> out += Message.user(t.text)
                is Turn.Assistant -> out += Message.model(
                    if (t.text.isBlank()) Contents.of(emptyList<Content>()) else Contents.of(t.text),
                    t.toolCalls.map { LmToolCall(it.name, toPlain(it.arguments) as Map<String, Any?>) },
                    emptyMap(),
                )
                is Turn.ToolResult -> {
                    val results = mutableListOf(t)
                    while (i + 1 < turns.size && turns[i + 1] is Turn.ToolResult) results += turns[++i] as Turn.ToolResult
                    out += Message.tool(Contents.of(results.map { Content.ToolResponse(it.name, toolResponse(it.content, it.isError)) }))
                }
            }
            i++
        }
        return out
    }

    /** A tool result as structured data when it's JSON (the model reads it better), else as text. */
    fun toolResponse(content: String, isError: Boolean): Any {
        val parsed = runCatching { Json.parseToJsonElement(content) }.getOrNull()
        val value: Any? = if (parsed is JsonObject || parsed is JsonArray) toPlain(parsed) else content.take(4000)
        return if (isError) mapOf("error" to (value ?: content)) else (if (value is Map<*, *>) value else mapOf("result" to value))
    }

    fun fromMessage(m: Message): ModelResponse {
        val text = m.contents.contents.filterIsInstance<Content.Text>().joinToString("") { it.text }
        val calls = m.toolCalls.mapIndexed { i, c -> ToolCall("lm_${System.nanoTime().toString(36)}_$i", c.name, normalizeArgs(c.arguments)) }
        return ModelResponse(clean(text), calls, if (calls.isEmpty()) "end_turn" else "tool_use")
    }

    /** Arguments from the runtime (Gson numbers are doubles) as JSON with whole numbers as integers. */
    fun normalizeArgs(args: Map<String, Any?>): JsonObject = JsonObject(args.mapValues { (_, v) -> toJson(v) })

    private fun toJson(v: Any?): JsonElement = when (v) {
        null -> JsonNull
        is JsonElement -> v
        is Boolean -> JsonPrimitive(v)
        is Number -> v.toDouble().let { d -> if (d % 1.0 == 0.0 && kotlin.math.abs(d) < 9.0e15) JsonPrimitive(d.toLong()) else JsonPrimitive(d) }
        is String -> JsonPrimitive(v)
        is Map<*, *> -> JsonObject(v.entries.associate { (k, x) -> k.toString() to toJson(x) })
        is Iterable<*> -> JsonArray(v.map { toJson(it) })
        is Array<*> -> JsonArray(v.map { toJson(it) })
        else -> JsonPrimitive(v.toString())
    }

    private fun toPlain(e: JsonElement): Any? = when (e) {
        is JsonNull -> null
        is JsonObject -> e.mapValues { toPlain(it.value) }
        is JsonArray -> e.map { toPlain(it) }
        is JsonPrimitive -> if (e.isString) e.content else e.booleanOrNull ?: e.longOrNull ?: e.doubleOrNull ?: e.content
    }

    /** Remove reasoning blocks and stray end-of-turn markers some templates leave behind. */
    fun clean(raw: String): String {
        var t = raw
        if (t.contains("</think>")) t = t.substringAfterLast("</think>")
        for (tok in listOf("<end_of_turn>", "<start_of_turn>model", "<eos>", "<|im_end|>", "<|endoftext|>")) t = t.replace(tok, "")
        return t.trim()
    }
}
