package ai.jarvis.mobile.runtime

import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** How much an action can change. READ never changes anything; ACT does something visible. */
enum class Risk { READ, ACT }

data class Availability(val available: Boolean, val reason: String = "") {
    companion object { val OK = Availability(true) }
}

data class ToolOutcome(val ok: Boolean, val content: String) {
    companion object {
        fun ok(content: String) = ToolOutcome(true, content)
        fun fail(content: String) = ToolOutcome(false, content)
    }
}

/**
 * One native phone capability. The model only ever sees name/description/parameters; execution
 * happens here, after the registry has validated the arguments and the PermissionManager has
 * authorized this exact call.
 */
interface MobileTool {
    val name: String
    val title: String
    val description: String
    val parameters: JsonObject
    val risk: Risk
    /** Android runtime permission needed (null = none). */
    val androidPermission: String? get() = null
    fun availability(context: Context): Availability = androidPermission?.let {
        if (ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED) Availability.OK else Availability(false, "Needs the ${it.substringAfterLast('.')} permission (grant it in Capabilities)")
    } ?: Availability.OK
    /** A one-line, human description of this exact call (shown on the approval card). */
    fun summarize(args: JsonObject): String
    suspend fun execute(context: Context, args: JsonObject): ToolOutcome
}

/** The phone's capability registry: what Mobile Jarvis can do on THIS device. */
class MobileToolRegistry(tools: List<MobileTool>) {
    private val byName = tools.associateBy { it.name }
    val all: List<MobileTool> = tools

    fun get(name: String): MobileTool? = byName[name]

    fun specs(context: Context): List<ToolSpec> = all.filter { it.availability(context).available }.map { ToolSpec(it.name, it.description, it.parameters) }

    /**
     * Validate a model's arguments against the tool's JSON schema (types, required, enums, ranges).
     * Returns an error message, or null when valid. Unknown arguments are rejected.
     */
    fun validate(tool: MobileTool, args: JsonObject): String? {
        val props = tool.parameters["properties"]?.jsonObject ?: JsonObject(emptyMap())
        val required = tool.parameters["required"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
        for (r in required) if (args[r] == null) return "Missing required argument \"$r\""
        for ((k, v) in args) {
            val p = props[k]?.jsonObject ?: return "Unknown argument \"$k\""
            val type = p["type"]?.jsonPrimitive?.content
            val prim = v as? JsonPrimitive
            when (type) {
                "string" -> {
                    if (prim == null || !prim.isString) return "\"$k\" must be a string"
                    p["maxLength"]?.jsonPrimitive?.content?.toIntOrNull()?.let { if (prim.content.length > it) return "\"$k\" is too long" }
                    p["enum"]?.jsonArray?.map { it.jsonPrimitive.content }?.let { if (prim.content !in it) return "\"$k\" must be one of $it" }
                    p["pattern"]?.jsonPrimitive?.content?.let { if (!Regex(it).containsMatchIn(prim.content)) return "\"$k\" isn't valid (${p["description"]?.jsonPrimitive?.content ?: "wrong format"})" }
                }
                "integer", "number" -> {
                    val d = prim?.takeIf { !it.isString }?.doubleOrNull ?: return "\"$k\" must be a number"
                    if (type == "integer" && d % 1.0 != 0.0) return "\"$k\" must be a whole number"
                    p["minimum"]?.jsonPrimitive?.doubleOrNull?.let { if (d < it) return "\"$k\" must be at least $it" }
                    p["maximum"]?.jsonPrimitive?.doubleOrNull?.let { if (d > it) return "\"$k\" must be at most $it" }
                }
                "boolean" -> if (prim?.booleanOrNull == null || prim.isString) return "\"$k\" must be true or false"
            }
        }
        return null
    }
}

fun schema(required: List<String>, vararg props: Pair<String, JsonObject>): JsonObject = JsonObject(
    mapOf(
        "type" to JsonPrimitive("object"),
        "properties" to JsonObject(props.toMap()),
        "required" to kotlinx.serialization.json.JsonArray(required.map { JsonPrimitive(it) }),
    ),
)

fun str(description: String, maxLength: Int = 2000, enum: List<String>? = null, pattern: String? = null) = JsonObject(
    buildMap {
        put("type", JsonPrimitive("string")); put("description", JsonPrimitive(description)); put("maxLength", JsonPrimitive(maxLength))
        pattern?.let { put("pattern", JsonPrimitive(it)) }
        enum?.let { put("enum", kotlinx.serialization.json.JsonArray(it.map { v -> JsonPrimitive(v) })) }
    },
)

fun int(description: String, min: Int, max: Int) = JsonObject(mapOf("type" to JsonPrimitive("integer"), "description" to JsonPrimitive(description), "minimum" to JsonPrimitive(min), "maximum" to JsonPrimitive(max)))
