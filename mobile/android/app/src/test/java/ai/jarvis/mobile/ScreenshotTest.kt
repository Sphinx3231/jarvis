package ai.jarvis.mobile

import ai.jarvis.mobile.data.ActivityEntity
import ai.jarvis.mobile.data.MessageEntity
import ai.jarvis.mobile.data.MobileTaskEntity
import ai.jarvis.mobile.data.Mode
import ai.jarvis.mobile.data.ProviderConfig
import ai.jarvis.mobile.protocol.AgentStatus
import ai.jarvis.mobile.protocol.ApprovalSummary
import ai.jarvis.mobile.protocol.TaskSummary
import ai.jarvis.mobile.remote.PairedPc
import ai.jarvis.mobile.remote.RelayConnection
import ai.jarvis.mobile.remote.RemoteSession
import ai.jarvis.mobile.runtime.MobileExecutionRouter
import ai.jarvis.mobile.runtime.Policy
import ai.jarvis.mobile.runtime.Risk
import ai.jarvis.mobile.ui.components.JarvisBackdrop
import ai.jarvis.mobile.ui.mobileHome
import ai.jarvis.mobile.ui.remoteConnection
import ai.jarvis.mobile.ui.remoteHome
import ai.jarvis.mobile.ui.screens.ActivityScreen
import ai.jarvis.mobile.ui.screens.AgentDetailScreen
import ai.jarvis.mobile.ui.screens.AgentsScreen
import ai.jarvis.mobile.ui.screens.CapRow
import ai.jarvis.mobile.ui.screens.CapabilitiesScreen
import ai.jarvis.mobile.ui.screens.ChatScreen
import ai.jarvis.mobile.ui.screens.DevicesScreen
import ai.jarvis.mobile.ui.screens.DevicesView
import ai.jarvis.mobile.ui.screens.HomeScreen
import ai.jarvis.mobile.ui.screens.OnboardingScreen
import ai.jarvis.mobile.ui.screens.PermRow
import ai.jarvis.mobile.ui.screens.SettingsScreen
import ai.jarvis.mobile.ui.screens.TasksScreen
import ai.jarvis.mobile.ui.theme.JarvisTheme
import android.app.Application
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Renders the real screens with SAMPLE state (defined here, in tests only) and saves PNGs to
 * mobile/android/app/screenshots/. There is no emulator in CI, so this is how the UI is inspected.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(application = Application::class, sdk = [34], qualifiers = RobolectricDeviceQualifiers.Pixel7)
class ScreenshotTest {
    @get:Rule val compose = createComposeRule()

    private val now = System.currentTimeMillis()
    private val pc = PairedPc("wss://relay.example.net/v1", "a1b2c3d4e5f6a7b8c9d0", "Workstation", "", "", listOf("observe", "command", "approve", "stop"), now - 86_400_000)
    private val remoteState = RemoteSession.State(
        relay = RelayConnection.Status(RelayConnection.State.CONNECTED, "Connected"),
        paired = pc, pcOnline = true, agentsEnabled = true,
        agents = listOf(
            AgentStatus("friday", "Friday", "#ef4444", "Earnings", "idle", now - 3_600_000, "Earnings up to date", 12),
            AgentStatus("tom", "Tom", "#22d3ee", "Discovery", "working", now, "Scanning programs", 4),
            AgentStatus("neo", "Neo", "#15803d", "Watcher", "idle", now - 600_000, "3 tasks watched", 30),
            AgentStatus("sentinel", "Sentinel", "#f59e0b", "Scope", "idle", null, "", 0),
            AgentStatus("echo", "Echo", "#a855f7", "Digest", "idle", now - 7_200_000, "Daily digest sent", 8),
            AgentStatus("trinity", "Trinity", "#f43f5e", "Security", "idle", null, "", 0),
        ),
        tasks = listOf(
            TaskSummary("t1", "Summarise today's inbox", "running", 0.6, now - 60_000, now),
            TaskSummary("t2", "Rename project screenshots", "awaiting_approval", 0.2, now - 120_000, now - 30_000),
            TaskSummary("t3", "Weekly backup check", "completed", 1.0, now - 3_600_000, now - 3_000_000, result = "All 4 backups verified"),
        ),
        approvals = listOf(ApprovalSummary("a1", "t2", "Rename project screenshots", "Run: rename 42 files in ~/Pictures/project", "Changes files on disk", "shell", now)),
        assistantState = "working", assistantDetail = "Working on: Summarise today's inbox",
        chat = listOf(
            RemoteSession.ChatItem("c1", "user", "Summarise my inbox", RemoteSession.ItemStatus.COMPLETED, now - 70_000),
            RemoteSession.ChatItem("c2", "assistant", "Started a task to summarise today's inbox — I'll report back when it's done.", RemoteSession.ItemStatus.COMPLETED, now - 65_000),
            RemoteSession.ChatItem("c3", "user", "And rename the project screenshots", RemoteSession.ItemStatus.ACCEPTED, now - 20_000, via = "voice"),
            RemoteSession.ChatItem("c4", "user", "Check the backups too", RemoteSession.ItemStatus.WAITING_FOR_PC, now - 5_000),
        ),
    )
    private val mobileView = mobileHome(
        MobileExecutionRouter.Status(), false, "Anthropic · claude-sonnet-5-5",
        mapOf("neo" to "Watching 1 phone task(s). Next: “stretch” at 10:30"),
        listOf(MobileTaskEntity("m1", "Stretch", "reminder", "scheduled", now + 600_000, now, now)),
        emptyList(),
        listOf(
            MessageEntity("u1", "c", "user", "remind me in 10 minutes to stretch", now - 5000),
            MessageEntity("a1", "c", "assistant", "Done — I'll remind you at 10:30 to stretch.", now - 4000, """{"handledBy":"phone (direct command)","tools":["reminder_schedule"]}"""),
        ),
        listening = false,
    )

    private fun shot(name: String, content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent { JarvisTheme { JarvisBackdrop { content() } } }
        compose.mainClock.advanceTimeBy(700)
        compose.onRoot().captureRoboImage("screenshots/$name.png")
    }

    @Test fun onboarding() = shot("01-onboarding") { OnboardingScreen {} }
    @Test fun homeRemote() = shot("02-home-remote-pc") { HomeScreen(remoteHome(remoteState), false, "", {}, {}, {}, {}, { _, _ -> }, {}, {}, {}) }
    @Test fun homeMobile() = shot("03-home-mobile") { HomeScreen(mobileView, false, "", {}, {}, {}, {}, { _, _ -> }, {}, {}, null) }
    @Test fun homeOffline() = shot("04-home-pc-offline") { HomeScreen(remoteHome(remoteState.copy(pcOnline = false, approvals = emptyList(), tasks = emptyList())), false, "", {}, {}, {}, {}, { _, _ -> }, {}, {}, {}) }
    @Test fun chatRemote() = shot("05-chat-remote") { ChatScreen(remoteHome(remoteState), false, "", {}, {}, {}, {}, null) }
    @Test fun chatMobileListening() = shot("06-chat-mobile-listening") { ChatScreen(mobileView.copy(core = ai.jarvis.mobile.ui.components.CoreMode.LISTENING), true, "what's on my", {}, {}, {}, {}, {}) }
    @Test fun agents() = shot("07-agents-mobile") { AgentsScreen(Mode.MOBILE, mobileView.agents) {} }
    @Test fun agentDetail() = shot("08-agent-detail") { AgentDetailScreen(Mode.REMOTE_PC, remoteHome(remoteState).agents[1], null, {}, {}) }
    @Test fun tasks() = shot("09-tasks-remote") { val v = remoteHome(remoteState); TasksScreen(Mode.REMOTE_PC, v.tasks, v.approvals, {}, { _, _ -> }) }
    @Test fun capabilities() = shot("10-capabilities") {
        CapabilitiesScreen(
            listOf(
                CapRow("device_battery", "Battery status", "Read the battery level and charging state", Risk.READ, Policy.ALLOW, true, ""),
                CapRow("phone_dial", "Dial a number", "Open the dialer with a number filled in (you press call)", Risk.ACT, Policy.ASK, true, ""),
                CapRow("notify", "Show a notification", "Post a notification from Jarvis", Risk.ACT, Policy.DENY, false, "Needs the POST_NOTIFICATIONS permission (grant it in Capabilities)"),
            ),
            listOf(PermRow("mic", "Microphone", "Push-to-talk voice commands", true), PermRow("cam", "Camera", "Scanning the PC's pairing QR code", false)),
            { _, _ -> }, {}, {},
        )
    }
    @Test fun devicesUnpaired() = shot("11-devices-unpaired") { DevicesScreen(DevicesView(null, remoteConnection(RemoteSession.State()), null, false, null, null), {}, {}, {}, {}, {}) }
    @Test fun devicesPaired() = shot("12-devices-paired") { DevicesScreen(DevicesView(pc, remoteConnection(remoteState), "f00dfacecafe1234beef", false, null, "PC stopped: 2 task(s) cancelled, Computer Access stopped."), {}, {}, {}, {}, {}) }
    @Test fun settings() = shot("13-settings") { SettingsScreen(Mode.MOBILE, ProviderConfig("anthropic", "", "claude-sonnet-5-5"), true, true, "OK — the model replied: “OK”", {}, { _, _ -> }, {}, {}, {}, {}) }
    @Test fun activity() = shot("14-activity") {
        ActivityScreen(listOf(
            ActivityEntity(3, now, "success", "approval", "Approved: Open https://example.com"),
            ActivityEntity(2, now - 60_000, "warning", "tool", "Blocked: Show a notification"),
            ActivityEntity(1, now - 120_000, "info", "memory", "Remembered: my locker code is on the blue card"),
        ), "Everything Mobile Jarvis did on this phone")
    }
}

