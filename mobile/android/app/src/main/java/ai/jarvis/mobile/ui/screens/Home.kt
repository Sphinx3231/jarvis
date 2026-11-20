package ai.jarvis.mobile.ui.screens

import ai.jarvis.mobile.data.Mode
import ai.jarvis.mobile.ui.ApprovalView
import ai.jarvis.mobile.ui.HomeView
import ai.jarvis.mobile.ui.components.AgentOrb
import ai.jarvis.mobile.ui.components.Chip
import ai.jarvis.mobile.ui.components.HudPanel
import ai.jarvis.mobile.ui.components.JarvisCore
import ai.jarvis.mobile.ui.components.SegmentGauge
import ai.jarvis.mobile.ui.components.chamfer
import ai.jarvis.mobile.ui.taskColor
import ai.jarvis.mobile.ui.theme.HudLabel
import ai.jarvis.mobile.ui.theme.J
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun HomeScreen(
    view: HomeView,
    listening: Boolean,
    partial: String,
    onModeChange: (Mode) -> Unit,
    onSubmit: (String) -> Unit,
    onMic: () -> Unit,
    onAgent: (String) -> Unit,
    onApproval: (String, Boolean) -> Unit,
    onOpenChat: () -> Unit,
    onOpenTasks: () -> Unit,
    onEmergencyStop: (() -> Unit)?,
    model: ai.jarvis.mobile.ui.ModelCard? = null,
    onModelAction: () -> Unit = {},
    onModelSecondary: () -> Unit = {},
) {
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            // header: wordmark + mode switch
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("J.A.R.V.I.S", style = HudLabel.copy(fontSize = 18.sp, letterSpacing = 5.sp, color = J.Text))
                    Text(view.executingOn, color = J.Lavender, fontSize = 12.sp, modifier = Modifier.semantics { contentDescription = view.executingOn })
                }
                ModeSwitch(view.mode, onModeChange)
            }
            Spacer(Modifier.height(10.dp))
            // connection strip
            Row(
                Modifier.fillMaxWidth().clip(chamfer(18f)).background(view.connection.color.copy(alpha = 0.08f)).border(1.dp, view.connection.color.copy(alpha = 0.4f), chamfer(18f)).padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Dot(view.connection.color)
                Spacer(Modifier.width(8.dp))
                Text(view.connection.label, color = view.connection.color, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.6.sp)
                Spacer(Modifier.width(10.dp))
                Text(view.connection.detail, color = J.TextDim, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
            // core + agent ring
            Box(Modifier.fillMaxWidth().height(300.dp), contentAlignment = Alignment.Center) {
                JarvisCore(view.core, Modifier.size(210.dp), label = view.coreDetail)
                val orbs = view.agents
                // six agents placed around the core
                val positions = listOf(-112f to -104f, 112f to -104f, -132f to 0f, 132f to 0f, -112f to 104f, 112f to 104f)
                orbs.take(6).forEachIndexed { i, a ->
                    val (x, y) = positions[i]
                    AgentOrb(a.name, a.color, a.working, a.available, Modifier.align(Alignment.Center).offset(x.dp, y.dp), onClick = { onAgent(a.id) })
                }
            }
            Text(view.coreDetail, color = J.TextDim, fontSize = 12.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(), maxLines = 2)
            Spacer(Modifier.height(12.dp))

            if (model != null) {
                HudPanel(title = model.title) {
                    Text(model.detail, color = J.TextDim, fontSize = 12.sp)
                    model.progress?.let { SegmentGauge(it, J.Purple, Modifier.padding(top = 8.dp)) }
                    if (model.action != null || model.secondary != null) Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        model.action?.let { HudButton(it, onModelAction, color = J.Purple) }
                        model.secondary?.let { HudButton(it, onModelSecondary, color = J.Bad) }
                    }
                }
                Spacer(Modifier.height(10.dp))
            }

            if (view.approvals.isNotEmpty()) {
                HudPanel(title = "Needs your approval", trailing = { Chip("${view.approvals.size}", J.Warn) }) {
                    view.approvals.take(3).forEach { ApprovalRow(it, onApproval) }
                }
                Spacer(Modifier.height(10.dp))
            }

            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatTile("Active tasks", view.tasks.count { it.cancellable }.toString(), J.Purple, Modifier.weight(1f), onOpenTasks)
                StatTile("Agents working", view.agents.count { it.working }.toString(), J.Cyan, Modifier.weight(1f)) {}
                StatTile("Approvals", view.approvals.size.toString(), if (view.approvals.isEmpty()) J.TextDim else J.Warn, Modifier.weight(1f), onOpenTasks)
            }
            Spacer(Modifier.height(10.dp))

            HudPanel(title = "Tasks", onClick = onOpenTasks) {
                val shown = view.tasks.take(3)
                if (shown.isEmpty()) Empty(if (view.mode == Mode.MOBILE) "No phone tasks. Try “remind me in 10 minutes to stretch”." else "No tasks on the PC.")
                shown.forEach { t ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 4.dp)) {
                        Text(t.title, color = J.Text, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        Chip(t.status.replace('_', ' '), taskColor(t.status))
                    }
                    t.progress?.takeIf { t.status == "running" }?.let { SegmentGauge(it, taskColor(t.status)) }
                }
            }
            Spacer(Modifier.height(10.dp))

            HudPanel(title = "Conversation", onClick = onOpenChat) {
                val last = view.chat.takeLast(2)
                if (last.isEmpty()) Empty("Nothing yet — type or tap the mic below.")
                last.forEach { ChatBubble(it) }
            }
            if (onEmergencyStop != null) {
                Spacer(Modifier.height(10.dp))
                HudButton("Emergency stop on PC", onEmergencyStop, Modifier.fillMaxWidth(), color = J.Bad, enabled = view.connection.usable)
            }
            Spacer(Modifier.height(12.dp))
        }
        CommandBar(
            if (view.mode == Mode.MOBILE) "Ask Mobile Jarvis…" else "Command your PC's Jarvis…",
            enabled = view.mode == Mode.MOBILE || view.connection.label != "NOT PAIRED",
            listening = listening, partial = partial, onSubmit = onSubmit, onMic = onMic,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        )
    }
}


@Composable
fun ModeSwitch(mode: Mode, onChange: (Mode) -> Unit) {
    Row(Modifier.clip(chamfer(16f)).border(1.dp, J.LineStrong, chamfer(16f))) {
        listOf(Mode.REMOTE_PC to "PC", Mode.MOBILE to "PHONE").forEach { (m, label) ->
            val on = m == mode
            Text(
                label, color = if (on) Color.White else J.TextDim, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.6.sp,
                modifier = Modifier.background(if (on) J.PurpleDeep else Color.Transparent).clickable { onChange(m) }.padding(horizontal = 12.dp, vertical = 7.dp)
                    .semantics { contentDescription = if (m == Mode.MOBILE) "Mobile mode: Jarvis runs on this phone" else "Remote PC mode: commands run on your PC" },
            )
        }
    }
}

@Composable
fun StatTile(label: String, value: String, color: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Column(modifier.clip(chamfer(18f)).background(Color(0xCC120C26)).border(1.dp, J.Line, chamfer(18f)).clickable(onClick = onClick).padding(10.dp)) {
        Text(value, color = color, fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Text(label.uppercase(), color = J.TextDim, fontSize = 9.sp, letterSpacing = 1.2.sp, maxLines = 1)
    }
}

@Composable
fun ApprovalRow(a: ApprovalView, onApproval: (String, Boolean) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(a.title, color = J.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        Text(a.summary, color = J.TextDim, fontSize = 12.sp, maxLines = 4, overflow = TextOverflow.Ellipsis)
        a.reason?.let { Text(it, color = J.Warn, fontSize = 11.sp) }
        Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HudButton("Approve", { onApproval(a.id, true) }, color = J.Ok)
            HudButton("Deny", { onApproval(a.id, false) }, color = J.Bad)
        }
    }
}
