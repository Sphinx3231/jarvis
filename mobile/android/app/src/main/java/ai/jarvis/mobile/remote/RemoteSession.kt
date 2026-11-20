package ai.jarvis.mobile.remote

import ai.jarvis.mobile.crypto.DeviceIdentity
import ai.jarvis.mobile.crypto.E2E
import ai.jarvis.mobile.protocol.AgentRun
import ai.jarvis.mobile.protocol.AgentStatus
import ai.jarvis.mobile.protocol.AgentStatusChanged
import ai.jarvis.mobile.protocol.ApprovalRequested
import ai.jarvis.mobile.protocol.ApprovalResolve
import ai.jarvis.mobile.protocol.ApprovalResolved
import ai.jarvis.mobile.protocol.ApprovalSummary
import ai.jarvis.mobile.protocol.CommandAccepted
import ai.jarvis.mobile.protocol.CommandRejected
import ai.jarvis.mobile.protocol.CommandSubmit
import ai.jarvis.mobile.protocol.DeviceRevoke
import ai.jarvis.mobile.protocol.DeviceStatus
import ai.jarvis.mobile.protocol.EmergencyStop
import ai.jarvis.mobile.protocol.Empty
import ai.jarvis.mobile.protocol.Envelope
import ai.jarvis.mobile.protocol.ErrorPayload
import ai.jarvis.mobile.protocol.Frames
import ai.jarvis.mobile.protocol.Heartbeat
import ai.jarvis.mobile.protocol.JarvisJson
import ai.jarvis.mobile.protocol.Messages
import ai.jarvis.mobile.protocol.PairConfirm
import ai.jarvis.mobile.protocol.PairReject
import ai.jarvis.mobile.protocol.PairRequest
import ai.jarvis.mobile.protocol.PcSnapshot
import ai.jarvis.mobile.protocol.ResponseAction
import ai.jarvis.mobile.protocol.ResponseComplete
import ai.jarvis.mobile.protocol.SystemStopped
import ai.jarvis.mobile.protocol.TaskCancel
import ai.jarvis.mobile.protocol.TaskEvent
import ai.jarvis.mobile.protocol.TaskSummary
import ai.jarvis.mobile.protocol.VoiceSessionStarted
import ai.jarvis.mobile.protocol.VoiceTranscript
import ai.jarvis.mobile.protocol.str
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonElement
import java.net.URI
import java.net.URLDecoder
import java.util.concurrent.ConcurrentHashMap

@Serializable
data class PairedPc(val relayUrl: String, val pcId: String, val pcName: String, val pubSign: String, val pubAgree: String, val scopes: List<String>, val pairedAt: Long)

/** Where the paired PC is remembered (DataStore in the app, memory in tests). Public keys only. */
interface PairingStore {
    suspend fun load(): PairedPc?
    suspend fun save(pc: PairedPc?)
}

data class PairingUri(val relay: String, val room: String, val secret: String, val pcId: String, val name: String) {
    companion object {
        /** Parse the jarvis://pair?... link the PC shows as a QR code. */
        fun parse(uri: String): PairingUri {
            val u = URI(uri.trim())
            require(u.scheme == "jarvis" && u.host == "pair") { "Not a Jarvis pairing code" }
            val q = (u.rawQuery ?: "").split('&').filter { it.contains('=') }.associate {
                val (k, v) = it.split('=', limit = 2)
                k to URLDecoder.decode(v, "UTF-8")
            }
            require(q["v"] == "1") { "This pairing code is for a different Jarvis version" }
            val p = PairingUri(q["relay"] ?: "", q["room"] ?: "", q["secret"] ?: "", q["pc"] ?: "", q["name"] ?: "PC Jarvis")
            require(p.relay.isNotBlank() && p.room.length >= 16 && p.secret.isNotBlank() && Regex("^[a-f0-9]{64}$").matches(p.pcId)) { "Incomplete pairing code" }
            relayUrlProblem(p.relay)?.let { throw IllegalArgumentException(it) }
            return p
        }
    }
}

/**
 * Remote PC mode: the phone as a remote for PC Jarvis. The PC does all the work; this keeps a live,
 * end-to-end-encrypted view of it (agents, tasks, approvals, replies) and sends commands with
 * idempotency keys from an outbox, so a reconnect re-sends without ever running a command twice.
 * A command shows ACCEPTED when the PC takes it and COMPLETED only when its reply arrives.
 */
class RemoteSession(
    private val identity: DeviceIdentity,
    private val relay: RelayConnection,
    private val store: PairingStore,
    private val scope: CoroutineScope,
    private val appVersion: String = "0.1.0",
    private val deviceName: String = "Android",
) {
    enum class ItemStatus { SENDING, WAITING_FOR_PC, ACCEPTED, COMPLETED, REJECTED, FAILED }
    data class ChatItem(val id: String, val role: String, val text: String, val status: ItemStatus, val ts: Long, val via: String = "text", val actions: List<ResponseAction> = emptyList(), val idempotencyKey: String? = null)
    data class State(
        val relay: RelayConnection.Status = RelayConnection.Status(RelayConnection.State.IDLE, "Not connected"),
        val paired: PairedPc? = null,
        val pcOnline: Boolean = false,
        val pcStatus: DeviceStatus? = null,
        val agents: List<AgentStatus> = emptyList(),
        val agentsEnabled: Boolean = false,
        val tasks: List<TaskSummary> = emptyList(),
        val approvals: List<ApprovalSummary> = emptyList(),
        val assistantState: String = "idle",
        val assistantDetail: String = "",
        val chat: List<ChatItem> = emptyList(),
        val conversationId: String? = null,
        val lastError: String? = null,
        val revokedReason: String? = null,
        val lastStop: SystemStopped? = null,
        /** Replies for commands already completed (a re-delivery answered from the PC's ledger), not shown twice. */
        val duplicatesAnswered: Int = 0,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state
    private val sessionId = E2E.randomId("ses_", 6)
    private val seen = ConcurrentHashMap<String, Long>()
    /** Outbox: idempotency key → the command, re-sent on reconnect until the PC answers. */
    private data class Pending(val type: String, val payload: JsonElement, val itemId: String?, var lastMsgId: String? = null)
    private val outbox = java.util.LinkedHashMap<String, Pending>()
    private val byMsgId = ConcurrentHashMap<String, String>() // message id → idempotency key
    private var pairing: Pair<PairingUri, CompletableDeferred<Result<PairedPc>>>? = null

    init {
        scope.launch { relay.status.collect { s -> _state.update { it.copy(relay = s, pcOnline = if (s.state == RelayConnection.State.CONNECTED) it.pcOnline else false) } } }
        scope.launch { relay.frames.collect { onFrame(it) } }
        scope.launch {
            store.load()?.let { pc ->
                _state.update { it.copy(paired = pc) }
                relay.start(pc.relayUrl)
            }
        }
    }

    // ---------------------------------------------------------------- pairing

    /** Pair with the PC from its QR code: E2E-encrypted with the QR secret, PC identity pinned. */
    suspend fun pair(uriText: String, timeoutMs: Long = 20_000): Result<PairedPc> = runCatching {
        val uri = PairingUri.parse(uriText)
        relay.start(uri.relay)
        withTimeout(timeoutMs) { relay.status.first { it.state == RelayConnection.State.CONNECTED } }
        val done = CompletableDeferred<Result<PairedPc>>()
        pairing = uri to done
        val env = Envelope.of("device.pair.request", PairRequest.serializer(), PairRequest(deviceName, "android", appVersion, identity.signPubB64, identity.agreePubB64), E2E.randomId("ph_"), sessionId, identity.deviceId, uri.pcId)
        val key = E2E.pairingKey(uri.secret, uri.room)
        check(relay.send(Frames.pairMsg(uri.room, E2E.seal(key, env.toJson(), E2E.pairAad(uri.room, identity.deviceId))))) { "Not connected to the relay" }
        withTimeout(timeoutMs) { done.await() }.getOrThrow()
    }.also { pairing = null }

    private suspend fun onPairFrame(f: JsonObject) {
        val (uri, done) = pairing ?: return
        if (f.str("room") != uri.room || f.str("from") != uri.pcId) return
        val env = try {
            Envelope.parse(E2E.open(E2E.pairingKey(uri.secret, uri.room), f.str("data") ?: "", E2E.pairAad(uri.room, uri.pcId)))
        } catch (e: Exception) {
            done.complete(Result.failure(IllegalStateException("The PC's reply could not be verified")))
            return
        }
        when (env.type) {
            "device.pair.confirm" -> {
                val c = env.payloadAs<PairConfirm>()
                // Pin the PC: the key it sent must hash to the id in the QR code.
                if (E2E.deviceIdOf(c.pubSign) != uri.pcId || c.pcDeviceId != uri.pcId) {
                    done.complete(Result.failure(SecurityException("PC identity does not match the QR code")))
                    return
                }
                val pc = PairedPc(uri.relay, c.pcDeviceId, c.pcName, c.pubSign, c.pubAgree, c.scopes, System.currentTimeMillis())
                store.save(pc)
                _state.update { it.copy(paired = pc, revokedReason = null, lastError = null) }
                done.complete(Result.success(pc))
            }
            "device.pair.reject" -> done.complete(Result.failure(SecurityException(env.payloadAs<PairReject>().reason)))
        }
    }

    suspend fun unpair() {
        store.save(null)
        relay.stop()
        synchronized(outbox) { outbox.clear() }
        _state.value = State()
    }

    // ---------------------------------------------------------------- sending

    private fun <T> envelope(type: String, s: KSerializer<T>, payload: T, pc: PairedPc, idem: String? = null) =
        Envelope.of(type, s, payload, E2E.randomId("ph_"), sessionId, identity.deviceId, pc.pcId, idempotencyKey = idem)

    private fun seal(pc: PairedPc, env: Envelope): String {
        val key = E2E.messageKey(identity.agree(pc.pubAgree), identity.deviceId, pc.pcId)
        return Frames.msg(pc.pcId, E2E.seal(key, env.toJson(), E2E.msgAad(identity.deviceId, pc.pcId)))
    }

    private fun <T> sendNow(type: String, s: KSerializer<T>, payload: T): Boolean {
        val pc = _state.value.paired ?: return false
        return relay.send(seal(pc, envelope(type, s, payload, pc)))
    }

    /** Queue a command; it is sent now if possible and re-sent (same idempotency key) after reconnects. */
    private fun <T> enqueue(type: String, s: KSerializer<T>, payload: T, itemId: String?): String {
        val idem = E2E.randomId("idem_", 9)
        synchronized(outbox) { outbox[idem] = Pending(type, JarvisJson.encodeToJsonElement(s, payload), itemId) }
        flush()
        return idem
    }

    private fun flush() {
        val pc = _state.value.paired ?: return
        if (!_state.value.pcOnline) return
        val items = synchronized(outbox) { outbox.entries.toList() }
        for ((idem, p) in items) {
            val env = Envelope(1, E2E.randomId("ph_"), sessionId, identity.deviceId, pc.pcId, System.currentTimeMillis(), p.type, p.payload, null, idem)
            if (relay.send(seal(pc, env))) {
                p.lastMsgId?.let { byMsgId.remove(it) }
                p.lastMsgId = env.id
                byMsgId[env.id] = idem
                p.itemId?.let { id -> setItem(id) { if (it.status == ItemStatus.SENDING || it.status == ItemStatus.WAITING_FOR_PC) it.copy(status = ItemStatus.SENDING) else it } }
            }
        }
    }

    fun submit(text: String, via: String = "text"): String {
        val itemId = E2E.randomId("item_", 6)
        val online = _state.value.pcOnline
        _state.update { it.copy(chat = it.chat + ChatItem(itemId, "user", text, if (online) ItemStatus.SENDING else ItemStatus.WAITING_FOR_PC, System.currentTimeMillis(), via)) }
        val conv = _state.value.conversationId
        val idem = if (via == "voice") {
            sendNow("voice.session.started", VoiceSessionStarted.serializer(), VoiceSessionStarted())
            enqueue("voice.transcript", VoiceTranscript.serializer(), VoiceTranscript(text, conv, true), itemId)
        } else enqueue("jarvis.command.submit", CommandSubmit.serializer(), CommandSubmit(text, conv, "text"), itemId)
        setItem(itemId) { it.copy(idempotencyKey = idem) }
        return itemId
    }

    /** Re-send a command exactly as a reconnecting phone would (same idempotency key). For tests and manual retry. */
    fun redeliver(itemId: String) {
        val item = _state.value.chat.firstOrNull { it.id == itemId } ?: return
        val idem = item.idempotencyKey ?: return
        val conv = _state.value.conversationId
        synchronized(outbox) {
            outbox[idem] = if (item.via == "voice") Pending("voice.transcript", JarvisJson.encodeToJsonElement(VoiceTranscript.serializer(), VoiceTranscript(item.text, conv, true)), null)
            else Pending("jarvis.command.submit", JarvisJson.encodeToJsonElement(CommandSubmit.serializer(), CommandSubmit(item.text, conv, "text")), null)
        }
        flush()
    }

    fun cancelTask(taskId: String) { enqueue("task.cancel", TaskCancel.serializer(), TaskCancel(taskId), null) }
    fun resolveApproval(approvalId: String, approve: Boolean) { enqueue("approval.resolve", ApprovalResolve.serializer(), ApprovalResolve(approvalId, if (approve) "approve" else "deny"), null) }
    fun runAgent(agentId: String) { enqueue("agent.run", AgentRun.serializer(), AgentRun(agentId), null) }
    fun emergencyStop(reason: String = "STOP pressed on the phone") { enqueue("system.emergency_stop", EmergencyStop.serializer(), EmergencyStop(reason), null) }
    fun refresh() { sendNow("pc.snapshot.request", Empty.serializer(), Empty()) }
    fun newConversation() = _state.update { it.copy(conversationId = null, chat = emptyList()) }
    fun heartbeat(seq: Int) = sendNow("connection.heartbeat", Heartbeat.serializer(), Heartbeat(seq))

    private fun setItem(id: String, f: (ChatItem) -> ChatItem) = _state.update { s -> s.copy(chat = s.chat.map { if (it.id == id) f(it) else it }) }

    // ---------------------------------------------------------------- receiving

    private suspend fun onFrame(f: JsonObject) {
        val pc = _state.value.paired
        when (f.str("t")) {
            "pair.msg" -> onPairFrame(f)
            "ready" -> if (pc != null) refresh()
            "presence" -> if (pc != null && f.str("deviceId") == pc.pcId) {
                val online = f["online"].toString() == "true"
                _state.update { it.copy(pcOnline = online, lastError = if (online) null else it.lastError) }
                if (online) { refresh(); flush() }
            }
            "error" -> {
                val code = f.str("code")
                val msg = f.str("message") ?: code ?: "error"
                if (code == "peer_offline") _state.update { it.copy(pcOnline = false) }
                _state.update { it.copy(lastError = msg) }
                pairing?.second?.let { if (code == "room_unknown" || code == "peer_offline" || code == "rate_limited") it.complete(Result.failure(IllegalStateException(msg))) }
            }
            "msg" -> if (pc != null && f.str("from") == pc.pcId) onEnvelope(pc, f.str("data") ?: return)
        }
    }

    private fun onEnvelope(pc: PairedPc, data: String) {
        val env = try {
            val key = E2E.messageKey(identity.agree(pc.pubAgree), pc.pcId, identity.deviceId)
            Envelope.parse(E2E.open(key, data, E2E.msgAad(pc.pcId, identity.deviceId)))
        } catch (e: Exception) {
            _state.update { it.copy(lastError = "Rejected a message that failed verification (${e.message})") }
            return
        }
        if (env.from != pc.pcId || env.to != identity.deviceId) return
        val now = System.currentTimeMillis()
        seen.entries.removeIf { now - it.value > 11 * 60_000 }
        if (seen.putIfAbsent(env.id, now) != null) return // replayed
        val idem = env.correlationId?.let { byMsgId[it] }
        val pending = idem?.let { synchronized(outbox) { outbox[it] } }
        val itemId = pending?.itemId
        fun done() { if (idem != null) synchronized(outbox) { outbox.remove(idem) } }
        when (env.type) {
            "device.status" -> _state.update { it.copy(pcStatus = env.payloadAs<DeviceStatus>(), paired = it.paired?.copy(scopes = env.payloadAs<DeviceStatus>().scopes)) }
            "pc.snapshot" -> env.payloadAs<PcSnapshot>().let { s -> _state.update { it.copy(agents = s.agents, agentsEnabled = s.agentsEnabled, tasks = s.tasks, approvals = s.approvals, assistantState = s.assistantState, assistantDetail = s.assistantDetail) } }
            "jarvis.command.accepted" -> {
                itemId?.let { id -> setItem(id) { it.copy(status = ItemStatus.ACCEPTED) } }
                env.payloadAs<CommandAccepted>().conversationId?.let { c -> _state.update { it.copy(conversationId = c) } }
            }
            "jarvis.command.rejected" -> {
                val r = env.payloadAs<CommandRejected>()
                itemId?.let { id -> setItem(id) { it.copy(status = ItemStatus.REJECTED) } }
                _state.update { it.copy(chat = it.chat + ChatItem(E2E.randomId("item_", 6), "system", "The PC refused this: ${r.reason}", ItemStatus.REJECTED, now)) }
                done()
            }
            "jarvis.response.complete" -> {
                val r = env.payloadAs<ResponseComplete>()
                itemId?.let { id -> setItem(id) { it.copy(status = if (r.error != null) ItemStatus.FAILED else ItemStatus.COMPLETED) } }
                if (idem != null && _state.value.chat.any { it.role == "assistant" && it.idempotencyKey == idem }) {
                    _state.update { it.copy(duplicatesAnswered = it.duplicatesAnswered + 1) }
                } else {
                    _state.update { it.copy(conversationId = r.conversationId, chat = it.chat + ChatItem(E2E.randomId("item_", 6), "assistant", r.text, if (r.error != null) ItemStatus.FAILED else ItemStatus.COMPLETED, now, actions = r.actions, idempotencyKey = idem)) }
                }
                done()
            }
            "agent.status.changed" -> { env.payloadAs<AgentStatusChanged>().let { a -> _state.update { it.copy(agents = a.agents, agentsEnabled = a.agentsEnabled) } }; done() }
            "task.created", "task.progress", "task.completed", "task.failed" -> {
                val t = env.payloadAs<TaskEvent>().task
                _state.update { s -> s.copy(tasks = (listOf(t) + s.tasks.filter { it.id != t.id }).sortedByDescending { it.updatedAt }.take(100)) }
                done()
            }
            "approval.requested" -> env.payloadAs<ApprovalRequested>().approval.let { a -> _state.update { s -> s.copy(approvals = s.approvals.filter { it.id != a.id } + a) } }
            "approval.resolved" -> { env.payloadAs<ApprovalResolved>().let { r -> _state.update { s -> s.copy(approvals = s.approvals.filter { it.id != r.approvalId }) } }; done() }
            "system.stopped" -> { _state.update { it.copy(lastStop = env.payloadAs<SystemStopped>()) }; done() }
            "device.revoke" -> {
                val reason = env.payloadAs<DeviceRevoke>().reason
                scope.launch { store.save(null) }
                relay.stop()
                synchronized(outbox) { outbox.clear() }
                _state.value = State(revokedReason = reason)
            }
            "error" -> {
                val e = env.payloadAs<ErrorPayload>()
                itemId?.let { id -> setItem(id) { it.copy(status = ItemStatus.FAILED) } }
                _state.update { it.copy(lastError = e.message) }
                done()
            }
        }
        // Keep Messages referenced for validation completeness.
        check(env.type in Messages.ALL)
    }
}
