package ai.jarvis.mobile.remote

import ai.jarvis.mobile.crypto.DeviceIdentity
import ai.jarvis.mobile.crypto.E2E
import ai.jarvis.mobile.protocol.Frames
import ai.jarvis.mobile.protocol.str
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.URI
import kotlin.math.min

/** wss:// is required, except loopback / private-network addresses during development. */
fun relayUrlProblem(url: String): String? {
    val u = try { URI(url) } catch (e: Exception) { return "Not a valid URL" }
    if (u.scheme == "wss") return null
    if (u.scheme != "ws") return "The relay URL must start with wss://"
    val h = u.host ?: return "Missing host"
    val local = h == "localhost" || h == "127.0.0.1" || h == "::1" || h.startsWith("10.") || h.startsWith("192.168.") ||
        Regex("^172\\.(1[6-9]|2\\d|3[01])\\.").containsMatchIn(h)
    return if (local) null else "Unencrypted ws:// is only allowed on your local network; use wss://"
}

/**
 * An outbound, authenticated WebSocket to the Jarvis relay (OkHttp). Proves the device identity
 * with a Keystore signature, then exposes relay frames. Reconnects with backoff while started.
 */
class RelayConnection(private val http: OkHttpClient, private val identity: DeviceIdentity, private val scope: CoroutineScope) {
    enum class State { IDLE, CONNECTING, CONNECTED, ERROR }
    data class Status(val state: State, val detail: String)

    private val _status = MutableStateFlow(Status(State.IDLE, "Not connected"))
    val status: StateFlow<Status> = _status
    private val _frames = MutableSharedFlow<JsonObject>(extraBufferCapacity = 256)
    val frames: SharedFlow<JsonObject> = _frames

    @Volatile var url: String? = null
        private set
    @Volatile private var ws: WebSocket? = null
    @Volatile private var started = false
    private var attempt = 0
    private var retryJob: Job? = null
    private var generation = 0

    fun start(relayUrl: String) {
        if (started && url == relayUrl) return
        stop()
        url = relayUrl
        started = true
        connect()
    }

    fun stop() {
        started = false
        generation++
        retryJob?.cancel()
        ws?.close(1000, "stopped")
        ws = null
        _status.value = Status(State.IDLE, "Not connected")
    }

    /**
     * Skip the backoff wait and reconnect now (app opened, network came back). No-op while connected
     * or when no PC is paired; the pairing itself is never touched here.
     */
    fun reconnectNow() {
        if (!started || _status.value.state == State.CONNECTED || _status.value.state == State.CONNECTING) return
        retryJob?.cancel()
        attempt = 0
        ws?.cancel()
        ws = null
        connect()
    }

    fun send(text: String): Boolean {
        if (_status.value.state != State.CONNECTED) return false
        return ws?.send(text) ?: false
    }

    private fun connect() {
        val target = url ?: return
        relayUrlProblem(target)?.let { _status.value = Status(State.ERROR, it); return }
        val gen = ++generation
        _status.value = Status(State.CONNECTING, "Connecting to ${URI(target).host}…")
        ws = http.newWebSocket(Request.Builder().url(target).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(Frames.hello("phone", identity.deviceId, identity.signPubB64))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (gen != generation) return
                val f = try { Frames.parse(text) } catch (e: Exception) { return }
                when (f.str("t")) {
                    "challenge" -> webSocket.send(Frames.auth(identity.sign(E2E.relayAuthMessage(f.str("nonce") ?: "", identity.deviceId))))
                    "ready" -> {
                        attempt = 0
                        _status.value = Status(State.CONNECTED, "Connected to ${URI(target).host}")
                        _frames.tryEmit(f)
                    }
                    else -> _frames.tryEmit(f)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = retry(gen, reason.ifBlank { "closed ($code)" })
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = retry(gen, t.message ?: t.javaClass.simpleName)
        })
    }

    private fun retry(gen: Int, why: String) {
        if (gen != generation || !started) return
        val delayMs = (min(30_000L, 1000L shl attempt) * (0.75 + Math.random() * 0.5)).toLong()
        attempt = min(attempt + 1, 6)
        _status.value = Status(State.ERROR, "Relay unreachable ($why); retrying in ${delayMs / 1000} s")
        retryJob?.cancel()
        retryJob = scope.launch {
            delay(delayMs)
            if (gen == generation && started) connect()
        }
    }
}
