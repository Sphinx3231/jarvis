package ai.jarvis.mobile.runtime.brain

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.time.LocalDate
import java.time.LocalDateTime

/** A note in the vault, addressed by its path relative to the vault root ("Jarvis/Memory.md"). */
data class NoteRef(val path: String, val modified: Long, val size: Long) {
    val title: String get() = path.substringAfterLast('/').removeSuffix(".md")
    val folder: String get() = path.substringBeforeLast('/', "")
}

/** Where notes live: a folder of Markdown files (an Obsidian vault is exactly that). */
interface NoteStore {
    val label: String
    suspend fun list(): List<NoteRef>
    suspend fun read(path: String): String?
    suspend fun write(path: String, text: String)
    suspend fun append(path: String, text: String) { write(path, (read(path) ?: "") + text) }
}

/** The built-in brain: app storage, or any directory (tests). */
class FileNoteStore(private val root: File, override val label: String) : NoteStore {
    override suspend fun list(): List<NoteRef> = withContext(Dispatchers.IO) {
        root.mkdirs()
        root.walkTopDown().onEnter { !it.name.startsWith(".") || it == root }.filter { it.isFile && it.name.endsWith(".md") }.take(MAX_NOTES)
            .map { NoteRef(it.relativeTo(root).path.replace(File.separatorChar, '/'), it.lastModified(), it.length()) }.toList()
    }
    override suspend fun read(path: String): String? = withContext(Dispatchers.IO) { safe(path)?.takeIf { it.isFile }?.readText() }
    override suspend fun write(path: String, text: String) = withContext(Dispatchers.IO) { safe(path)!!.apply { parentFile?.mkdirs() }.writeText(text) }
    override suspend fun append(path: String, text: String) = withContext(Dispatchers.IO) { safe(path)!!.apply { parentFile?.mkdirs() }.appendText(text) }

    /** Paths stay inside the vault. */
    private fun safe(path: String): File? = File(root, path).canonicalFile.takeIf { it.path.startsWith(root.canonicalPath + File.separator) }
}

/**
 * A folder the user picked with the system file picker — typically their Obsidian vault. Access is
 * limited to that folder (Storage Access Framework); no storage permission is needed or requested.
 */
class SafNoteStore(private val context: Context, private val tree: Uri) : NoteStore {
    private val rootDoc get() = DocumentFile.fromTreeUri(context, tree) ?: throw IllegalStateException("The vault folder is no longer available")
    override val label: String get() = runCatching { rootDoc.name }.getOrNull() ?: "Vault"

    override suspend fun list(): List<NoteRef> = withContext(Dispatchers.IO) {
        val out = mutableListOf<NoteRef>()
        fun walk(dir: DocumentFile, prefix: String, depth: Int) {
            if (depth > 6 || out.size >= MAX_NOTES) return
            for (f in dir.listFiles()) {
                val name = f.name ?: continue
                if (name.startsWith(".")) continue // .obsidian, .trash…
                if (f.isDirectory) walk(f, "$prefix$name/", depth + 1)
                else if (name.endsWith(".md")) out += NoteRef("$prefix$name", f.lastModified(), f.length())
                if (out.size >= MAX_NOTES) return
            }
        }
        walk(rootDoc, "", 0)
        out
    }

    private fun find(path: String, create: Boolean): DocumentFile? {
        val parts = path.split('/').filter { it.isNotBlank() && it != "." && it != ".." }
        var dir = rootDoc
        for (p in parts.dropLast(1)) dir = dir.findFile(p)?.takeIf { it.isDirectory } ?: (if (create) dir.createDirectory(p) else null) ?: return null
        val name = parts.lastOrNull() ?: return null
        return dir.findFile(name) ?: if (create) dir.createFile("text/markdown", name) else null
    }

    override suspend fun read(path: String): String? = withContext(Dispatchers.IO) {
        find(path, false)?.let { d -> context.contentResolver.openInputStream(d.uri)?.use { it.readBytes().toString(Charsets.UTF_8) } }
    }

    override suspend fun write(path: String, text: String) = withContext(Dispatchers.IO) {
        val d = find(path, true) ?: throw IllegalStateException("Couldn't create $path in the vault")
        context.contentResolver.openOutputStream(d.uri, "wt")?.use { it.write(text.toByteArray()) } ?: throw IllegalStateException("Couldn't write $path")
    }

    override suspend fun append(path: String, text: String) = withContext(Dispatchers.IO) {
        val d = find(path, true) ?: throw IllegalStateException("Couldn't create $path in the vault")
        val ok = runCatching { context.contentResolver.openOutputStream(d.uri, "wa")?.use { it.write(text.toByteArray()) } != null }.getOrDefault(false)
        if (!ok) {
            val old = context.contentResolver.openInputStream(d.uri)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            context.contentResolver.openOutputStream(d.uri, "wt")?.use { it.write((old + text).toByteArray()) }
        }
    }
}

const val MAX_NOTES = 800

/**
 * Jarvis's live brain: a Markdown vault it reads for context, searches and writes to. Conversations
 * and remembered facts are filed under `Jarvis/` so they show up in Obsidian; everything else in the
 * vault is the user's, and Jarvis only changes it with the user's approval (brain_write asks first).
 */
class Brain(private val stores: () -> NoteStore) {
    data class Hit(val note: NoteRef, val score: Int, val snippet: String)

    private val _version = MutableStateFlow(0)
    /** Bumps whenever Jarvis writes, so screens can refresh. */
    val version: StateFlow<Int> = _version
    private val lock = Mutex()
    private var cache: Pair<Long, List<NoteRef>>? = null
    private val texts = HashMap<String, Pair<Long, String>>()

    val label: String get() = stores().label

    suspend fun notes(): List<NoteRef> = lock.withLock {
        cache?.takeIf { System.currentTimeMillis() - it.first < 30_000 }?.second
            ?: stores().list().sortedByDescending { it.modified }.also { cache = System.currentTimeMillis() to it }
    }

    suspend fun read(path: String): String? = stores().read(path)

    private suspend fun text(n: NoteRef): String {
        texts[n.path]?.takeIf { it.first == n.modified }?.let { return it.second }
        val t = if (n.size > 512 * 1024) "" else (stores().read(n.path) ?: "")
        texts[n.path] = n.modified to t
        return t
    }

    /** Keyword search over titles (weighted) and contents, with a snippet around the best match. */
    suspend fun search(query: String, limit: Int = 5): List<Hit> {
        val terms = terms(query)
        if (terms.isEmpty()) return emptyList()
        return notes().mapNotNull { n ->
            val title = n.title.lowercase()
            val body = text(n)
            val lower = body.lowercase()
            var score = 0
            var first = -1
            for (t in terms) {
                score += 4 * Regex(Regex.escape(t)).findAll(title).count()
                val hits = Regex(Regex.escape(t)).findAll(lower).toList()
                score += minOf(hits.size, 5)
                if (first < 0 && hits.isNotEmpty()) first = hits.first().range.first
            }
            if (score == 0) null else Hit(n, score, snippet(body, first))
        }.sortedByDescending { it.score }.take(limit)
    }

    /** Notes worth putting in front of the model for this request (short excerpts, capped). */
    suspend fun contextFor(query: String, maxChars: Int = 1500): String? {
        val hits = runCatching { search(query, 3) }.getOrDefault(emptyList()).filter { it.score >= 2 }
        if (hits.isEmpty()) return null
        val sb = StringBuilder()
        for (h in hits) {
            val piece = "[${h.note.title}] ${h.snippet}\n"
            if (sb.length + piece.length > maxChars) break
            sb.append(piece)
        }
        return sb.toString().trim().ifBlank { null }
    }

    suspend fun write(title: String, content: String, append: Boolean): String {
        val path = notePath(title)
        if (append) stores().append(path, (if (content.startsWith("\n")) "" else "\n") + content.trimEnd() + "\n") else stores().write(path, content.trimEnd() + "\n")
        changed()
        return path
    }

    /** Files a conversation exchange under Jarvis/Conversations (one note per conversation). */
    suspend fun logExchange(conversationId: String, firstMessage: String, user: String, assistant: String, handledBy: String) {
        val path = "Jarvis/Conversations/${LocalDate.now()} ${slug(firstMessage.take(40)).ifBlank { "Conversation" }} ${conversationId.takeLast(4)}.md"
        val existing = stores().read(path)
        val time = LocalDateTime.now().toLocalTime().withNano(0)
        val entry = buildString {
            if (existing == null) append("# ${firstMessage.take(80).trim()}\n\n_Conversation with Jarvis on the phone · ${LocalDate.now()}_\n")
            append("\n**You** ($time): ${user.trim()}\n\n**Jarvis** (${handledBy}): ${assistant.trim()}\n")
        }
        stores().append(path, entry)
        changed()
    }

    /** Mirrors a remembered fact into Jarvis/Memory.md. */
    suspend fun logMemory(kind: String, content: String) {
        val path = "Jarvis/Memory.md"
        val head = if (stores().read(path) == null) "# What Jarvis remembers\n\nFacts, preferences and rules you told Jarvis on the phone.\n\n" else ""
        stores().append(path, "$head- [$kind] ${content.trim()} _(${LocalDate.now()})_\n")
        changed()
    }

    /** Called when the vault changes location. */
    fun reset() { cache = null; texts.clear(); changed() }

    private fun changed() { cache = null; _version.value++ }

    companion object {
        private val STOP = setOf("the", "and", "for", "you", "your", "with", "what", "about", "that", "this", "from", "have", "how", "did", "does", "are", "was", "were", "can", "could", "would", "should", "please", "jarvis", "my", "me", "in", "on", "of", "to", "a", "an", "is", "it", "i", "do", "notes", "note", "write", "wrote")
        fun terms(q: String) = Regex("[\\p{L}\\p{N}]{3,}").findAll(q.lowercase()).map { it.value }.filter { it !in STOP }.distinct().take(8).toList()
        fun slug(s: String) = s.replace(Regex("[\\\\/:*?\"<>|#^\\[\\]]"), " ").replace(Regex("\\s+"), " ").trim()
        fun notePath(title: String): String {
            val t = title.trim().removeSuffix(".md")
            val clean = t.split('/').map { slug(it) }.filter { it.isNotBlank() && it != "." && it != ".." }.joinToString("/")
            return (clean.ifBlank { "Untitled" }) + ".md"
        }
        private fun snippet(body: String, at: Int): String {
            if (body.isBlank()) return ""
            val start = if (at < 0) 0 else maxOf(0, at - 200)
            return body.substring(start, minOf(body.length, start + 500)).replace(Regex("\\s+"), " ").trim().let { if (start > 0) "…$it" else it }
        }
    }
}

/** Remembers which vault Jarvis uses and whether conversations are saved to it. */
class BrainSettings(context: Context) {
    private val prefs = context.getSharedPreferences("jarvis_brain", Context.MODE_PRIVATE)
    var vaultUri: Uri?
        get() = prefs.getString("vault", null)?.let(Uri::parse)
        set(v) { prefs.edit().apply { if (v == null) remove("vault") else putString("vault", v.toString()) }.apply() }
    var saveConversations: Boolean
        get() = prefs.getBoolean("saveConversations", true)
        set(v) { prefs.edit().putBoolean("saveConversations", v).apply() }
}
