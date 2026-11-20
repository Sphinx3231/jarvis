package ai.jarvis.mobile.ui

import ai.jarvis.mobile.AppContainer
import ai.jarvis.mobile.data.Mode
import ai.jarvis.mobile.data.ProviderConfig
import ai.jarvis.mobile.remote.PairingUri
import ai.jarvis.mobile.remote.RemoteSession
import ai.jarvis.mobile.runtime.ModelRequest
import ai.jarvis.mobile.runtime.Policy
import ai.jarvis.mobile.runtime.Risk
import ai.jarvis.mobile.runtime.Turn
import ai.jarvis.mobile.ui.components.JarvisBackdrop
import ai.jarvis.mobile.ui.screens.ActivityScreen
import ai.jarvis.mobile.ui.screens.AgentDetailScreen
import ai.jarvis.mobile.ui.screens.AgentsScreen
import ai.jarvis.mobile.ui.screens.CapRow
import ai.jarvis.mobile.ui.screens.CapabilitiesScreen
import ai.jarvis.mobile.ui.screens.ChatScreen
import ai.jarvis.mobile.ui.screens.ConversationsScreen
import ai.jarvis.mobile.ui.screens.DevicesScreen
import ai.jarvis.mobile.ui.screens.DevicesView
import ai.jarvis.mobile.ui.screens.HomeScreen
import ai.jarvis.mobile.ui.screens.OnboardingScreen
import ai.jarvis.mobile.ui.screens.PermRow
import ai.jarvis.mobile.ui.screens.SettingsScreen
import ai.jarvis.mobile.ui.screens.TasksScreen
import ai.jarvis.mobile.ui.theme.J
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Radar
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

private sealed interface Loaded { data object Loading : Loaded; data class Ready(val mode: Mode?) : Loaded }

@OptIn(ExperimentalCoroutinesApi::class)
@Composable
fun JarvisApp(c: AppContainer, deepLink: String?, onDeepLinkHandled: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val loaded by remember { c.prefs.mode.map<Mode?, Loaded> { Loaded.Ready(it) } }.collectAsState(Loaded.Loading)
    val mode = (loaded as? Loaded.Ready)?.mode

    JarvisBackdrop {
        when {
            loaded == Loaded.Loading -> Unit
            mode == null -> Box(Modifier.systemBarsPadding()) { OnboardingScreen { m -> scope.launch { c.prefs.setMode(m) } } }
            else -> Main(c, mode, deepLink, onDeepLinkHandled)
        }
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
@Composable
private fun Main(c: AppContainer, mode: Mode, deepLink: String?, onDeepLinkHandled: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val nav = rememberNavController()
    val setMode: (Mode) -> Unit = { m -> scope.launch { c.prefs.setMode(m) } }

    // ---- live state ------------------------------------------------------------------------
    val remote = if (mode == Mode.REMOTE_PC) c.remote else null
    val remoteState by (remote?.state ?: remember { kotlinx.coroutines.flow.MutableStateFlow(RemoteSession.State()) }).collectAsState()
    val mobileState by c.mobile.state.collectAsState()
    val routerStatus by c.router.status.collectAsState()
    val speech by c.speech.state.collectAsState()
    val provider by c.prefs.provider.collectAsState(ProviderConfig())
    val speakReplies by c.prefs.speakReplies.collectAsState(true)
    val policies by c.prefs.policies.collectAsState(emptyMap())
    val mobileTasks by remember { c.tasks.all() }.collectAsState(emptyList())
    val activity by remember { c.db.activity().recent() }.collectAsState(emptyList())
    val history by remember { c.conversations.recent() }.collectAsState(emptyList())
    val pendingMobile by c.permissions.pending.collectAsState()
    val messages by remember { c.mobile.state.map { it.conversationId }.flatMapLatest { id -> if (id == null) flowOf(emptyList()) else c.conversations.messages(id) } }.collectAsState(emptyList())
    val agentResults = remember { mutableStateMapOf<String, String>() }
    var keyTick by remember { mutableIntStateOf(0) }
    var permTick by remember { mutableIntStateOf(0) }
    var providerTest by remember { mutableStateOf<String?>(null) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { permTick++ }

    val hasKey = remember(keyTick) { c.secrets.has(AppContainer.API_KEY) }
    val providerLabel = when (provider.kind) {
        "anthropic" -> if (hasKey && provider.model.isNotBlank()) "Anthropic · ${provider.model}" else null
        "openai_compatible" -> if (provider.baseUrl.isNotBlank() && provider.model.isNotBlank()) "${runCatching { Uri.parse(provider.baseUrl).host }.getOrNull()} · ${provider.model}" else null
        else -> null
    }
    val view = if (mode == Mode.REMOTE_PC) remoteHome(remoteState)
    else mobileHome(routerStatus, mobileState.busy, providerLabel, agentResults, mobileTasks, pendingMobile.map { ApprovalView(it.id, it.title, it.summary, null) }, messages, speech.listening)

    // ---- actions ---------------------------------------------------------------------------
    val submit: (String, String) -> Unit = { text, via -> if (mode == Mode.REMOTE_PC) remote?.submit(text, via) else c.mobile.submit(text, via) }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        permTick++
        if (ok) c.speech.start { submit(it, "voice") } else Toast.makeText(ctx, "Voice needs the microphone permission", Toast.LENGTH_SHORT).show()
    }
    val onMic = {
        when {
            speech.listening -> c.speech.stop()
            !c.speech.available() -> Toast.makeText(ctx, "No speech recognition service on this phone", Toast.LENGTH_LONG).show()
            granted(ctx, Manifest.permission.RECORD_AUDIO) -> c.speech.start { submit(it, "voice") }
            else -> micPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
    val requestPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { permTick++ }
    val onApproval: (String, Boolean) -> Unit = { id, ok -> if (mode == Mode.REMOTE_PC) remote?.resolveApproval(id, ok) else c.permissions.resolve(id, ok) }

    // Speak the PC's reply to a voice command (Mobile mode speaks in MobileSession).
    val lastRemote = remoteState.chat.lastOrNull()
    LaunchedEffect(lastRemote?.id) {
        if (lastRemote != null && lastRemote.role == "assistant" && speakReplies) {
            val prompt = remoteState.chat.dropLast(1).lastOrNull { it.role == "user" }
            if (prompt?.via == "voice" && System.currentTimeMillis() - lastRemote.ts < 60_000) c.speaker.speak(lastRemote.text)
        }
    }

    // ---- pairing (QR or jarvis:// link) — always confirmed by the user -----------------------
    var pairCandidate by remember { mutableStateOf<String?>(null) }
    var pairing by remember { mutableStateOf(false) }
    var pairError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(deepLink) { if (deepLink != null) { pairCandidate = deepLink; onDeepLinkHandled() } }
    val scan = rememberLauncherForActivityResult(ScanContract()) { r -> r.contents?.let { if (it.startsWith("jarvis://pair")) pairCandidate = it else pairError = "That QR code isn't a Jarvis pairing code." } }
    pairCandidate?.let { link ->
        val parsed = runCatching { PairingUri.parse(link) }
        AlertDialog(
            onDismissRequest = { pairCandidate = null },
            containerColor = J.Bg2,
            title = { Text("Pair with your PC?") },
            text = { Text(parsed.fold({ "PC: ${it.name}\nRelay: ${it.relay}\n\nThis phone will be able to send commands to that PC's Jarvis. The PC still applies its own approvals and safety rules." }, { "This link isn't valid: ${it.message}" })) },
            confirmButton = {
                TextButton(enabled = parsed.isSuccess, onClick = {
                    pairCandidate = null
                    pairing = true
                    pairError = null
                    scope.launch {
                        if (mode != Mode.REMOTE_PC) c.prefs.setMode(Mode.REMOTE_PC)
                        c.remote.pair(link).onFailure { pairError = it.message ?: "Pairing failed" }.onSuccess { nav.navigate("home") }
                        pairing = false
                    }
                }) { Text("Pair") }
            },
            dismissButton = { TextButton(onClick = { pairCandidate = null }) { Text("Cancel") } },
        )
    }

    // ---- confirmations -----------------------------------------------------------------------
    var confirmStop by remember { mutableStateOf(false) }
    if (confirmStop) AlertDialog(
        onDismissRequest = { confirmStop = false }, containerColor = J.Bg2,
        title = { Text("Emergency stop?") },
        text = { Text("Cancels every active task on your PC and stops Computer Access.") },
        confirmButton = { TextButton(onClick = { confirmStop = false; remote?.emergencyStop() }) { Text("Stop everything", color = J.Bad) } },
        dismissButton = { TextButton(onClick = { confirmStop = false }) { Text("Cancel") } },
    )
    // A Mobile-mode action that asks first: the router is suspended until the user answers here.
    pendingMobile.firstOrNull()?.let { p ->
        AlertDialog(
            onDismissRequest = {}, containerColor = J.Bg2,
            title = { Text(p.title) },
            text = { Text("Mobile Jarvis wants to:\n${p.summary}\n\nNothing happens unless you approve.") },
            confirmButton = { TextButton(onClick = { c.permissions.resolve(p.id, true) }) { Text("Approve", color = J.Ok) } },
            dismissButton = { TextButton(onClick = { c.permissions.resolve(p.id, false) }) { Text("Deny", color = J.Bad) } },
        )
    }

    // ---- layout ------------------------------------------------------------------------------
    Column(Modifier.fillMaxSize().systemBarsPadding()) {
        Box(Modifier.weight(1f)) {
            NavHost(nav, startDestination = "home") {
                composable("home") {
                    HomeScreen(view, speech.listening, speech.partial, setMode, { submit(it, "text") }, onMic, { nav.navigate("agent/$it") }, onApproval, { nav.navigate("chat") }, { nav.navigate("tasks") }, if (mode == Mode.REMOTE_PC && remoteState.paired != null) ({ confirmStop = true }) else null)
                }
                composable("chat") {
                    ChatScreen(view, speech.listening, speech.partial, { submit(it, "text") }, onMic, { id -> remote?.redeliver(id) }, { if (mode == Mode.REMOTE_PC) remote?.newConversation() else c.mobile.open(null) }, if (mode == Mode.MOBILE) ({ nav.navigate("history") }) else null)
                }
                composable("agents") { AgentsScreen(mode, view.agents) { nav.navigate("agent/$it") } }
                composable("agent/{id}") { entry ->
                    val id = entry.arguments?.getString("id") ?: return@composable
                    val agent = view.agents.firstOrNull { it.id == id } ?: return@composable
                    AgentDetailScreen(mode, agent, agentResults[id], onRun = {
                        if (mode == Mode.REMOTE_PC) { remote?.runAgent(id); agentResults[id] = "Requested on the PC — its report appears above when it finishes." }
                        else scope.launch { agentResults[id] = runCatching { c.agents.run(id) }.getOrElse { "Failed: ${it.message}" } }
                    }, onBack = { nav.popBackStack() })
                }
                composable("tasks") {
                    TasksScreen(mode, view.tasks, view.approvals, { id -> if (mode == Mode.REMOTE_PC) remote?.cancelTask(id) else scope.launch { c.tasks.cancel(id) } }, onApproval)
                }
                composable("activity") { ActivityScreen(activity, if (mode == Mode.REMOTE_PC) "What happened on this phone. Your PC keeps its own audit log." else "Everything Mobile Jarvis did on this phone") }
                composable("history") { ConversationsScreen(history, { c.mobile.open(it); nav.navigate("chat") }, { nav.popBackStack() }) }
                composable("devices") {
                    val phoneId = remember(remoteState.paired) { if (remoteState.paired != null || mode == Mode.REMOTE_PC) runCatching { c.identity.deviceId }.getOrNull() else null }
                    DevicesScreen(
                        DevicesView(remoteState.paired, remoteConnection(remoteState), phoneId, pairing, pairError ?: remoteState.lastError?.takeIf { remoteState.paired == null },
                            remoteState.lastStop?.let { "PC stopped: ${it.cancelledTasks} task(s) cancelled${if (it.computerAccessStopped) ", Computer Access stopped" else ""}." }),
                        onScan = { scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the pairing code on your PC").setBeepEnabled(false).setOrientationLocked(false)) },
                        onPairLink = { pairCandidate = it },
                        onUnpair = { scope.launch { c.remote.unpair() } },
                        onStop = { confirmStop = true },
                        onRefresh = { remote?.refresh() },
                    )
                }
                composable("capabilities") {
                    val caps = c.registry.all.map { t ->
                        val av = t.availability(ctx)
                        val policy = policies[t.name]?.let { runCatching { Policy.valueOf(it) }.getOrNull() } ?: if (t.risk == Risk.READ) Policy.ALLOW else Policy.ASK
                        CapRow(t.name, t.title, t.description, t.risk, policy, av.available, av.reason)
                    }
                    val perms = remember(permTick) {
                        buildList {
                            add(PermRow(Manifest.permission.RECORD_AUDIO, "Microphone", "Push-to-talk voice commands", granted(ctx, Manifest.permission.RECORD_AUDIO)))
                            add(PermRow(Manifest.permission.CAMERA, "Camera", "Scanning the PC's pairing QR code", granted(ctx, Manifest.permission.CAMERA)))
                            if (Build.VERSION.SDK_INT >= 33) add(PermRow(Manifest.permission.POST_NOTIFICATIONS, "Notifications", "Reminders and notices", granted(ctx, Manifest.permission.POST_NOTIFICATIONS)))
                        }
                    }
                    CapabilitiesScreen(caps, perms, { tool, p -> scope.launch { c.prefs.setPolicy(tool, p.name) } }, { requestPermission.launch(it) }) {
                        ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null)))
                    }
                }
                composable("settings") {
                    SettingsScreen(mode, provider, hasKey, speakReplies, providerTest, setMode,
                        onSave = { cfg, key -> scope.launch { c.prefs.setProvider(cfg); if (key != null) c.secrets.set(AppContainer.API_KEY, key); keyTick++; providerTest = "Saved." } },
                        onClearKey = { c.secrets.set(AppContainer.API_KEY, null); keyTick++ },
                        onTest = {
                            providerTest = "Testing…"
                            scope.launch {
                                val p = c.provider()
                                providerTest = if (p == null) "Not configured yet — fill in the fields and press Save first."
                                else runCatching { withTimeout(30_000) { p.complete(ModelRequest("Reply with the single word OK.", listOf(Turn.User("ping")), emptyList(), 16)) } }
                                    .fold({ "OK — the model replied: “${it.text.take(60)}”" }, { "Failed: ${it.message?.take(200)}" })
                            }
                        },
                        onSpeak = { on -> scope.launch { c.prefs.setSpeakReplies(on) } },
                        onOpen = { nav.navigate(it) })
                }
            }
        }
        BottomNav(nav)
    }
}

@Composable
private fun BottomNav(nav: NavHostController) {
    val current = nav.currentBackStackEntryAsState().value?.destination?.route
    NavigationBar(containerColor = Color(0xF00A0716), tonalElevation = androidx.compose.ui.unit.Dp(0f)) {
        listOf(
            Triple("home", "Core", Icons.Filled.Radar), Triple("chat", "Chat", Icons.Filled.Chat), Triple("agents", "Agents", Icons.Filled.Hub),
            Triple("tasks", "Tasks", Icons.Filled.Checklist), Triple("settings", "System", Icons.Filled.Tune),
        ).forEach { (route, label, icon) ->
            NavigationBarItem(
                selected = current == route,
                onClick = { if (current != route) nav.navigate(route) { popUpTo("home") { saveState = true }; launchSingleTop = true; restoreState = true } },
                icon = { Icon(icon, label) },
                label = { Text(label.uppercase(), fontSize = 10.sp, letterSpacing = 1.sp) },
                colors = NavigationBarItemDefaults.colors(selectedIconColor = Color.White, selectedTextColor = J.Lavender, indicatorColor = J.PurpleDeep, unselectedIconColor = J.TextDim, unselectedTextColor = J.TextFaint),
            )
        }
    }
}

private fun granted(ctx: android.content.Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED
