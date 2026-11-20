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
    data class State(val conversationId: String? = null, val busy: Boolean = false, val lastHandledBy: String? = null, val lastError: String? = null)

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state
    private val lock = Mutex()

    fun open(conversationId: String?) = _state.update { it.copy(conversationId = conversationId, lastError = null) }

    fun submit(text: String, via: String = "text") {
        val clean = text.trim()
        if (clean.isEmpty()) return
        scope.launch {
            lock.withLock {
                _state.update { it.copy(busy = true, lastError = null) }
                try {
                    val r = router.handle(_state.value.conversationId, clean)
                    _state.update { it.copy(conversationId = r.conversationId, busy = false, lastHandledBy = r.handledBy) }
                    if (via == "voice" && speakReplies()) speaker.speak(r.text)
                } catch (e: Exception) {
                    activity.log("error", "provider", "Command failed: ${e.message}")
                    _state.update { it.copy(busy = false, lastError = e.message ?: e.javaClass.simpleName) }
                }
            }
        }
    }
}
