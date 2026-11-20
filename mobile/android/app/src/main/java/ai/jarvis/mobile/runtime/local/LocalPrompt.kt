package ai.jarvis.mobile.runtime.local

import ai.jarvis.mobile.runtime.ModelResponse
import ai.jarvis.mobile.runtime.ToolCall
import ai.jarvis.mobile.runtime.ToolSpec
import ai.jarvis.mobile.runtime.Turn
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Prompt format and output parsing for the small on-device model (ChatML, Qwen2.5 family).
 *
 * A 1.5B model can't use native function calling, so tools are described in the system message and
 * the model answers with one line `CALL tool_name {json}`. The wording was tuned against the real
 * bundled model (see docs/MOBILE.md); every call it proposes is still validated and authorized by
 * the router like any other — a wrong or invented call never runs on its own.
 */
object LocalPrompt {
    private const val START = "<|im_start|>"
    private const val END = "<|im_end|>"

    fun build(system: String, turns: List<Turn>, tools: List<ToolSpec>): String {
        val sb = StringBuilder()
        sb.append(START).append("system\n").append(system.trim())
        if (tools.isNotEmpty()) sb.append("\n\n").append(toolBlock(tools))
        sb.append(END).append('\n')
        var i = 0
        while (i < turns.size) {
            when (val t = turns[i]) {
                is Turn.User -> sb.append(START).append("user\n").append(t.text.trim()).append(END).append('\n')
                is Turn.Assistant -> {
                    val call = t.toolCalls.firstOrNull()
                    val text = if (call != null) "CALL ${call.name} ${call.arguments}" else t.text.trim()
                    sb.append(START).append("assistant\n").append(text).append(END).append('\n')
                }
                is Turn.ToolResult -> {
                    // Consecutive tool results become one user message, phrased the way the model handles best.
                    val results = mutableListOf(t)
                    while (i + 1 < turns.size && turns[i + 1] is Turn.ToolResult) results += turns[++i] as Turn.ToolResult
                    sb.append(START).append("user\n")
                    results.forEach { r -> sb.append("[Tool result for ${r.name}${if (r.isError) " (not done)" else ""}: ${r.content.take(1500)}]\n") }
                    sb.append("Answer my question using this result.").append(END).append('\n')
                }
            }
            i++
        }
        sb.append(START).append("assistant\n")
        return sb.toString()
    }

    fun toolBlock(tools: List<ToolSpec>): String = buildString {
        append("Phone tools you can use:\n")
        tools.forEach { append("- ").append(it.name).append('(').append(signature(it.parameters)).append("): ").append(firstSentence(it.description)).append('\n') }
        append("\nTo use a tool, reply with only the call on one line, for example:\nCALL set_timer {\"seconds\": 60}\n")
        append("Rules: use a tool only when the user asks for an action or for phone information; otherwise answer normally in plain text. ")
        append("Use only the tools listed. If none fits, say you can't do that on the phone yet. Never invent phone numbers, links or details the user didn't give. ")
        append("Never say you did something unless a tool result says so.")
    }

    private fun signature(schema: JsonObject): String {
        val props = schema["properties"]?.jsonObject?.keys ?: return ""
        val required = (schema["required"] as? JsonArray)?.map { it.jsonPrimitive.content }?.toSet() ?: emptySet()
        return props.joinToString(", ") { if (it in required) it else "$it?" }
    }

    private fun firstSentence(s: String): String = s.trim().let { t -> Regex("^(.+?[.!?])(\\s|$)").find(t)?.groupValues?.get(1) ?: t }

    private val callRe = Regex("""\bCALL\s+([A-Za-z_][A-Za-z0-9_]*)""")
    private val lenient = Json { isLenient = true; ignoreUnknownKeys = true }

    /** Turn raw model output into a tool call or a plain reply. */
    fun parse(raw: String): ModelResponse {
        val text = clean(raw)
        val m = callRe.find(text) ?: return ModelResponse(text, emptyList(), "end_turn")
        val args = balancedJson(text, m.range.last + 1)?.let { runCatching { lenient.parseToJsonElement(it).jsonObject }.getOrNull() }
        val call = ToolCall("local_${System.nanoTime().toString(36)}", m.groupValues[1], args ?: JsonObject(emptyMap()))
        return ModelResponse(text.substring(0, m.range.first).trim(), listOf(call), "tool_use")
    }

    /** The first balanced {...} at or after [from] (respecting strings), or null. */
    private fun balancedJson(s: String, from: Int): String? {
        val start = s.indexOf('{', from).takeIf { it >= 0 && s.substring(from, it).isBlank() } ?: return null
        var depth = 0
        var inStr = false
        var esc = false
        for (i in start until s.length) {
            val c = s[i]
            if (inStr) { if (esc) esc = false else if (c == '\\') esc = true else if (c == '"') inStr = false; continue }
            when (c) {
                '"' -> inStr = true
                '{' -> depth++
                '}' -> if (--depth == 0) return s.substring(start, i + 1)
            }
        }
        return null
    }

    /** Remove reasoning blocks, end tokens and byte-level tokenizer leftovers. */
    fun clean(raw: String): String {
        var t = raw
        if (t.contains("</think>")) t = t.substringAfterLast("</think>")
        t = t.replace(Regex("<think>[\\s\\S]*$"), "")
        for (tok in listOf(END, "<|endoftext|>", START, "<｜end▁of▁sentence｜>")) t = t.replace(tok, "")
        return decodeByteLevel(t).trim()
    }

    // GPT-2 style byte-level BPE alphabet: occasionally a detokenizer leaves e.g. "ĠðŁİ¥" for " 🎥".
    private val byteOf: Map<Char, Int> by lazy {
        val bs = ((33..126) + (161..172) + (174..255)).toMutableList()
        val cs = bs.toMutableList()
        var n = 0
        for (b in 0..255) if (b !in bs) { bs += b; cs += 256 + n; n++ }
        bs.indices.associate { cs[it].toChar() to bs[it] }
    }

    private fun decodeByteLevel(s: String): String {
        if (s.none { it.code in 0x100..0x143 }) return s
        return Regex("[\\u00A1-\\u0143]+").replace(s) { m ->
            val run = m.value
            if (run.none { it.code in 0x100..0x143 }) return@replace run
            val bytes = run.map { byteOf[it] ?: return@replace run }.map { it.toByte() }.toByteArray()
            val decoded = runCatching { Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString() }.getOrNull()
            decoded ?: run
        }
    }
}
