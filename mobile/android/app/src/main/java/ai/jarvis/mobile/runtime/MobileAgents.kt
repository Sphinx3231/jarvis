package ai.jarvis.mobile.runtime

import ai.jarvis.mobile.data.ActivityDao
import ai.jarvis.mobile.data.TaskDao
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat

/**
 * The phone-side work of the agents that have any (see AgentCatalog.mobile). Friday, Tom and Trinity
 * need the PC's pipeline and security tooling, so on the phone they are only visible through
 * Remote PC mode — the phone doesn't pretend otherwise.
 */
class MobileAgents(private val context: Context, private val tasks: TaskDao, private val activityDao: ActivityDao, private val registry: MobileToolRegistry, private val permissions: MobilePermissionManager, private val activity: ActivityLog) {
    suspend fun run(agentId: String): String {
        val summary = when (agentId) {
            // Neo: watches the phone's task queue.
            "neo" -> {
                val active = tasks.active()
                val next = active.filter { it.scheduledFor != null }.minByOrNull { it.scheduledFor!! }
                "Watching ${active.size} phone task(s)" + (next?.let { ". Next: “${it.title}” at ${java.time.Instant.ofEpochMilli(it.scheduledFor!!).atZone(java.time.ZoneId.systemDefault()).toLocalTime().withNano(0)}" } ?: "")
            }
            // Sentinel: audits what the phone lets Jarvis do.
            "sentinel" -> {
                val byPolicy = registry.all.groupBy { permissions.policyFor(it) }
                val runtime = listOf(android.Manifest.permission.RECORD_AUDIO, android.Manifest.permission.POST_NOTIFICATIONS, android.Manifest.permission.CAMERA)
                    .filter { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }.map { it.substringAfterLast('.') }
                "${byPolicy[Policy.ALLOW]?.size ?: 0} capabilities run freely, ${byPolicy[Policy.ASK]?.size ?: 0} ask first, ${byPolicy[Policy.DENY]?.size ?: 0} blocked. Android permissions granted: ${runtime.ifEmpty { listOf("none") }.joinToString()}"
            }
            // Echo: digest of the last 24 hours on the phone.
            "echo" -> {
                val day = activityDao.since(System.currentTimeMillis() - 86_400_000)
                val tools = day.count { it.category == "tool" }
                val approvals = day.count { it.category == "approval" }
                val errors = day.count { it.level == "error" }
                "Last 24 h on the phone: $tools action(s), $approvals approval decision(s), $errors error(s)"
            }
            else -> throw IllegalArgumentException("$agentId has no phone-side work; use Remote PC mode")
        }
        activity.log("info", "agent", "${agentId.replaceFirstChar { it.uppercase() }} (phone): $summary")
        return summary
    }
}
