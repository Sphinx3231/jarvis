package ai.jarvis.mobile.runtime

import ai.jarvis.mobile.data.ActivityDao
import ai.jarvis.mobile.data.ActivityEntity
import ai.jarvis.mobile.crypto.E2E
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject

enum class Policy { ALLOW, ASK, DENY }

data class PendingApproval(val id: String, val tool: String, val title: String, val summary: String, val createdAt: Long)

/**
 * Mobile Jarvis's authorization layer. Every tool call passes here, independently of what the model
 * asked for: the policy (allow / ask / deny, set by the user per capability) decides, and "ask"
 * waits for the user's tap on the approval card. The model has no way to approve anything. Every
 * decision is written to the activity log.
 */
class MobilePermissionManager(private val activity: ActivityDao, private val policyOverrides: () -> Map<String, String>) {
    private val _pending = MutableStateFlow<List<PendingApproval>>(emptyList())
    val pending: StateFlow<List<PendingApproval>> = _pending
    private val waiters = HashMap<String, CompletableDeferred<Boolean>>()

    fun policyFor(tool: MobileTool, args: JsonObject = JsonObject(emptyMap())): Policy = policyOverrides()[tool.name]?.let { runCatching { Policy.valueOf(it) }.getOrNull() }
        ?: if (tool.riskFor(args) == Risk.READ) Policy.ALLOW else Policy.ASK

    sealed interface Decision {
        data object Allowed : Decision
        data class Denied(val reason: String) : Decision
    }

    suspend fun authorize(tool: MobileTool, args: JsonObject, timeoutMs: Long = 120_000): Decision {
        val summary = tool.summarize(args)
        return when (policyFor(tool, args)) {
            Policy.DENY -> Decision.Denied("Blocked by your setting for ${tool.title}").also { log("warning", "Blocked: $summary") }
            Policy.ALLOW -> Decision.Allowed
            Policy.ASK -> {
                val id = E2E.randomId("apr_", 6)
                val d = CompletableDeferred<Boolean>()
                synchronized(waiters) { waiters[id] = d }
                _pending.update { it + PendingApproval(id, tool.name, tool.title, summary, System.currentTimeMillis()) }
                val ok = withTimeoutOrNull(timeoutMs) { d.await() }
                synchronized(waiters) { waiters.remove(id) }
                _pending.update { l -> l.filter { it.id != id } }
                when (ok) {
                    true -> Decision.Allowed.also { log("success", "Approved: $summary") }
                    false -> Decision.Denied("You declined").also { log("info", "Declined: $summary") }
                    null -> Decision.Denied("No answer within ${timeoutMs / 1000} s").also { log("warning", "Approval timed out: $summary") }
                }
            }
        }
    }

    /** Only the UI calls this — the user's tap. */
    fun resolve(id: String, approve: Boolean) {
        synchronized(waiters) { waiters[id] }?.complete(approve)
    }

    private suspend fun log(level: String, message: String) = activity.insert(ActivityEntity(ts = System.currentTimeMillis(), level = level, category = "approval", message = message))
}
