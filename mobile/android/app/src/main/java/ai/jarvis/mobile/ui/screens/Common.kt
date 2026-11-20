package ai.jarvis.mobile.ui.screens

import ai.jarvis.mobile.ui.ChatLine
import ai.jarvis.mobile.ui.components.Chip
import ai.jarvis.mobile.ui.components.chamfer
import ai.jarvis.mobile.ui.theme.HudLabel
import ai.jarvis.mobile.ui.theme.J
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Text + push-to-talk command input. The mic only listens while the user has tapped it. */
@Composable
fun CommandBar(
    placeholder: String,
    enabled: Boolean,
    listening: Boolean,
    partial: String,
    onSubmit: (String) -> Unit,
    onMic: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var text by rememberSaveable { mutableStateOf("") }
    val send = { if (text.isNotBlank()) { onSubmit(text.trim()); text = "" } }
    Row(
        modifier.fillMaxWidth().clip(chamfer(24f)).background(Color(0xE6120C28)).border(1.dp, if (listening) J.Cyan else J.LineStrong, chamfer(24f)).padding(start = 14.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f).padding(vertical = 14.dp)) {
            if (text.isEmpty()) Text(if (listening) (partial.ifBlank { "Listening…" }) else placeholder, color = if (listening) J.Cyan else J.TextFaint, fontSize = 15.sp, maxLines = 2)
            BasicTextField(
                text, { text = it }, enabled = enabled,
                textStyle = TextStyle(color = J.Text, fontSize = 15.sp), cursorBrush = SolidColor(J.Lavender),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { send() }),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Command" }, maxLines = 5,
            )
        }
        IconButton(onClick = onMic, enabled = enabled) {
            Icon(if (listening) Icons.Filled.MicOff else Icons.Filled.Mic, if (listening) "Stop listening" else "Speak a command", tint = if (listening) J.Cyan else J.Lavender)
        }
        IconButton(onClick = send, enabled = enabled && text.isNotBlank()) {
            Icon(Icons.AutoMirrored.Filled.Send, "Send", tint = if (text.isNotBlank()) J.Purple else J.TextFaint)
        }
    }
}

@Composable
fun ChatBubble(line: ChatLine, onRetry: (() -> Unit)? = null) {
    val user = line.role == "user"
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
        Text(
            line.text, color = J.Text, fontSize = 14.sp,
            modifier = Modifier.widthIn(max = 320.dp).clip(RoundedCornerShape(if (user) 14.dp else 4.dp, 14.dp, if (user) 4.dp else 14.dp, 14.dp))
                .background(if (user) Color(0x553B1C80) else Color(0xCC130D2A)).border(1.dp, if (user) J.LineStrong else J.Line, RoundedCornerShape(if (user) 14.dp else 4.dp, 14.dp, if (user) 4.dp else 14.dp, 14.dp))
                .padding(horizontal = 12.dp, vertical = 9.dp),
        )
        Row(Modifier.padding(top = 3.dp, start = 4.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            line.meta?.let { Text(it, color = J.TextFaint, fontSize = 10.sp) }
            line.status?.let { Chip(it, line.statusColor) }
            if (line.retryable && onRetry != null) TextButton(onClick = onRetry, contentPadding = ButtonDefaults.TextButtonContentPadding) { Text("Re-send", color = J.Lavender, fontSize = 11.sp) }
        }
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
fun ScreenTitle(title: String, subtitle: String? = null, trailing: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title.uppercase(), fontSize = 20.sp, color = J.Text, letterSpacing = 3.sp, style = HudLabel.copy(fontSize = 20.sp, color = J.Text))
            subtitle?.let { Text(it, color = J.TextDim, fontSize = 12.sp) }
        }
        trailing?.invoke()
    }
}

@Composable
fun HudButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, color: Color = J.Lavender, enabled: Boolean = true) {
    OutlinedButton(
        onClick, modifier, enabled = enabled, shape = chamfer(18f),
        border = androidx.compose.foundation.BorderStroke(1.dp, if (enabled) color.copy(alpha = 0.7f) else J.Line),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = color.copy(alpha = 0.08f), contentColor = color),
    ) { Text(text.uppercase(), letterSpacing = 1.4.sp, fontSize = 12.sp) }
}

@Composable
fun Empty(text: String) {
    Text(text, color = J.TextFaint, fontSize = 13.sp, modifier = Modifier.padding(vertical = 6.dp))
}

@Composable
fun KeyValue(k: String, v: String, color: Color = J.Text) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(k, color = J.TextDim, fontSize = 12.sp, modifier = Modifier.weight(0.42f))
        Text(v, color = color, fontSize = 12.sp, modifier = Modifier.weight(0.58f))
    }
}

@Composable
fun Dot(color: Color) = Box(Modifier.size(7.dp).clip(CircleShape).background(color))
