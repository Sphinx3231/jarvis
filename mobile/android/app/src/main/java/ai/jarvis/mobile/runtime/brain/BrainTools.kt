package ai.jarvis.mobile.runtime.brain

import ai.jarvis.mobile.runtime.MobileTool
import ai.jarvis.mobile.runtime.Risk
import ai.jarvis.mobile.runtime.ToolOutcome
import ai.jarvis.mobile.runtime.schema
import ai.jarvis.mobile.runtime.str
import android.content.Context
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive

private fun JsonObject.s(k: String) = this[k]?.jsonPrimitive?.content

/** The brain as capabilities. Reading is free; changing the user's notes asks first. */
fun brainTools(brain: Brain): List<MobileTool> = listOf(
    object : MobileTool {
        override val name = "brain_search"
        override val title = "Search your notes"
        override val description = "Search the user's notes vault (their Obsidian brain) for notes about something. Returns matching note titles with excerpts."
        override val parameters = schema(listOf("query"), "query" to str("What to look for", 200))
        override val risk = Risk.READ
        override fun summarize(args: JsonObject) = "Search your notes for “${args.s("query")}”"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            val hits = brain.search(args.s("query") ?: "", 5)
            return ToolOutcome.ok(if (hits.isEmpty()) "No notes match." else hits.joinToString("\n\n") { "## ${it.note.path}\n${it.snippet}" })
        }
    },
    object : MobileTool {
        override val name = "brain_read"
        override val title = "Read a note"
        override val description = "Read one note from the user's notes vault by its title or path (from brain_search)."
        override val parameters = schema(listOf("title"), "title" to str("Note title or path", 300))
        override val risk = Risk.READ
        override fun summarize(args: JsonObject) = "Read the note “${args.s("title")}”"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            val want = args.s("title")!!.removeSuffix(".md").lowercase()
            val note = brain.notes().let { all -> all.firstOrNull { it.path.removeSuffix(".md").lowercase() == want } ?: all.firstOrNull { it.title.lowercase() == want.substringAfterLast('/') } }
                ?: return ToolOutcome.fail("No note called “${args.s("title")}”")
            return ToolOutcome.ok((brain.read(note.path) ?: "").take(6000).ifBlank { "(empty note)" })
        }
    },
    object : MobileTool {
        override val name = "brain_write"
        override val title = "Write a note"
        override val description = "Create or update a note in the user's notes vault. Set append to true to add to the end of an existing note instead of replacing it."
        override val parameters = schema(listOf("title", "content"), "title" to str("Note title (folders with /)", 200), "content" to str("Markdown content", 20_000), "append" to JsonObject(mapOf("type" to kotlinx.serialization.json.JsonPrimitive("boolean"), "description" to kotlinx.serialization.json.JsonPrimitive("Add to the end instead of replacing"))))
        override val risk = Risk.ACT
        override fun summarize(args: JsonObject) = "${if (args["append"]?.jsonPrimitive?.booleanOrNull == true) "Add to" else "Write"} the note “${args.s("title")}”"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome =
            ToolOutcome.ok("Saved ${brain.write(args.s("title")!!, args.s("content")!!, args["append"]?.jsonPrimitive?.booleanOrNull == true)}")
    },
)
