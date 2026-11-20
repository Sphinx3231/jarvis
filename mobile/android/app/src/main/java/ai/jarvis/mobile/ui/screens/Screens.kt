package ai.jarvis.mobile.ui.screens

import ai.jarvis.mobile.data.ActivityEntity
import ai.jarvis.mobile.data.ConversationEntity
import ai.jarvis.mobile.data.Mode
import ai.jarvis.mobile.ui.AgentView
import ai.jarvis.mobile.ui.ApprovalView
import ai.jarvis.mobile.ui.HomeView
import ai.jarvis.mobile.ui.TaskView
import ai.jarvis.mobile.ui.components.AgentOrb
import ai.jarvis.mobile.ui.components.Chip
import ai.jarvis.mobile.ui.components.HudPanel
import ai.jarvis.mobile.ui.components.SegmentGauge
import ai.jarvis.mobile.ui.fmtTime
import ai.jarvis.mobile.ui.taskColor
import ai.jarvis.mobile.ui.theme.J
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// ------------------------------------------------------------------- conversation

@Composable
fun ChatScreen(view: HomeView, listening: Boolean, partial: String, onSubmit: (String) -> Unit, onMic: () -> Unit, onRetry: (String) -> Unit, onNew: () -> Unit, onHistory: (() -> Unit)?) {
    val list = rememberLazyListState()
    LaunchedEffect(view.chat.size) { if (view.chat.isNotEmpty()) list.animateScrollToItem(view.chat.size - 1) }
    Column(Modifier.fillMaxSize()) {
        ScreenTitle("Conversation", view.executingOn) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                onHistory?.let { HudButton("History", it) }
                HudButton("New", onNew)
            }
        }
        LazyColumn(Modifier.weight(1f).padding(horizontal = 14.dp), state = list) {
            if (view.chat.isEmpty()) item {
                Empty(if (view.mode == Mode.MOBILE) "Mobile Jarvis runs here on the phone. It remembers what you tell it, sets reminders, opens apps and more — risky actions ask first." else "Commands go end-to-end encrypted to your PC's Jarvis, which does the work. You'll see when the PC accepts a command and when it completes.")
            }
            items(view.chat, key = { it.id }) { line -> ChatBubble(line) { onRetry(line.id) } }
            if (view.busy) item { Text(view.coreDetail, color = J.Lavender, fontSize = 12.sp, modifier = Modifier.padding(4.dp)) }
        }
        CommandBar(if (view.mode == Mode.MOBILE) "Ask Mobile Jarvis…" else "Command your PC's Jarvis…", true, listening, partial, onSubmit, onMic, Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
    }
}

@Composable
fun ConversationsScreen(items: List<ConversationEntity>, onOpen: (String) -> Unit, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        ScreenTitle("History", "Stored only on this phone") { HudButton("Back", onBack) }
        LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (items.isEmpty()) item { Empty("No conversations yet.") }
            items(items, key = { it.id }) { c ->
                HudPanel(onClick = { onOpen(c.id) }) {
                    Text(c.title, color = J.Text, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(fmtTime(c.updatedAt), color = J.TextFaint, fontSize = 11.sp)
                }
            }
        }
    }
}

// ------------------------------------------------------------------- agents

@Composable
fun AgentsScreen(mode: Mode, agents: List<AgentView>, onOpen: (String) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { ScreenTitle("Agents", if (mode == Mode.MOBILE) "Neo, Sentinel and Echo have phone-side work. The others need your PC." else "Live from your PC's agent team") }
        items(agents, key = { it.id }) { a ->
            HudPanel(onClick = { onOpen(a.id) }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AgentOrb(a.name, a.color, a.working, a.available, size = 44.dp) { onOpen(a.id) }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(a.name, color = a.color, fontWeight = FontWeight.Bold, fontSize = 15.sp, modifier = Modifier.weight(1f))
                            Chip(if (!a.available) "unavailable" else if (a.working) "working" else "idle", if (!a.available) J.TextFaint else if (a.working) J.Cyan else J.TextDim)
                        }
                        Text(a.summary, color = J.TextDim, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        a.error?.let { Text(it, color = J.Bad, fontSize = 11.sp, maxLines = 2) }
                    }
                }
            }
        }
    }
}

@Composable
fun AgentDetailScreen(mode: Mode, agent: AgentView, result: String?, onRun: () -> Unit, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        ScreenTitle(agent.name, if (mode == Mode.MOBILE) "On this phone" else "On your PC") { HudButton("Back", onBack) }
        HudPanel(title = "Status") {
            KeyValue("State", if (!agent.available) "Not available in this mode" else if (agent.working) "Working" else "Idle", if (agent.working) J.Cyan else J.Text)
            agent.runs?.let { KeyValue("Runs", it.toString()) }
            agent.lastRunAt?.let { KeyValue("Last run", fmtTime(it)) }
            KeyValue("Last report", agent.summary)
            agent.error?.let { KeyValue("Error", it, J.Bad) }
        }
        Spacer(Modifier.height(10.dp))
        HudPanel(title = "Capabilities") {
            agent.capabilities.forEach { Text("• $it", color = J.TextDim, fontSize = 12.sp) }
            if (agent.capabilities.isEmpty()) Empty("None in this mode.")
        }
        Spacer(Modifier.height(12.dp))
        HudButton(if (mode == Mode.MOBILE) "Run on phone" else "Run on PC", onRun, Modifier.fillMaxWidth(), enabled = agent.available && !agent.working)
        if (!agent.available) Text(if (mode == Mode.MOBILE) "${agent.name}'s work needs your PC's pipeline and tools. Switch to Remote PC mode to run it." else "Connect to your PC (and enable agents there) to run ${agent.name}.", color = J.TextFaint, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
        result?.let { HudPanel(Modifier.padding(top = 12.dp), title = "Result") { Text(it, color = J.Text, fontSize = 13.sp) } }
    }
}

// ------------------------------------------------------------------- tasks

@Composable
fun TasksScreen(mode: Mode, tasks: List<TaskView>, approvals: List<ApprovalView>, onCancel: (String) -> Unit, onApproval: (String, Boolean) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { ScreenTitle("Tasks", if (mode == Mode.MOBILE) "Scheduled and finished work on this phone" else "Your PC's task queue") }
        if (approvals.isNotEmpty()) item {
            HudPanel(title = "Waiting for approval") { approvals.forEach { ApprovalRow(it, onApproval) } }
        }
        if (tasks.isEmpty()) item { Empty("No tasks.") }
        items(tasks, key = { it.id }) { t ->
            HudPanel {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(t.title, color = J.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Chip(t.status.replace('_', ' '), taskColor(t.status))
                }
                t.progress?.let { if (t.status == "running") SegmentGauge(it, taskColor(t.status), Modifier.padding(vertical = 6.dp)) }
                t.detail?.let { Text(it, color = J.TextDim, fontSize = 12.sp, maxLines = 4, overflow = TextOverflow.Ellipsis) }
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
                    Text(fmtTime(t.when_), color = J.TextFaint, fontSize = 11.sp, modifier = Modifier.weight(1f))
                    if (t.cancellable) HudButton("Cancel", { onCancel(t.id) }, color = J.Bad)
                }
            }
        }
    }
}

// ------------------------------------------------------------------- activity

@Composable
fun ActivityScreen(items: List<ActivityEntity>, note: String) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        item { ScreenTitle("Activity", note) }
        if (items.isEmpty()) item { Empty("Nothing logged yet.") }
        items(items, key = { it.id }) { a ->
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.Top) {
                Dot(when (a.level) { "error" -> J.Bad; "warning" -> J.Warn; "success" -> J.Ok; else -> J.Lavender })
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(a.message, color = J.Text, fontSize = 13.sp)
                    Text("${a.category.uppercase()} · ${fmtTime(a.ts)}", color = J.TextFaint, fontSize = 10.sp, letterSpacing = 1.sp)
                }
            }
        }
    }
}
