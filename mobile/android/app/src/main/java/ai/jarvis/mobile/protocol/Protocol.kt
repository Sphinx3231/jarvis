package ai.jarvis.mobile.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Jarvis Mobile protocol v1 — Kotlin mirror of shared/protocol/protocol.ts (the source of truth).
 * Contract tests decode every fixture in shared/protocol/fixtures/envelopes.json with these
 * classes, so the two definitions cannot drift silently.
 */
object Protocol {
    const val VERSION = 1
    const val MAX_FRAME_BYTES = 256 * 1024
    const val MAX_CLOCK_SKEW_MS = 5 * 60_000L

    /** Messages that change something on the PC carry an idempotency key. */
    val IDEMPOTENT_TYPES = setOf("jarvis.command.submit", "voice.transcript", "task.cancel", "approval.resolve", "agent.run", "system.emergency_stop")
}

val JarvisJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
}

class ProtocolException(val code: String, message: String) : Exception(message)

/** A decoded Jarvis envelope. `payload` stays raw until the receiver knows its type. */
data class Envelope(
    val v: Int,
    val id: String,
    val sessionId: String,
    val from: String,
    val to: String,
    val ts: Long,
    val type: String,
    val payload: JsonElement,
    val correlationId: String? = null,
    val idempotencyKey: String? = null,
) {
    inline fun <reified T> payloadAs(): T = JarvisJson.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), payload)

    fun toJson(): String = buildJsonObject {
        put("v", v)
        put("id", id)
        put("sessionId", sessionId)
        put("from", from)
        put("to", to)
        put("ts", ts)
        put("type", type)
        // optional fields are omitted (never null), as the TypeScript schema requires
        correlationId?.let { put("correlationId", it) }
        idempotencyKey?.let { put("idempotencyKey", it) }
        put("payload", payload)
    }.toString()

    companion object {
        private val ID = Regex("^[A-Za-z0-9_.:-]{8,128}$")
        private val DEVICE = Regex("^[a-f0-9]{64}$")

        fun <T> of(type: String, serializer: KSerializer<T>, payload: T, id: String, sessionId: String, from: String, to: String, ts: Long = System.currentTimeMillis(), correlationId: String? = null, idempotencyKey: String? = null) =
            Envelope(Protocol.VERSION, id, sessionId, from, to, ts, type, JarvisJson.encodeToJsonElement(serializer, payload), correlationId, idempotencyKey)

        /** Validate version, shape, size and freshness (same rules as parseEnvelope in TypeScript). */
        fun parse(json: String, now: Long = System.currentTimeMillis(), checkFreshness: Boolean = true): Envelope {
            if (json.length > Protocol.MAX_FRAME_BYTES) throw ProtocolException("too_large", "Envelope too large")
            val o = try {
                JarvisJson.parseToJsonElement(json).jsonObject
            } catch (e: Exception) {
                throw ProtocolException("bad_json", "Envelope is not JSON")
            }
            fun str(k: String) = o[k]?.jsonPrimitive?.contentOrNull
            val v = o["v"]?.jsonPrimitive?.longOrNull?.toInt() ?: throw ProtocolException("bad_envelope", "missing v")
            if (v != Protocol.VERSION) throw ProtocolException("version", "Unsupported protocol version $v")
            val env = Envelope(
                v = v,
                id = str("id")?.takeIf { ID.matches(it) } ?: throw ProtocolException("bad_envelope", "bad id"),
                sessionId = str("sessionId")?.takeIf { it.length in 8..128 } ?: throw ProtocolException("bad_envelope", "bad sessionId"),
                from = str("from")?.takeIf { DEVICE.matches(it) } ?: throw ProtocolException("bad_envelope", "bad from"),
                to = str("to")?.takeIf { DEVICE.matches(it) } ?: throw ProtocolException("bad_envelope", "bad to"),
                ts = o["ts"]?.jsonPrimitive?.longOrNull ?: throw ProtocolException("bad_envelope", "bad ts"),
                type = str("type")?.takeIf { it in Messages.ALL } ?: throw ProtocolException("bad_envelope", "unknown type ${str("type")}"),
                payload = o["payload"] ?: throw ProtocolException("bad_envelope", "missing payload"),
                correlationId = str("correlationId"),
                idempotencyKey = str("idempotencyKey"),
            )
            if (checkFreshness && kotlin.math.abs(now - env.ts) > Protocol.MAX_CLOCK_SKEW_MS) throw ProtocolException("stale", "Envelope timestamp outside the replay window")
            if (env.type in Protocol.IDEMPOTENT_TYPES && env.idempotencyKey == null) throw ProtocolException("no_idempotency_key", "${env.type} needs an idempotency key")
            Messages.validate(env)
            return env
        }
    }
}

/** Relay frames (layer 1): routing and authentication, plain JSON. */
object Frames {
    fun hello(role: String, deviceId: String, pubSign: String) = buildJsonObject {
        put("t", "hello"); put("v", Protocol.VERSION); put("role", role); put("deviceId", deviceId); put("pubSign", pubSign)
    }.toString()
    fun auth(sig: String) = buildJsonObject { put("t", "auth"); put("sig", sig) }.toString()
    fun pairMsg(room: String, data: String) = buildJsonObject { put("t", "pair.msg"); put("room", room); put("data", data) }.toString()
    fun msg(to: String, data: String) = buildJsonObject { put("t", "msg"); put("to", to); put("data", data) }.toString()
    fun ping(ts: Long) = buildJsonObject { put("t", "ping"); put("ts", ts) }.toString()

    fun parse(json: String): JsonObject {
        if (json.length > Protocol.MAX_FRAME_BYTES) throw ProtocolException("too_large", "Frame too large")
        return try {
            JarvisJson.parseToJsonElement(json).jsonObject
        } catch (e: Exception) {
            throw ProtocolException("bad_frame", "Frame is not JSON")
        }
    }
}

fun JsonObject.str(k: String): String? = this[k]?.jsonPrimitive?.contentOrNull

// ---------------------------------------------------------------- payloads

@Serializable data class PairRequest(val deviceName: String, val platform: String = "android", val appVersion: String, val pubSign: String, val pubAgree: String)
@Serializable data class PairConfirm(val pcDeviceId: String, val pcName: String, val pubSign: String, val pubAgree: String, val scopes: List<String>, val jarvisVersion: String)
@Serializable data class PairReject(val reason: String)
@Serializable data class DeviceStatus(val online: Boolean, val name: String, val jarvisVersion: String, val brain: String? = null, val scopes: List<String>)
@Serializable data class DeviceRevoke(val reason: String)
@Serializable class Empty
@Serializable data class AgentStatus(val id: String, val name: String, val color: String, val role: String, val state: String, val lastRunAt: Long? = null, val lastSummary: String, val runs: Int, val error: String? = null)
@Serializable data class TaskSummary(val id: String, val title: String, val status: String, val progress: Double, val createdAt: Long, val updatedAt: Long, val error: String? = null, val result: String? = null)
@Serializable data class ApprovalSummary(val id: String, val taskId: String, val taskTitle: String, val summary: String, val reason: String? = null, val scope: String, val createdAt: Long)
@Serializable data class PcSnapshot(val agents: List<AgentStatus>, val agentsEnabled: Boolean, val tasks: List<TaskSummary>, val approvals: List<ApprovalSummary>, val assistantState: String, val assistantDetail: String)
@Serializable data class CommandSubmit(val text: String, val conversationId: String? = null, val via: String = "text")
@Serializable data class CommandAccepted(val conversationId: String? = null)
@Serializable data class CommandRejected(val code: String, val reason: String)
@Serializable data class ResponseDelta(val text: String)
@Serializable data class ResponseAction(val type: String, val title: String? = null, val taskId: String? = null, val needsApproval: Boolean? = null)
@Serializable data class ResponseComplete(val conversationId: String, val text: String, val handledBy: String, val actions: List<ResponseAction>, val error: String? = null)
@Serializable data class AgentStatusChanged(val agents: List<AgentStatus>, val agentsEnabled: Boolean)
@Serializable data class AgentRun(val agentId: String)
@Serializable data class TaskEvent(val task: TaskSummary)
@Serializable data class TaskCancel(val taskId: String)
@Serializable data class ApprovalRequested(val approval: ApprovalSummary)
@Serializable data class ApprovalResolve(val approvalId: String, val decision: String)
@Serializable data class ApprovalResolved(val approvalId: String, val status: String)
@Serializable data class VoiceSessionStarted(val via: String = "phone_stt")
@Serializable data class VoiceTranscript(val text: String, val conversationId: String? = null, val final: Boolean)
@Serializable data class EmergencyStop(val reason: String)
@Serializable data class SystemStopped(val cancelledTasks: Int, val computerAccessStopped: Boolean)
@Serializable data class Heartbeat(val seq: Int)
@Serializable data class ErrorPayload(val code: String, val message: String)

/** Every message type and the payload class it carries. */
object Messages {
    val PAYLOADS: Map<String, KSerializer<*>> = mapOf(
        "device.pair.request" to PairRequest.serializer(),
        "device.pair.confirm" to PairConfirm.serializer(),
        "device.pair.reject" to PairReject.serializer(),
        "device.status" to DeviceStatus.serializer(),
        "device.revoke" to DeviceRevoke.serializer(),
        "pc.snapshot.request" to Empty.serializer(),
        "pc.snapshot" to PcSnapshot.serializer(),
        "jarvis.command.submit" to CommandSubmit.serializer(),
        "jarvis.command.accepted" to CommandAccepted.serializer(),
        "jarvis.command.rejected" to CommandRejected.serializer(),
        "jarvis.response.delta" to ResponseDelta.serializer(),
        "jarvis.response.complete" to ResponseComplete.serializer(),
        "agent.status.changed" to AgentStatusChanged.serializer(),
        "agent.run" to AgentRun.serializer(),
        "task.created" to TaskEvent.serializer(),
        "task.progress" to TaskEvent.serializer(),
        "task.completed" to TaskEvent.serializer(),
        "task.failed" to TaskEvent.serializer(),
        "task.cancel" to TaskCancel.serializer(),
        "approval.requested" to ApprovalRequested.serializer(),
        "approval.resolve" to ApprovalResolve.serializer(),
        "approval.resolved" to ApprovalResolved.serializer(),
        "voice.session.started" to VoiceSessionStarted.serializer(),
        "voice.transcript" to VoiceTranscript.serializer(),
        "system.emergency_stop" to EmergencyStop.serializer(),
        "system.stopped" to SystemStopped.serializer(),
        "connection.heartbeat" to Heartbeat.serializer(),
        "error" to ErrorPayload.serializer(),
    )
    val ALL = PAYLOADS.keys

    /** Decode the payload with its declared class: rejects a payload of the wrong shape. */
    fun validate(env: Envelope) {
        val s = PAYLOADS[env.type] ?: throw ProtocolException("bad_envelope", "unknown type ${env.type}")
        try {
            JarvisJson.decodeFromJsonElement(s, env.payload)
        } catch (e: Exception) {
            throw ProtocolException("bad_payload", "${env.type}: ${e.message?.take(200)}")
        }
    }
}

/** The six Jarvis agents and what each can genuinely do on the phone (mirror of AGENT_CATALOG). */
object AgentCatalog {
    data class Agent(val id: String, val name: String, val color: Long, val pc: List<String>, val mobile: List<String>)

    val ALL = listOf(
        Agent("friday", "Friday", 0xFFEF4444, listOf("pipeline.earnings", "profit.report"), emptyList()),
        Agent("tom", "Tom", 0xFF22D3EE, listOf("pipeline.discover_programs"), emptyList()),
        Agent("neo", "Neo", 0xFF15803D, listOf("tasks.watch", "keys.audit"), listOf("mobile.tasks.watch")),
        Agent("sentinel", "Sentinel", 0xFFF59E0B, listOf("scope.authorized_programs"), listOf("mobile.permissions.audit")),
        Agent("echo", "Echo", 0xFFA855F7, listOf("team.digest"), listOf("mobile.activity.digest")),
        Agent("trinity", "Trinity", 0xFFF43F5E, listOf("security.operator", "security.plan"), emptyList()),
    )
    fun byId(id: String) = ALL.firstOrNull { it.id == id }
}
