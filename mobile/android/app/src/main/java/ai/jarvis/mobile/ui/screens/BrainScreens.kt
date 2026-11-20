package ai.jarvis.mobile.ui.screens

import ai.jarvis.mobile.runtime.brain.NoteRef
import ai.jarvis.mobile.ui.components.HudPanel
import ai.jarvis.mobile.ui.fmtTime
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The live brain: which vault Jarvis uses, and the notes in it. */
@Composable
fun BrainScreen(
    label: String,
    isVault: Boolean,
    saveConversations: Boolean,
    notes: List<NoteRef>?,
    error: String?,
    onConnect: () -> Unit,
    onUseBuiltIn: () -> Unit,
    onToggleSave: (Boolean) -> Unit,
    onOpen: (String) -> Unit,
    onNew: () -> Unit,
) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { ScreenTitle("Brain", "Notes Jarvis reads when it answers, and where it files what you talk about") }
        item {
            HudPanel(title = if (isVault) "Obsidian vault" else "Built-in brain") {
                Text(label, color = J.Text, fontSize = 14.sp)
                Text(
                    if (isVault) "Jarvis reads notes in this folder and files conversations under Jarvis/ — they show up in Obsidian. It only changes your other notes if you approve."
                    else "Stored only on this phone. Use Obsidian? Connect your vault folder and Jarvis will use it instead (it asks Android for access to that folder only).",
                    color = J.TextDim, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp),
                )
                error?.let { Text(it, color = J.Bad, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp)) }
                Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HudButton(if (isVault) "Change vault" else "Connect Obsidian vault", onConnect, color = J.Purple)
                    if (isVault) HudButton("Use built-in", onUseBuiltIn)
                }
                Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Save conversations to the brain", color = J.Text, fontSize = 13.sp)
                        Text("Each Mobile-mode conversation becomes a note in Jarvis/Conversations.", color = J.TextFaint, fontSize = 11.sp)
                    }
                    Switch(saveConversations, onToggleSave, colors = SwitchDefaults.colors(checkedTrackColor = J.Purple))
                }
            }
        }
        item {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
                Text("NOTES${notes?.let { " · ${it.size}" } ?: ""}", color = J.Lavender, fontSize = 11.sp, letterSpacing = 2.sp, modifier = Modifier.weight(1f))
                HudButton("New note", onNew)
            }
        }
        if (notes == null) item { Empty("Reading the vault…") }
        else if (notes.isEmpty()) item { Empty("No notes yet.") }
        else items(notes.take(300), key = { it.path }) { n ->
            HudPanel(onClick = { onOpen(n.path) }) {
                Text(n.title, color = J.Text, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(listOfNotNull(n.folder.ifBlank { null }, fmtTime(n.modified)).joinToString(" · "), color = J.TextFaint, fontSize = 11.sp)
            }
        }
    }
}

/** View or edit one note (Markdown as text). */
@Composable
fun NoteScreen(path: String, initial: String?, isNew: Boolean, onSave: (title: String, text: String) -> Unit, onBack: () -> Unit) {
    var title by remember(path) { mutableStateOf(if (isNew) "" else path.removeSuffix(".md")) }
    var text by remember(path, initial) { mutableStateOf(initial ?: "") }
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        ScreenTitle(if (isNew) "New note" else path.substringAfterLast('/').removeSuffix(".md"), if (isNew) null else path) { HudButton("Back", onBack) }
        if (isNew) OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth(), label = { Text("Title (folders with /)") }, singleLine = true, colors = fieldColors())
        Spacer(Modifier.height(8.dp))
        if (initial == null && !isNew) Empty("Loading…")
        else OutlinedTextField(
            text, { text = it }, Modifier.fillMaxWidth().weight(1f),
            textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = J.Text), colors = fieldColors(),
        )
        Spacer(Modifier.height(8.dp))
        HudButton("Save", { onSave(title, text) }, Modifier.fillMaxWidth(), color = J.Purple, enabled = title.isNotBlank())
    }
}
