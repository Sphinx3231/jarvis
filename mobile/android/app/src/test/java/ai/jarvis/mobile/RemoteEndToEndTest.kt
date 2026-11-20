package ai.jarvis.mobile

import ai.jarvis.mobile.crypto.SoftwareIdentity
import ai.jarvis.mobile.remote.PairedPc
import ai.jarvis.mobile.remote.PairingStore
import ai.jarvis.mobile.remote.RelayConnection
import ai.jarvis.mobile.remote.RemoteSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * Cross-language end-to-end: this Kotlin client ↔ the real relay ↔ the real PC Jarvis.
 * Run by mobile/scripts/remote-e2e.ts, which starts the relay and Jarvis, passes the pairing link
 * in JARVIS_E2E_PAIRING, creates an approval-needing task when the phone pairs, and afterwards
 * checks on the PC that each command ran exactly once.
 */
class RemoteEndToEndTest {
    private class MemoryStore : PairingStore {
        var pc: PairedPc? = null
        override suspend fun load() = pc
        override suspend fun save(pc: PairedPc?) { this.pc = pc }
    }

    @Test fun phoneDrivesPcJarvisThroughTheRelay() = runBlocking {
        val uri = System.getenv("JARVIS_E2E_PAIRING")
        assumeTrue("set by mobile/scripts/remote-e2e.ts", !uri.isNullOrBlank())
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
        val identity = SoftwareIdentity.generate()
        val store = MemoryStore()
        val relay = RelayConnection(http, identity, scope)
        val session = RemoteSession(identity, relay, store, scope, deviceName = "Kotlin E2E phone")
        try {
            // 1. Pair from the QR link (E2E with the one-time secret; PC identity pinned).
            val pc = session.pair(uri!!).getOrThrow()
            assertEquals(pc, store.pc)
            withTimeout(15_000) { session.state.first { it.pcOnline && it.agents.size == 6 } }
            assertEquals(setOf("friday", "tom", "neo", "sentinel", "echo", "trinity"), session.state.value.agents.map { it.id }.toSet())

            // 2. A command: ACCEPTED by the PC, then COMPLETED with the PC's reply.
            val item = session.submit("remember that the Kotlin phone test works")
            withTimeout(20_000) { session.state.first { s -> s.chat.any { it.id == item && it.status == RemoteSession.ItemStatus.COMPLETED } } }
            val reply = session.state.value.chat.last { it.role == "assistant" }
            assertTrue(reply.text, reply.text.contains("remember", ignoreCase = true))
            assertTrue(reply.actions.any { it.type == "memory_saved" })

            // 3. Voice: a transcript from the phone's recogniser runs as a voice command.
            val spoken = session.submit("remember that voice from the phone arrives", via = "voice")
            withTimeout(20_000) { session.state.first { s -> s.chat.any { it.id == spoken && it.status == RemoteSession.ItemStatus.COMPLETED } } }

            // 4. Duplicate delivery after a "reconnect": same idempotency key, never re-executed.
            val assistantBefore = session.state.value.chat.count { it.role == "assistant" }
            session.redeliver(item)
            withTimeout(10_000) { session.state.first { it.duplicatesAnswered >= 1 } }
            assertEquals("the duplicate reply is not shown twice", assistantBefore, session.state.value.chat.count { it.role == "assistant" })

            // 5. The harness created a task nobody asked for: it waits for approval; approve it here.
            val approval = withTimeout(20_000) { session.state.first { it.approvals.isNotEmpty() } }.approvals.first()
            assertTrue(approval.summary, approval.summary.contains("from-kotlin"))
            session.resolveApproval(approval.id, approve = true)
            withTimeout(20_000) { session.state.first { s -> s.approvals.none { it.id == approval.id } && s.tasks.any { it.title == "Kotlin approval check" && it.status == "completed" } } }

            // 6. Emergency stop reaches the PC and reports back.
            session.emergencyStop("E2E stop")
            assertNotNull(withTimeout(10_000) { session.state.first { it.lastStop != null } }.lastStop)
        } finally {
            relay.stop()
            scope.cancel()
            http.dispatcher.executorService.shutdown()
        }
    }
}
