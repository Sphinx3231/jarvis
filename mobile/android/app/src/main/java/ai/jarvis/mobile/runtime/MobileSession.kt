package ai.jarvis.mobile.runtime

import ai.jarvis.mobile.voice.Speaker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Mobile Jarvis's conversation front door: one command at a time, in the app's scope (so a reply
 * still lands if the screen rotates), persisted to Room by the router.
 */
class MobileSession(
    private val scope: CoroutineScope,
    private val router: MobileExecutionRouter,
    private val activity: ActivityLog,
    private val speaker: Speaker,
    private val speakReplies: () -> Boolean,
) {
    data class State(
        val conversationId: String? = null,
        val busy: Boolean = false,
        val lastHandledBy: String? = null,
        val lastError: String? = null,
        /** The last answer, and whether that request operated other apps (shown over them when done). */
        val lastReply: String? = null,
        val usedPhone: Boolean = false,
        val replySeen: Boolean = true,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state
    private val lock = Mutex()

    fun open(conversationId: String?) = _state.update { it.copy(conversationId = conversationId, lastError = null) }

    private var job: kotlinx.coroutines.Job? = null

    /** Stop the request in progress (the STOP button); anything waiting for approval is denied. */
    fun cancel(reason: String) {
        job?.cancel(kotlinx.coroutines.CancellationException(reason))
    }

    fun markReplySeen() = _state.update { it.copy(replySeen = true) }

    fun submit(text: String, via: String = "text") {
        val clean = text.trim()
        if (clean.isEmpty()) return
        job = scope.launch {
            lock.withLock {
                _state.update { it.copy(busy = true, lastError = null) }
                ai.jarvis.mobile.control.PhoneControl.inUse.value = false
                try {
                    val r = router.handle(_state.value.conversationId, clean)
                    val usedPhone = r.toolsUsed.any { it.startsWith("screen_") || it == "app_launch" }
                    _state.update { it.copy(conversationId = r.conversationId, busy = false, lastHandledBy = r.handledBy, lastReply = r.text, usedPhone = usedPhone, replySeen = !usedPhone) }
                    if (via == "voice" && speakReplies()) speaker.speak(r.text)
                } catch (e: kotlinx.coroutines.CancellationException) {
                    activity.log("warning", "tool", "Stopped: ${e.message}")
                    _state.update { it.copy(busy = false, lastError = "Stopped", lastReply = "Stopped.", replySeen = true) }
                } catch (e: Exception) {
                    activity.log("error", "provider", "Command failed: ${e.message}")
                    _state.update { it.copy(busy = false, lastError = e.message ?: e.javaClass.simpleName) }
                } finally {
                    ai.jarvis.mobile.control.PhoneControl.inUse.value = false
                }
            }
        }
    }
}
