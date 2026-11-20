package ai.jarvis.mobile.runtime

import ai.jarvis.mobile.crypto.E2E
import ai.jarvis.mobile.data.ActivityDao
import ai.jarvis.mobile.data.ActivityEntity
import ai.jarvis.mobile.data.ConversationDao
import ai.jarvis.mobile.data.ConversationEntity
import ai.jarvis.mobile.data.MemoryDao
import ai.jarvis.mobile.data.MemoryEntity
import ai.jarvis.mobile.data.MessageEntity
import ai.jarvis.mobile.data.MobileTaskEntity
import ai.jarvis.mobile.data.TaskDao
import ai.jarvis.mobile.runtime.tools.Notifications
import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

class ActivityLog(private val dao: ActivityDao) {
    suspend fun log(level: String, category: String, message: String) = dao.insert(ActivityEntity(ts = System.currentTimeMillis(), level = level, category = category, message = message.take(500)))
}

/** Mobile Jarvis's own memory, on the phone (Room + FTS). Never uploaded unless the user turns on sync. */
class MobileMemoryManager(private val dao: MemoryDao, private val activity: ActivityLog, private val onRemembered: (suspend (kind: String, content: String) -> Unit)? = null) {
    /** Store a memory; an identical one is refreshed instead of duplicated. Returns (memory, merged). */
    suspend fun remember(content: String, kind: String, source: String): Pair<MemoryEntity, Boolean> {
        val text = content.trim().take(1000)
        require(text.isNotEmpty()) { "Nothing to remember" }
        val now = System.currentTimeMillis()
        dao.exact(text, kind)?.let { existing ->
            val m = existing.copy(updatedAt = now)
            dao.update(m)
            return m to true
        }
        val id = dao.insert(MemoryEntity(kind = kind, content = text, source = source, createdAt = now, updatedAt = now))
        activity.log("info", "memory", "Remembered ($kind): ${text.take(80)}")
        onRemembered?.let { runCatching { it(kind, text) } }
        return MemoryEntity(id, kind, text, source, now, now) to false
    }

    /** Full-text search (FTS4), words OR'ed, short/stop words dropped. */
    suspend fun search(query: String, limit: Int = 6): List<MemoryEntity> {
        val words = Regex("[\\p{L}\\p{N}]{3,}").findAll(query.lowercase()).map { it.value }.filter { it !in STOP }.distinct().take(12).toList()
        if (words.isEmpty()) return emptyList()
        return runCatching { dao.search(words.joinToString(" OR ") { "$it*" }, limit) }.getOrDefault(emptyList())
    }

    /** Rules and preferences go into every turn (they are standing instructions). */
    suspend fun standing(): List<MemoryEntity> = dao.byKind("rule", 30) + dao.byKind("preference", 20)

    companion object {
        private val STOP = setOf("the", "and", "for", "you", "that", "this", "with", "what", "are", "was", "have", "has", "can", "about", "from", "your", "please", "jarvis")
    }
}

/** Conversations on the phone. */
class MobileConversationManager(private val dao: ConversationDao) {
    suspend fun ensure(id: String?, firstText: String): String {
        if (id != null && dao.get(id) != null) return id
        val c = ConversationEntity(E2E.randomId("mcv_", 8), firstText.replace(Regex("\\s+"), " ").take(60), System.currentTimeMillis(), System.currentTimeMillis())
        dao.upsert(c)
        return c.id
    }

    suspend fun add(conversationId: String, role: String, content: String, meta: String = "{}") {
        dao.insertMessage(MessageEntity(E2E.randomId("mmsg_", 8), conversationId, role, content, System.currentTimeMillis(), meta))
        dao.get(conversationId)?.let { dao.upsert(it.copy(updatedAt = System.currentTimeMillis())) }
    }

    suspend fun history(conversationId: String, limit: Int = 16): List<MessageEntity> = dao.lastMessages(conversationId, limit).reversed()
    fun messages(conversationId: String) = dao.messages(conversationId)
    fun recent() = dao.recent()
    suspend fun title(id: String): String? = dao.get(id)?.title
}

/**
 * Tasks on the phone. Scheduled work goes through WorkManager, so it survives the app being
 * closed, killed or the phone rebooting (within Android's background limits — WorkManager may
 * run it a little late under Doze; it's not an exact alarm).
 */
class MobileTaskManager(private val context: Context, private val dao: TaskDao, private val activity: ActivityLog) {
    suspend fun scheduleReminder(text: String, delayMs: Long): MobileTaskEntity {
        val now = System.currentTimeMillis()
        val id = E2E.randomId("mtk_", 8)
        val t = MobileTaskEntity(id, text.take(300), "reminder", "scheduled", now + delayMs, now, now, workId = id)
        dao.upsert(t)
        val req = OneTimeWorkRequestBuilder<ReminderWorker>().setInitialDelay(delayMs, TimeUnit.MILLISECONDS).setInputData(workDataOf("taskId" to id)).addTag("jarvis-task").build()
        WorkManager.getInstance(context).enqueueUniqueWork(id, ExistingWorkPolicy.REPLACE, req)
        activity.log("info", "task", "Reminder scheduled in ${delayMs / 60_000} min: ${text.take(80)}")
        return t
    }

    suspend fun cancel(id: String) {
        val t = dao.get(id) ?: return
        WorkManager.getInstance(context).cancelUniqueWork(id)
        dao.upsert(t.copy(status = "cancelled", updatedAt = System.currentTimeMillis()))
        activity.log("info", "task", "Cancelled: ${t.title}")
    }

    suspend fun record(title: String, kind: String, result: String?, error: String?): MobileTaskEntity {
        val now = System.currentTimeMillis()
        val t = MobileTaskEntity(E2E.randomId("mtk_", 8), title, kind, if (error == null) "completed" else "failed", null, now, now, result, error)
        dao.upsert(t)
        return t
    }

    suspend fun activeNow() = dao.active()
    fun all() = dao.all()
}

/** Runs a scheduled reminder: posts the notification and marks the task completed. Retried by WorkManager if interrupted. */
class ReminderWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        val container = (applicationContext as? ai.jarvis.mobile.JarvisApplication)?.container ?: return Result.retry()
        val id = inputData.getString("taskId") ?: return Result.failure()
        val t = container.db.tasks().get(id) ?: return Result.success()
        if (t.status != "scheduled") return Result.success()
        return try {
            Notifications.post(applicationContext, "Jarvis reminder", t.title)
            container.db.tasks().upsert(t.copy(status = "completed", result = "Reminded", updatedAt = System.currentTimeMillis()))
            container.activity.log("success", "task", "Reminded: ${t.title}")
            Result.success()
        } catch (e: Exception) {
            container.activity.log("error", "task", "Reminder failed: ${e.message}")
            Result.retry()
        }
    }
}
