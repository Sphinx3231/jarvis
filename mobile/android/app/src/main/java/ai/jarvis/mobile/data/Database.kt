package ai.jarvis.mobile.data

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Fts4
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

/** Mobile Jarvis's own data, on the phone. PC memory stays on the PC (see docs/MOBILE.md). */

@Entity(tableName = "conversations")
data class ConversationEntity(@PrimaryKey val id: String, val title: String, val createdAt: Long, val updatedAt: Long)

@Entity(tableName = "messages")
data class MessageEntity(
    @PrimaryKey val id: String,
    val conversationId: String,
    /** user | assistant | tool | system */
    val role: String,
    val content: String,
    val createdAt: Long,
    /** JSON: tool calls, tool name, approval outcome… */
    val meta: String = "{}",
)

@Entity(tableName = "memories")
data class MemoryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** rule | preference | fact | plan | schedule | idea */
    val kind: String,
    val content: String,
    /** user (stated) | jarvis (inferred) */
    val source: String,
    val createdAt: Long,
    val updatedAt: Long,
)

@Fts4(contentEntity = MemoryEntity::class)
@Entity(tableName = "memories_fts")
data class MemoryFts(val content: String)

@Entity(tableName = "mobile_tasks")
data class MobileTaskEntity(
    @PrimaryKey val id: String,
    val title: String,
    /** reminder | agent */
    val kind: String,
    /** scheduled | running | completed | failed | cancelled */
    val status: String,
    val scheduledFor: Long?,
    val createdAt: Long,
    val updatedAt: Long,
    val result: String? = null,
    val error: String? = null,
    val workId: String? = null,
)

@Entity(tableName = "activity")
data class ActivityEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val ts: Long,
    /** info | success | warning | error */
    val level: String,
    /** tool | approval | memory | task | provider | remote | agent */
    val category: String,
    val message: String,
)

@Dao
interface ConversationDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun upsert(c: ConversationEntity)
    @Query("SELECT * FROM conversations ORDER BY updatedAt DESC LIMIT :limit") fun recent(limit: Int = 50): Flow<List<ConversationEntity>>
    @Query("SELECT * FROM conversations WHERE id = :id") suspend fun get(id: String): ConversationEntity?
    @Insert suspend fun insertMessage(m: MessageEntity)
    @Query("SELECT * FROM messages WHERE conversationId = :id ORDER BY createdAt ASC, rowid ASC") fun messages(id: String): Flow<List<MessageEntity>>
    @Query("SELECT * FROM messages WHERE conversationId = :id ORDER BY createdAt DESC, rowid DESC LIMIT :limit") suspend fun lastMessages(id: String, limit: Int): List<MessageEntity>
    @Query("DELETE FROM conversations WHERE id = :id") suspend fun delete(id: String)
}

@Dao
interface MemoryDao {
    @Insert suspend fun insert(m: MemoryEntity): Long
    @Update suspend fun update(m: MemoryEntity)
    @Query("SELECT memories.* FROM memories JOIN memories_fts ON memories.id = memories_fts.rowid WHERE memories_fts MATCH :query LIMIT :limit")
    suspend fun search(query: String, limit: Int): List<MemoryEntity>
    @Query("SELECT * FROM memories WHERE kind = :kind ORDER BY updatedAt DESC LIMIT :limit") suspend fun byKind(kind: String, limit: Int = 50): List<MemoryEntity>
    @Query("SELECT * FROM memories WHERE content = :content AND kind = :kind LIMIT 1") suspend fun exact(content: String, kind: String): MemoryEntity?
    @Query("SELECT * FROM memories ORDER BY updatedAt DESC") fun all(): Flow<List<MemoryEntity>>
    @Query("DELETE FROM memories WHERE id = :id") suspend fun delete(id: Long)
    @Query("SELECT COUNT(*) FROM memories") suspend fun count(): Int
}

@Dao
interface TaskDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun upsert(t: MobileTaskEntity)
    @Query("SELECT * FROM mobile_tasks WHERE id = :id") suspend fun get(id: String): MobileTaskEntity?
    @Query("SELECT * FROM mobile_tasks ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END, updatedAt DESC LIMIT 100") fun all(): Flow<List<MobileTaskEntity>>
    @Query("SELECT * FROM mobile_tasks WHERE status IN ('scheduled','running') ORDER BY scheduledFor ASC") suspend fun active(): List<MobileTaskEntity>
}

@Dao
interface ActivityDao {
    @Insert suspend fun insert(a: ActivityEntity)
    @Query("SELECT * FROM activity ORDER BY id DESC LIMIT :limit") fun recent(limit: Int = 200): Flow<List<ActivityEntity>>
    @Query("SELECT * FROM activity WHERE ts > :since ORDER BY id DESC") suspend fun since(since: Long): List<ActivityEntity>
}

@Database(entities = [ConversationEntity::class, MessageEntity::class, MemoryEntity::class, MemoryFts::class, MobileTaskEntity::class, ActivityEntity::class], version = 1, exportSchema = true)
abstract class JarvisDatabase : RoomDatabase() {
    abstract fun conversations(): ConversationDao
    abstract fun memories(): MemoryDao
    abstract fun tasks(): TaskDao
    abstract fun activity(): ActivityDao

    companion object {
        fun open(context: Context): JarvisDatabase = Room.databaseBuilder(context, JarvisDatabase::class.java, "jarvis-mobile.db").build()
        fun inMemory(context: Context): JarvisDatabase = Room.inMemoryDatabaseBuilder(context, JarvisDatabase::class.java).allowMainThreadQueries().build()
    }
}
