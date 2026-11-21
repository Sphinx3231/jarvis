package ai.jarvis.mobile.ui.screens

import ai.jarvis.mobile.data.Mode
import ai.jarvis.mobile.data.ProviderConfig
import ai.jarvis.mobile.remote.PairedPc
import ai.jarvis.mobile.runtime.Policy
import ai.jarvis.mobile.runtime.Risk
import ai.jarvis.mobile.ui.Connection
import ai.jarvis.mobile.ui.components.Chip
import ai.jarvis.mobile.ui.components.CoreMode
import ai.jarvis.mobile.ui.components.HudPanel
import ai.jarvis.mobile.ui.components.JarvisCore
import ai.jarvis.mobile.ui.components.chamfer
import ai.jarvis.mobile.ui.fmtTime
import ai.jarvis.mobile.ui.theme.HudLabel
import ai.jarvis.mobile.ui.theme.J
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// ------------------------------------------------------------------- onboarding

@Composable
fun OnboardingScreen(onChoose: (Mode) -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.height(16.dp))
        JarvisCore(CoreMode.IDLE, Modifier.size(180.dp))
        Spacer(Modifier.height(12.dp))
        Text("J.A.R.V.I.S", style = HudLabel.copy(fontSize = 24.sp, letterSpacing = 8.sp, color = J.Text))
        Text("Choose how Jarvis works on this phone. You can switch any time.", color = J.TextDim, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 6.dp, bottom = 18.dp))
        ModeCard("Remote PC", "Control your PC's Jarvis from anywhere", listOf("Your PC does the work, with its own approvals and safety controls", "Pair once by scanning a QR code on the PC", "End-to-end encrypted through a relay — nothing on your PC is exposed to the internet")) { onChoose(Mode.REMOTE_PC) }
        Spacer(Modifier.height(12.dp))
        ModeCard("Mobile", "Jarvis runs on this phone", listOf("Its own conversations, memory and reminders, stored only on the phone", "Uses phone capabilities — risky actions ask you first", "Bring your own model (Anthropic or any OpenAI-compatible endpoint)")) { onChoose(Mode.MOBILE) }
        Text("No permission is granted up front. Jarvis asks for the microphone, camera or notifications only when you use a feature that needs them.", color = J.TextFaint, fontSize = 11.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 18.dp))
    }
}

@Composable
private fun ModeCard(title: String, subtitle: String, points: List<String>, onClick: () -> Unit) {
    HudPanel(onClick = onClick) {
        Text(title.uppercase(), style = HudLabel.copy(fontSize = 15.sp, color = J.Text))
        Text(subtitle, color = J.Lavender, fontSize = 13.sp, modifier = Modifier.padding(bottom = 6.dp))
        points.forEach { Text("› $it", color = J.TextDim, fontSize = 12.sp, modifier = Modifier.padding(vertical = 1.dp)) }
        Spacer(Modifier.height(8.dp))
        HudButton("Use $title mode", onClick, Modifier.fillMaxWidth(), color = J.Purple)
    }
}

// ------------------------------------------------------------------- devices / pairing

data class DevicesView(
    val paired: PairedPc?,
    val connection: Connection,
    val phoneId: String?,
    val pairing: Boolean,
    val pairError: String?,
    val lastStop: String?,
)

@Composable
fun DevicesScreen(v: DevicesView, onScan: () -> Unit, onPairLink: (String) -> Unit, onUnpair: () -> Unit, onStop: () -> Unit, onRefresh: () -> Unit) {
    var link by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        ScreenTitle("Devices", "Your paired PC and this phone")
        if (v.paired == null) {
            HudPanel(title = "Pair with your PC") {
                Text("On your PC open Jarvis → Settings → Jarvis Mobile, set a relay URL, turn it on and press “Pair a phone”. Then scan the QR code here. The code works once, for 5 minutes.", color = J.TextDim, fontSize = 12.sp)
                Spacer(Modifier.height(10.dp))
                HudButton(if (v.pairing) "Pairing…" else "Scan QR code", onScan, Modifier.fillMaxWidth(), color = J.Purple, enabled = !v.pairing)
                Spacer(Modifier.height(10.dp))
                Text("…or paste the pairing link", color = J.TextFaint, fontSize = 11.sp)
                OutlinedTextField(link, { link = it.trim() }, Modifier.fillMaxWidth(), placeholder = { Text("jarvis://pair?…", color = J.TextFaint) }, singleLine = true, colors = fieldColors())
                Spacer(Modifier.height(6.dp))
                HudButton("Pair", { onPairLink(link) }, Modifier.fillMaxWidth(), enabled = link.startsWith("jarvis://pair") && !v.pairing)
                v.pairError?.let { Text(it, color = J.Bad, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp)) }
            }
        } else {
            HudPanel(title = "Paired PC", trailing = { Chip(v.connection.label, v.connection.color) }) {
                KeyValue("Name", v.paired.pcName)
                KeyValue("Relay", v.paired.relayUrl)
                KeyValue("PC id", v.paired.pcId.take(16) + "…")
                KeyValue("Paired", fmtTime(v.paired.pairedAt))
                KeyValue("Allowed", v.paired.scopes.joinToString())
                Text(v.connection.detail, color = J.TextDim, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HudButton("Refresh", onRefresh, enabled = v.connection.usable)
                    HudButton("Unpair", onUnpair, color = J.Bad)
                }
            }
            Spacer(Modifier.height(10.dp))
            HudPanel(title = "Emergency stop") {
                Text("Cancels every active task on the PC and stops Computer Access. Works only while the PC is online; the PC confirms when done.", color = J.TextDim, fontSize = 12.sp)
                Spacer(Modifier.height(8.dp))
                HudButton("Stop everything on the PC", onStop, Modifier.fillMaxWidth(), color = J.Bad, enabled = v.connection.usable && "stop" in v.paired.scopes)
                v.lastStop?.let { Text(it, color = J.Ok, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp)) }
            }
        }
        Spacer(Modifier.height(10.dp))
        HudPanel(title = "This phone") {
            KeyValue("Device id", v.phoneId?.let { it.take(16) + "…" } ?: "Created when you pair")
            Text("Its keys live in the Android Keystore and never leave the phone. The relay only sees encrypted messages.", color = J.TextFaint, fontSize = 11.sp)
        }
    }
}

// ------------------------------------------------------------------- capabilities & permissions

data class CapRow(val name: String, val title: String, val description: String, val risk: Risk, val policy: Policy, val available: Boolean, val reason: String)
data class PermRow(val permission: String, val label: String, val why: String, val granted: Boolean)

@Composable
fun CapabilitiesScreen(caps: List<CapRow>, perms: List<PermRow>, onPolicy: (String, Policy) -> Unit, onGrant: (String) -> Unit, phoneControlOn: Boolean = false, onOpenAccessibility: () -> Unit = {}, onOpenSystemSettings: () -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { ScreenTitle("Capabilities", "What Mobile Jarvis may do on this phone. Read-only actions run freely; actions that change something ask first by default.") }
        item {
            HudPanel(title = "Phone control", trailing = { Chip(if (phoneControlOn) "on" else "off", if (phoneControlOn) J.Ok else J.TextDim) }) {
                Text("Lets Jarvis work inside your apps like you would — e.g. “check my Gmail” opens Gmail and reads your inbox. It reads the screen and taps, types and scrolls only while doing what you asked, shows a STOP button, and asks first before sending, paying, deleting or posting, and for anything in banking or payment apps. It never reads or types passwords, and doesn't control games.", color = J.TextDim, fontSize = 12.sp)
                if (!phoneControlOn) {
                    Text("To switch it on: Accessibility → Installed apps → Jarvis phone control → On. Android may say it's a “restricted setting” because Jarvis wasn't installed from the Play Store — then open Settings → Apps → Jarvis → ⋮ (top right) → Allow restricted settings, and try again.", color = J.Lavender, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
                }
                Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HudButton(if (phoneControlOn) "Accessibility settings" else "Turn on", onOpenAccessibility, color = J.Purple)
                    if (!phoneControlOn) HudButton("App info", onOpenSystemSettings)
                }
            }
        }
        item {
            HudPanel(title = "Android permissions") {
                perms.forEach { p ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 4.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(p.label, color = J.Text, fontSize = 13.sp)
                            Text(p.why, color = J.TextFaint, fontSize = 11.sp)
                        }
                        if (p.granted) Chip("granted", J.Ok) else HudButton("Grant", { onGrant(p.permission) })
                    }
                }
                Text("Revoking happens in Android settings.", color = J.TextFaint, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp).clickable(onClick = onOpenSystemSettings))
            }
        }
        items(caps, key = { it.name }) { c ->
            HudPanel {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(c.title, color = J.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    Chip(if (c.risk == Risk.READ) "read" else "acts", if (c.risk == Risk.READ) J.Cyan else J.Warn)
                }
                Text(c.description, color = J.TextDim, fontSize = 12.sp)
                if (!c.available) Text(c.reason, color = J.Warn, fontSize = 11.sp)
                Row(Modifier.padding(top = 8.dp).clip(chamfer(14f)).border(1.dp, J.Line, chamfer(14f))) {
                    Policy.entries.forEach { p ->
                        val on = p == c.policy
                        val col = when (p) { Policy.ALLOW -> J.Ok; Policy.ASK -> J.Warn; Policy.DENY -> J.Bad }
                        Text(
                            when (p) { Policy.ALLOW -> "ALLOW"; Policy.ASK -> "ASK FIRST"; Policy.DENY -> "BLOCK" }, color = if (on) Color.White else J.TextDim, fontSize = 10.sp, letterSpacing = 1.2.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier.background(if (on) col.copy(alpha = 0.45f) else Color.Transparent).clickable { onPolicy(c.name, p) }.padding(horizontal = 12.dp, vertical = 6.dp),
                        )
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------------- settings

@Composable
fun SettingsScreen(mode: Mode, provider: ProviderConfig, hasKey: Boolean, speakReplies: Boolean, providerTest: String?, models: List<ModelOption>, onMode: (Mode) -> Unit, voiceEngine: String = "model", onVoiceEngine: (String) -> Unit = {}, onSave: (ProviderConfig, String?) -> Unit, onClearKey: () -> Unit, onTest: () -> Unit, onSpeak: (Boolean) -> Unit, onOpen: (String) -> Unit, onSelectModel: (String) -> Unit = {}, onDeleteModel: (String) -> Unit = {}) {
    var kind by remember(provider) { mutableStateOf(provider.kind) }
    var url by remember(provider) { mutableStateOf(provider.baseUrl) }
    var model by remember(provider) { mutableStateOf(provider.model) }
    var key by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        ScreenTitle("Settings")
        HudPanel(title = "Mode") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (mode == Mode.MOBILE) "Jarvis runs on this phone" else "Commands run on your PC", color = J.TextDim, fontSize = 12.sp, modifier = Modifier.weight(1f))
                ModeSwitch(mode, onMode)
            }
        }
        Spacer(Modifier.height(10.dp))
        HudPanel(title = "Mobile model") {
            Text(if (kind == "on_device") "The built-in model runs entirely on this phone — no internet, no account, nothing leaves the device. Larger cloud models are smarter; with one of those, your messages go to that provider." else "With a cloud model, Mobile mode sends your messages (and the tool results it needs) to the provider you choose.", color = J.TextFaint, fontSize = 11.sp)
            Row(Modifier.padding(vertical = 8.dp).clip(chamfer(14f)).border(1.dp, J.Line, chamfer(14f))) {
                listOf("on_device" to "ON-DEVICE", "anthropic" to "ANTHROPIC", "openai_compatible" to "OPENAI-COMPAT.", "none" to "NONE").forEach { (k, label) ->
                    Text(label, color = if (k == kind) Color.White else J.TextDim, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp, modifier = Modifier.background(if (k == kind) J.PurpleDeep else Color.Transparent).clickable { kind = k }.padding(horizontal = 10.dp, vertical = 7.dp))
                }
            }
            if (kind == "on_device") models.forEach { m ->
                Column(
                    Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(chamfer(16f)).border(1.dp, if (m.selected) J.Purple else J.Line, chamfer(16f))
                        .background(if (m.selected) J.PurpleDeep.copy(alpha = 0.25f) else Color.Transparent).clickable { onSelectModel(m.id) }.padding(10.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(m.name, color = J.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        Text("${m.sizeMb} MB", color = J.TextDim, fontSize = 11.sp)
                    }
                    Text(m.summary, color = J.TextDim, fontSize = 12.sp)
                    Text(m.status, color = if (m.ready) J.Ok else J.Lavender, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
                    if (m.deletable) Text("Delete download", color = J.Bad, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp).clickable { onDeleteModel(m.id) })
                }
            }
            if (kind == "on_device" && models.isNotEmpty()) Text("Runs fully offline; nothing you say to it leaves the phone. ${models.first().license}.", color = J.TextFaint, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp, bottom = 6.dp))
            if (kind == "openai_compatible") OutlinedTextField(url, { url = it.trim() }, Modifier.fillMaxWidth(), label = { Text("Base URL (e.g. https://api.openai.com/v1)") }, singleLine = true, colors = fieldColors())
            if (kind == "anthropic" || kind == "openai_compatible") {
                OutlinedTextField(model, { model = it.trim() }, Modifier.fillMaxWidth(), label = { Text("Model id") }, singleLine = true, colors = fieldColors())
                OutlinedTextField(key, { key = it.trim() }, Modifier.fillMaxWidth(), label = { Text(if (hasKey) "API key (saved — type to replace)" else "API key") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), colors = fieldColors())
                Text("The key is encrypted with an Android Keystore key and never shown again.", color = J.TextFaint, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
            }
            Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                HudButton("Save", { onSave(ProviderConfig(kind, url, model), key.ifBlank { null }); key = "" }, color = J.Purple)
                if (kind != "none") HudButton(if (kind == "on_device") "Try it" else "Test", onTest)
                if (hasKey) HudButton("Forget key", onClearKey, color = J.Bad)
            }
            providerTest?.let { Text(it, color = if (it.startsWith("OK")) J.Ok else J.Warn, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp)) }
        }
        Spacer(Modifier.height(10.dp))
        HudPanel(title = "Voice") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Speak replies to voice commands", color = J.Text, fontSize = 13.sp)
                    Text("Push-to-talk only: Jarvis listens just while you've tapped the mic. There is no always-on wake word.", color = J.TextFaint, fontSize = 11.sp)
                }
                Switch(speakReplies, onSpeak, colors = SwitchDefaults.colors(checkedTrackColor = J.Purple))
            }
            Text("Speech recognition", color = J.Text, fontSize = 13.sp, modifier = Modifier.padding(top = 12.dp))
            Row(Modifier.padding(top = 6.dp).clip(chamfer(14f)).border(1.dp, J.Line, chamfer(14f))) {
                listOf("model" to "JARVIS MODEL", "android" to "ANDROID").forEach { (k, label) ->
                    Text(label, color = if (k == voiceEngine) Color.White else J.TextDim, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp, modifier = Modifier.background(if (k == voiceEngine) J.PurpleDeep else Color.Transparent).clickable { onVoiceEngine(k) }.padding(horizontal = 12.dp, vertical = 7.dp))
                }
            }
            Text(if (voiceEngine == "model") "Your voice is transcribed by the on-device model (more accurate; works offline). Until the model is downloaded, Android's recognizer is used." else "Android's speech recognizer (faster to start; accuracy depends on your phone).", color = J.TextFaint, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
        }
        Spacer(Modifier.height(10.dp))
        HudPanel(title = "More") {
            listOf("brain" to "Brain (notes vault / Obsidian)", "capabilities" to "Capabilities & permissions", "activity" to "Activity log", "devices" to "Devices & pairing", "history" to "Conversation history").forEach { (route, label) ->
                Text("› $label", color = J.Lavender, fontSize = 14.sp, modifier = Modifier.fillMaxWidth().clickable { onOpen(route) }.padding(vertical = 8.dp))
            }
        }
    }
}

@Composable
fun fieldColors() = OutlinedTextFieldDefaults.colors(focusedBorderColor = J.Purple, unfocusedBorderColor = J.Line, focusedTextColor = J.Text, unfocusedTextColor = J.Text, focusedLabelColor = J.Lavender, unfocusedLabelColor = J.TextDim, cursorColor = J.Lavender)

/** One on-device model choice in Settings. */
data class ModelOption(val id: String, val name: String, val summary: String, val sizeMb: Long, val status: String, val selected: Boolean, val ready: Boolean, val deletable: Boolean, val license: String)
