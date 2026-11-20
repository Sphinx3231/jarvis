package ai.jarvis.mobile.runtime

import ai.jarvis.mobile.protocol.JarvisJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * The model behind Mobile Jarvis — replaceable. The runtime only ever sees this interface: the
 * model proposes text and tool calls; it never touches Android APIs (the ExecutionRouter validates,
 * authorizes and executes). Cloud providers today; an on-device engine can implement it later.
 */
interface ModelProvider {
    val id: String
    val displayName: String
    suspend fun complete(request: ModelRequest): ModelResponse
}

data class ToolSpec(val name: String, val description: String, val parameters: JsonObject)
data class ToolCall(val id: String, val name: String, val arguments: JsonObject)

sealed interface Turn {
    data class User(val text: String) : Turn
    data class Assistant(val text: String, val toolCalls: List<ToolCall> = emptyList()) : Turn
    data class ToolResult(val callId: String, val name: String, val content: String, val isError: Boolean) : Turn
}

data class ModelRequest(val system: String, val turns: List<Turn>, val tools: List<ToolSpec>, val maxTokens: Int = 1024)
data class ModelResponse(val text: String, val toolCalls: List<ToolCall>, val stopReason: String)

/** The provider could not be reached or refused the request (no key, offline, quota…). */
class ProviderUnavailable(message: String) : Exception(message)

private val JSON_TYPE = "application/json".toMediaType()

private suspend fun post(http: OkHttpClient, url: String, headers: Map<String, String>, body: JsonObject): JsonObject = withContext(Dispatchers.IO) {
    val req = Request.Builder().url(url).apply { headers.forEach { (k, v) -> header(k, v) } }.post(body.toString().toRequestBody(JSON_TYPE)).build()
    try {
        http.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) throw ProviderUnavailable("HTTP ${res.code}: ${text.take(300)}")
            JarvisJson.parseToJsonElement(text).jsonObject
        }
    } catch (e: ProviderUnavailable) {
        throw e
    } catch (e: Exception) {
        throw ProviderUnavailable(e.message ?: e.javaClass.simpleName)
    }
}

/** Any OpenAI-compatible Chat Completions API: OpenAI, OpenRouter, Groq, a LAN Ollama/OpenJarvis… */
class OpenAiCompatibleProvider(private val http: OkHttpClient, private val baseUrl: String, private val apiKey: String?, private val model: String) : ModelProvider {
    override val id = "openai_compatible"
    override val displayName = "$model (${baseUrl.removePrefix("https://").substringBefore('/')})"

    override suspend fun complete(request: ModelRequest): ModelResponse {
        val body = buildJsonObject {
            put("model", model)
            put("max_tokens", request.maxTokens)
            putJsonArray("messages") {
                addJsonObject { put("role", "system"); put("content", request.system) }
                for (t in request.turns) when (t) {
                    is Turn.User -> addJsonObject { put("role", "user"); put("content", t.text) }
                    is Turn.Assistant -> addJsonObject {
                        put("role", "assistant"); put("content", t.text)
                        if (t.toolCalls.isNotEmpty()) putJsonArray("tool_calls") {
                            for (c in t.toolCalls) addJsonObject {
                                put("id", c.id); put("type", "function")
                                putJsonObject("function") { put("name", c.name); put("arguments", c.arguments.toString()) }
                            }
                        }
                    }
                    is Turn.ToolResult -> addJsonObject { put("role", "tool"); put("tool_call_id", t.callId); put("content", t.content) }
                }
            }
            if (request.tools.isNotEmpty()) putJsonArray("tools") {
                for (s in request.tools) addJsonObject {
                    put("type", "function")
                    putJsonObject("function") { put("name", s.name); put("description", s.description); put("parameters", s.parameters) }
                }
            }
        }
        val headers = buildMap { apiKey?.takeIf { it.isNotBlank() }?.let { put("Authorization", "Bearer $it") } }
        val r = post(http, baseUrl.trimEnd('/') + "/chat/completions", headers, body)
        val choice = r["choices"]?.jsonArray?.firstOrNull()?.jsonObject ?: throw ProviderUnavailable("No answer from the model")
        val msg = choice["message"]?.jsonObject ?: JsonObject(emptyMap())
        val calls = msg["tool_calls"]?.jsonArray?.mapNotNull { c ->
            val f = c.jsonObject["function"]?.jsonObject ?: return@mapNotNull null
            val args = f["arguments"]?.let { a -> runCatching { if (a is JsonPrimitive) JarvisJson.parseToJsonElement(a.content).jsonObject else a.jsonObject }.getOrNull() } ?: JsonObject(emptyMap())
            ToolCall(c.jsonObject["id"]?.jsonPrimitive?.contentOrNull ?: "call_${c.hashCode()}", f["name"]!!.jsonPrimitive.content, args)
        }.orEmpty()
        val text = (msg["content"] as? JsonPrimitive)?.contentOrNull.orEmpty().replace(Regex("<think>[\\s\\S]*?</think>"), "").trim()
        return ModelResponse(text, calls, choice["finish_reason"]?.jsonPrimitive?.contentOrNull ?: "stop")
    }
}

/** Anthropic Messages API. */
class AnthropicProvider(private val http: OkHttpClient, private val apiKey: String, private val model: String, private val baseUrl: String = "https://api.anthropic.com") : ModelProvider {
    override val id = "anthropic"
    override val displayName = "$model (Anthropic)"

    override suspend fun complete(request: ModelRequest): ModelResponse {
        if (apiKey.isBlank()) throw ProviderUnavailable("No Anthropic API key set")
        val body = buildJsonObject {
            put("model", model)
            put("max_tokens", request.maxTokens)
            put("system", request.system)
            putJsonArray("messages") {
                for (t in request.turns) when (t) {
                    is Turn.User -> addJsonObject { put("role", "user"); put("content", t.text) }
                    is Turn.Assistant -> addJsonObject {
                        put("role", "assistant")
                        putJsonArray("content") {
                            if (t.text.isNotBlank()) addJsonObject { put("type", "text"); put("text", t.text) }
                            for (c in t.toolCalls) addJsonObject { put("type", "tool_use"); put("id", c.id); put("name", c.name); put("input", c.arguments) }
                        }
                    }
                    is Turn.ToolResult -> addJsonObject {
                        put("role", "user")
                        putJsonArray("content") { addJsonObject { put("type", "tool_result"); put("tool_use_id", t.callId); put("content", t.content); put("is_error", t.isError) } }
                    }
                }
            }
            if (request.tools.isNotEmpty()) putJsonArray("tools") {
                for (s in request.tools) addJsonObject { put("name", s.name); put("description", s.description); put("input_schema", s.parameters) }
            }
        }
        val r = post(http, baseUrl.trimEnd('/') + "/v1/messages", mapOf("x-api-key" to apiKey, "anthropic-version" to "2023-06-01"), body)
        val blocks = r["content"]?.jsonArray.orEmpty()
        val text = blocks.filter { it.jsonObject["type"]?.jsonPrimitive?.content == "text" }.joinToString("") { it.jsonObject["text"]!!.jsonPrimitive.content }
        val calls = blocks.filter { it.jsonObject["type"]?.jsonPrimitive?.content == "tool_use" }.map { b ->
            val o = b.jsonObject
            ToolCall(o["id"]!!.jsonPrimitive.content, o["name"]!!.jsonPrimitive.content, o["input"]?.jsonObject ?: JsonObject(emptyMap()))
        }
        return ModelResponse(text.trim(), calls, r["stop_reason"]?.jsonPrimitive?.contentOrNull ?: "end_turn")
    }
}

