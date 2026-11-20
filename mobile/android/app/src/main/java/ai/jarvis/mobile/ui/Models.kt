package ai.jarvis.mobile.ui

import ai.jarvis.mobile.data.MessageEntity
import ai.jarvis.mobile.data.MobileTaskEntity
import ai.jarvis.mobile.data.Mode
import ai.jarvis.mobile.protocol.AgentCatalog
import ai.jarvis.mobile.remote.RelayConnection
import ai.jarvis.mobile.remote.RemoteSession
import ai.jarvis.mobile.runtime.MobileExecutionRouter
import ai.jarvis.mobile.ui.components.CoreMode
import ai.jarvis.mobile.ui.theme.J
import androidx.compose.ui.graphics.Color

/** Display models shared by both modes, so every screen states plainly where work runs. */
data class AgentView(
    val id: String, val name: String, val color: Color, val working: Boolean, val available: Boolean,
    val summary: String, val capabilities: List<String>, val runs: Int? = null, val lastRunAt: Long? = null, val error: String? = null,
)
data class TaskView(val id: String, val title: String, val status: String, val progress: Float?, val detail: String?, val cancellable: Boolean, val when_: Long)
data class ApprovalView(val id: String, val title: String, val summary: String, val reason: String?)
data class ChatLine(val id: String, val role: String, val text: String, val status: String? = null, val statusColor: Color = J.TextDim, val meta: String? = null, val retryable: Boolean = false)
data class Connection(val label: String, val detail: String, val color: Color, val usable: Boolean)

data class HomeView(
    val mode: Mode,
    val executingOn: String,
    val connection: Connection,
    val core: CoreMode,
    val coreDetail: String,
    val agents: List<AgentView>,
    val tasks: List<TaskView>,
    val approvals: List<ApprovalView>,
    val chat: List<ChatLine>,
    val busy: Boolean,
)

fun parseColor(hex: String): Color = runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(J.Purple)

fun taskColor(status: String): Color = when (status) {
    "completed" -> J.Ok
    "failed", "cancelled" -> J.Bad
    "awaiting_approval", "paused" -> J.Warn
    "running" -> J.Purple
    else -> J.Lavender
}

// ------------------------------------------------------------------- Remote PC mode

fun remoteConnection(s: RemoteSession.State): Connection = when {
    s.paired == null -> Connection("NOT PAIRED", "Pair with your PC in Devices", J.TextFaint, false)
    s.revokedReason != null -> Connection("REVOKED", s.revokedReason, J.Bad, false)
    s.relay.state == RelayConnection.State.CONNECTED && s.pcOnline -> Connection("PC ONLINE", "${s.paired.pcName} via ${hostOf(s.paired.relayUrl)} · end-to-end encrypted", J.Ok, true)
    s.relay.state == RelayConnection.State.CONNECTED -> Connection("PC OFFLINE", "Relay reachable, but ${s.paired.pcName} isn't connected. Commands wait and are re-sent when it returns.", J.Warn, false)
    s.relay.state == RelayConnection.State.CONNECTING -> Connection("CONNECTING", s.relay.detail, J.Lavender, false)
    else -> Connection("RELAY UNREACHABLE", s.relay.detail, J.Bad, false)
}

private fun hostOf(url: String) = runCatching { java.net.URI(url).host }.getOrNull() ?: url

fun remoteStatusLabel(st: RemoteSession.ItemStatus): Pair<String, Color> = when (st) {
    RemoteSession.ItemStatus.SENDING -> "sending" to J.Lavender
    RemoteSession.ItemStatus.WAITING_FOR_PC -> "waiting for PC" to J.Warn
    RemoteSession.ItemStatus.ACCEPTED -> "accepted by PC" to J.Cyan
    RemoteSession.ItemStatus.COMPLETED -> "completed" to J.Ok
    RemoteSession.ItemStatus.REJECTED -> "rejected" to J.Bad
    RemoteSession.ItemStatus.FAILED -> "failed" to J.Bad
}

fun remoteHome(s: RemoteSession.State): HomeView {
    val conn = remoteConnection(s)
    val agents = AgentCatalog.ALL.map { a ->
        val live = s.agents.firstOrNull { it.id == a.id }
        AgentView(
            a.id, a.name, Color(a.color), live?.state == "working", conn.usable && s.agentsEnabled,
            live?.lastSummary?.ifBlank { null } ?: if (!s.agentsEnabled && conn.usable) "Agents are switched off on the PC" else "No report yet",
            a.pc, live?.runs, live?.lastRunAt, live?.error,
        )
    }
    val core = when {
        !conn.usable -> CoreMode.OFFLINE
        s.approvals.isNotEmpty() -> CoreMode.WAITING
        s.assistantState in setOf("thinking", "planning") -> CoreMode.THINKING
        s.assistantState in setOf("working", "executing", "running") || s.tasks.any { it.status == "running" } -> CoreMode.WORKING
        s.assistantState == "error" -> CoreMode.ERROR
        else -> CoreMode.IDLE
    }
    return HomeView(
        Mode.REMOTE_PC,
        executingOn = s.paired?.let { "Executing on: ${it.pcName} (PC)" } ?: "Executing on: no PC paired",
        connection = conn,
        core = core,
        coreDetail = s.assistantDetail.ifBlank { if (conn.usable) "PC Jarvis ${s.assistantState}" else conn.detail },
        agents = agents,
        tasks = s.tasks.map { TaskView(it.id, it.title, it.status, it.progress.toFloat(), it.error ?: it.result, it.status in setOf("queued", "running", "paused", "awaiting_approval"), it.updatedAt) },
        approvals = s.approvals.map { ApprovalView(it.id, it.taskTitle, it.summary, it.reason) },
        chat = s.chat.map { c ->
            val (label, color) = if (c.role == "user") remoteStatusLabel(c.status) else (null to J.TextDim)
            ChatLine(c.id, c.role, c.text, label, color, if (c.via == "voice") "voice" else null, retryable = c.role == "user" && c.status in setOf(RemoteSession.ItemStatus.WAITING_FOR_PC, RemoteSession.ItemStatus.FAILED))
        },
        busy = s.chat.any { it.role == "user" && it.status in setOf(RemoteSession.ItemStatus.SENDING, RemoteSession.ItemStatus.ACCEPTED) },
    )
}

// ------------------------------------------------------------------- Mobile mode

fun mobileHome(
    status: MobileExecutionRouter.Status,
    busy: Boolean,
    connection: Connection,
    agentSummaries: Map<String, String>,
    tasks: List<MobileTaskEntity>,
    approvals: List<ApprovalView>,
    messages: List<MessageEntity>,
    listening: Boolean,
): HomeView {
    val core = when {
        listening -> CoreMode.LISTENING
        approvals.isNotEmpty() -> CoreMode.WAITING
        busy && status.phase == MobileExecutionRouter.Phase.THINKING -> CoreMode.THINKING
        busy -> CoreMode.WORKING
        status.phase == MobileExecutionRouter.Phase.ERROR -> CoreMode.ERROR
        else -> CoreMode.IDLE
    }
    return HomeView(
        Mode.MOBILE,
        executingOn = "Executing on: this phone",
        connection = connection,
        core = core,
        coreDetail = if (busy) status.detail else "Ready",
        agents = AgentCatalog.ALL.map { a ->
            AgentView(a.id, a.name, Color(a.color), false, a.mobile.isNotEmpty(), agentSummaries[a.id] ?: if (a.mobile.isEmpty()) "Needs your PC — available in Remote PC mode" else "Tap to run on the phone", a.mobile.ifEmpty { a.pc })
        },
        tasks = tasks.map { TaskView(it.id, it.title, it.status, null, it.error ?: it.result ?: it.scheduledFor?.let { t -> "Due ${fmtTime(t)}" }, it.status == "scheduled", it.updatedAt) },
        approvals = approvals,
        chat = messages.filter { it.role == "user" || it.role == "assistant" }.map { m ->
            val handled = Regex("\"handledBy\":\"([^\"]+)\"").find(m.meta)?.groupValues?.get(1)
            val tools = Regex("\"tools\":\\[([^\\]]*)]").find(m.meta)?.groupValues?.get(1)?.replace("\"", "")?.ifBlank { null }
            ChatLine(m.id, m.role, m.content, null, J.TextDim, listOfNotNull(handled, tools?.let { "used $it" }).joinToString(" · ").ifBlank { null })
        },
        busy = busy,
    )
}

fun fmtTime(ms: Long): String {
    val t = java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneId.systemDefault())
    val today = java.time.LocalDate.now()
    val hm = "%02d:%02d".format(t.hour, t.minute)
    return if (t.toLocalDate() == today) hm else "${t.toLocalDate()} $hm"
}

/** The Mobile-mode model as the header strip shows it. */
fun modelConnection(kind: String, onDevice: ai.jarvis.mobile.runtime.local.LocalModelStore.State, onDeviceName: String?, cloudLabel: String?): Connection {
    if (kind == "on_device") {
        return when (onDevice) {
            is ai.jarvis.mobile.runtime.local.LocalModelStore.State.Ready, ai.jarvis.mobile.runtime.local.LocalModelStore.State.Idle -> Connection("ON-DEVICE MODEL", "${onDeviceName ?: "Local model"} · runs offline on this phone", J.Ok, true)
            is ai.jarvis.mobile.runtime.local.LocalModelStore.State.Preparing -> Connection("UNPACKING MODEL ${(onDevice.fraction * 100).toInt()}%", "First launch only — direct commands already work", J.Lavender, true)
            is ai.jarvis.mobile.runtime.local.LocalModelStore.State.Failed -> Connection("MODEL UNAVAILABLE", onDevice.reason, J.Bad, true)
            ai.jarvis.mobile.runtime.local.LocalModelStore.State.NotBundled -> Connection("NO MODEL", "This build has no on-device model — add one in Settings", J.Warn, true)
        }
    }
    return if (cloudLabel != null) Connection("MODEL READY", cloudLabel, J.Ok, true) else Connection("NO MODEL", "Direct commands only — add a model in Settings", J.Warn, true)
}
