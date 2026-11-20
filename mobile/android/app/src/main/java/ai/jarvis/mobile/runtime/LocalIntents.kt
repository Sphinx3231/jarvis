package ai.jarvis.mobile.runtime

import android.content.Context
import android.content.Intent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Direct commands, understood without any model. They run first when the model is the small
 * on-device one (and are the fallback when no model is available). Each goes through the same
 * validation and authorization as a model-proposed call — "ask first" capabilities still ask.
 *
 * Patterns are deliberately narrow: "my battery drains fast, any tips?" is a question for the model,
 * not a battery reading.
 */
object LocalIntents {
    private val I = RegexOption.IGNORE_CASE

    suspend fun handle(
        text: String,
        context: Context,
        registry: MobileToolRegistry,
        permissions: MobilePermissionManager,
        memory: MobileMemoryManager,
        activity: ActivityLog,
        phase: (MobileExecutionRouter.Phase, String) -> Unit,
    ): Pair<String, List<String>>? {
        val t = normalize(text)
        if (t.isEmpty()) return null

        suspend fun run(name: String, args: Map<String, Any>, phrase: (String) -> String): Pair<String, List<String>> {
            val tool = registry.get(name) ?: return "That isn't available on this phone." to emptyList()
            val json = JsonObject(args.mapValues { (_, v) -> if (v is Number) JsonPrimitive(v) else JsonPrimitive(v.toString()) })
            registry.validate(tool, json)?.let { return "I couldn't do that: $it" to emptyList() }
            val av = tool.availability(context)
            if (!av.available) return "${tool.title} isn't available: ${av.reason}" to emptyList()
            phase(MobileExecutionRouter.Phase.WAITING_FOR_APPROVAL, tool.summarize(json))
            val d = permissions.authorize(tool, json)
            if (d is MobilePermissionManager.Decision.Denied) return "Not done: ${d.reason}." to emptyList()
            phase(MobileExecutionRouter.Phase.WORKING, tool.summarize(json))
            val out = try { tool.execute(context, json) } catch (e: Exception) { ToolOutcome.fail(e.message ?: "failed") }
            activity.log(if (out.ok) "success" else "warning", "tool", "${tool.summarize(json)} → ${out.content.take(120)}")
            return (if (out.ok) phrase(out.content) else "That didn't work: ${out.content}") to listOf(name)
        }

        // --- who / when ---------------------------------------------------------------------------
        if (Regex("^(who|what) are you$|^what('s| is) your name$|^are you (an? )?(ai|robot|bot)$", I).matches(t))
            return "I'm Jarvis, your assistant — running right here on your phone, offline. I can chat, remember things you tell me, set alarms, timers and reminders, search the web, open apps and more. Risky actions always ask you first." to emptyList()
        if (Regex("^what('s| is) the time( now)?$|^what time is it( now)?$", I).matches(t)) {
            val n = java.time.LocalTime.now()
            return "It's %02d:%02d.".format(n.hour, n.minute) to emptyList()
        }
        if (Regex("^what('s| is) (the |today's )?date( today)?$|^what day is (it|today)$", I).matches(t)) {
            val d = java.time.LocalDate.now()
            return "Today is ${d.dayOfWeek.name.lowercase().replaceFirstChar { it.uppercase() }}, ${d.dayOfMonth} ${d.month.name.lowercase().replaceFirstChar { it.uppercase() }} ${d.year}." to emptyList()
        }

        // --- memory -------------------------------------------------------------------------------
        Regex("^remember(?: that)?[:,]?\\s+(.{3,})$", I).find(t)?.let {
            val content = it.groupValues[1].trim()
            val kind = if (Regex("\\b(from now on|always|never)\\b", I).containsMatchIn(content)) "rule" else "fact"
            val (_, merged) = memory.remember(content, kind, "user")
            return (if (merged) "I already knew that." else "Got it — I'll remember that.") to listOf("memory_remember")
        }
        // --- reminders, alarms, timers --------------------------------------------------------------
        val unit = "(seconds?|secs?|minutes?|mins?|hours?|hrs?|h)"
        (Regex("^remind me in (\\d{1,5}) ?$unit\\b(?: to)?\\s*(.+)$", I).find(t)?.let { Triple(it.groupValues[1], it.groupValues[2], it.groupValues[3]) }
            ?: Regex("^remind me to (.+?) in (\\d{1,5}) ?$unit$", I).find(t)?.let { Triple(it.groupValues[2], it.groupValues[3], it.groupValues[1]) })
            ?.let { (n, u, what) ->
                val minutes = toSeconds(n.toInt(), u).let { s -> maxOf(1, (s + 59) / 60) }
                return run("reminder_schedule", mapOf("text" to what.trim(), "inMinutes" to minutes)) { "Okay — I'll remind you to ${what.trim()} in ${human(minutes * 60)}." }
            }
        val time = "(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?"
        (Regex("^(?:set |create |make )?(?:an |the |my )?alarm (?:for|at) $time(?:\\s+(?:tomorrow|today|tonight|in the morning|in the evening))?(?: (?:called|named|for) (.+))?$", I).find(t)
            ?: Regex("^wake me(?: up)? at $time(?:\\s+(?:tomorrow|in the morning))?$", I).find(t))?.let { m ->
            var h = m.groupValues[1].toInt()
            val min = m.groupValues[2].ifBlank { "0" }.toInt()
            val ap = m.groupValues[3].lowercase().replace(".", "")
            if (ap == "pm" && h < 12) h += 12
            if (ap == "am" && h == 12) h = 0
            if (h > 23 || min > 59) return "That isn't a valid time." to emptyList()
            val label = m.groupValues.getOrNull(4)?.ifBlank { null }
            return run("set_alarm", buildMap { put("hour", h); put("minute", min); label?.let { put("label", it) } }) { "Your clock app is open with an alarm for %02d:%02d — tap save to confirm.".format(h, min) }
        }
        (Regex("^(?:set |start )?(?:a |an )?timer for (\\d{1,5}) ?$unit$", I).find(t)
            ?: Regex("^(?:set |start )?(?:a |an )?(\\d{1,5}) ?$unit timer$", I).find(t))?.let { m ->
            val secs = toSeconds(m.groupValues[1].toInt(), m.groupValues[2]).coerceIn(1, 86_399)
            return run("set_timer", mapOf("seconds" to secs)) { "Timer started for ${human(secs)} in your clock app." }
        }

        // --- phone status ---------------------------------------------------------------------------
        if (Regex("^(what('s| is) )?(my |the )?(battery|charge)( level| status| percentage)?$|^how much (battery|charge)( do i have| is)?( left)?$|^(is )?(my )?phone charging$|^battery (left|level)$|^how (charged|full) is (my |the )?(phone|battery)$", I).matches(t))
            return run("device_battery", emptyMap()) { c ->
                val j = runCatching { Json.parseToJsonElement(c).jsonObject }.getOrNull()
                val level = j?.get("levelPercent")?.jsonPrimitive?.intOrNull
                val charging = j?.get("charging")?.jsonPrimitive?.booleanOrNull
                if (level == null) c else "Battery is at $level%${if (charging == true) " and charging" else ""}."
            }
        if (Regex("^(am i|are we|is (my |the )?phone) (online|connected|on wi-?fi|on mobile data)$|^(check )?(my |the )?(network|connection|wi-?fi)( status)?$", I).matches(t))
            return run("device_network", emptyMap()) { c ->
                val j = runCatching { Json.parseToJsonElement(c).jsonObject }.getOrNull()
                val online = j?.get("online")?.jsonPrimitive?.booleanOrNull
                val via = when (j?.get("transport")?.jsonPrimitive?.content) { "wifi" -> "Wi-Fi"; "cellular" -> "mobile data"; "ethernet" -> "Ethernet"; "none" -> null; else -> "a network" }
                when { via == null -> "You're offline."; online == true -> "You're online over $via."; else -> "Connected to $via, but without working internet." }
            }

        // --- what Jarvis remembers ------------------------------------------------------------------
        val recall = Regex("^what do you (know|remember)(?: about (.+))?$", I).find(t)?.let { it.groupValues[2].ifBlank { null } ?: "" }
            ?: Regex("^what('s| is| are) my (.{2,40})$", I).find(t)?.groupValues?.get(2)
        if (recall != null) {
            val found = if (recall.isBlank()) memory.standing() + memory.search("me", 6) else memory.search(recall, 6)
            val list = found.distinctBy { it.id }.take(8)
            return (if (list.isEmpty()) (if (recall.isBlank()) "You haven't told me anything to remember yet. Say “remember that …”." else "I don't have anything saved about “$recall”. You can tell me: “remember that my $recall is …”.")
            else "Here's what I have:\n" + list.joinToString("\n") { "• ${it.content}" }) to listOf("memory_search")
        }

        // --- web, apps, calls, clipboard ------------------------------------------------------------
        Regex("^(?:search(?: the web| online| google)?(?: for)?|google|look up|look for) (.{2,200})$", I).find(t)?.let {
            val q = it.groupValues[1].trim()
            return run("web_search", mapOf("query" to q)) { "Searching the web for “$q” in your browser." }
        }
        Regex("^(?:open|go to|visit) (https?://\\S+|(?:www\\.)?[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z]{2,}(?:/\\S*)?)$", I).find(t)?.let {
            val url = it.groupValues[1].let { u -> if (u.startsWith("http", true)) u else "https://$u" }
            return run("open_url", mapOf("url" to url)) { "Opened $url." }
        }
        Regex("^(?:open|launch|start) (?:the )?(.{2,40}?)(?: app)?$", I).find(t)?.let {
            val name = it.groupValues[1].trim()
            // "open up about…" is conversation, not an app: only short names that aren't a phrase are claimed.
            val pkg = findApp(context, name)
                ?: return if (name.split(' ').size <= 3 && !Regex("^(up|about|my|your|a|an)\\b", I).containsMatchIn(name)) "I couldn't find an app called “$name” on this phone." to emptyList() else null
            return run("app_launch", mapOf("package" to pkg.second)) { "Opened ${pkg.first}." }
        }
        Regex("^(?:call|dial|phone) ([+\\d][\\d\\s().-]{2,24})$", I).find(t)?.let {
            val number = it.groupValues[1].trim()
            return run("phone_dial", mapOf("number" to number)) { "The dialer is open with $number — press call when you're ready." }
        }
        Regex("^copy (.{1,2000}?)(?: to (?:the |my )?clipboard)?$", I).find(t)?.let {
            val what = it.groupValues[1].trim().removeSurrounding("\"").removeSurrounding("“", "”")
            return run("clipboard_copy", mapOf("text" to what)) { "Copied to the clipboard." }
        }
        return null
    }

    /** Lower-noise form of a request: no "hey jarvis", "please", "can you", trailing punctuation. */
    fun normalize(text: String): String {
        var t = text.trim().replace(Regex("\\s+"), " ")
        t = t.replace(Regex("^(hey |ok |okay )?jarvis[,:]?\\s*", I), "")
        t = t.replace(Regex("^(please |can you |could you |would you |will you )+", I), "")
        t = t.replace(Regex("[\\s,]*(please|thanks|thank you)$", I), "")
        return t.trimEnd('?', '!', '.', ' ')
    }

    private fun toSeconds(n: Int, unit: String): Int = when {
        unit.startsWith("s", true) -> n
        unit.startsWith("h", true) -> n * 3600
        else -> n * 60
    }

    private fun human(seconds: Int): String = when {
        seconds % 3600 == 0 -> "${seconds / 3600} hour${if (seconds / 3600 == 1) "" else "s"}"
        seconds % 60 == 0 -> "${seconds / 60} minute${if (seconds / 60 == 1) "" else "s"}"
        else -> "$seconds seconds"
    }

    /** A launcher app whose name matches (exact first, then prefix, then contains). */
    private fun findApp(context: Context, name: String): Pair<String, String>? {
        val pm = context.packageManager
        val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
            .map { it.loadLabel(pm).toString() to it.activityInfo.packageName }
        val n = name.lowercase()
        return apps.firstOrNull { it.first.lowercase() == n } ?: apps.firstOrNull { it.first.lowercase().startsWith(n) } ?: apps.firstOrNull { it.first.lowercase().contains(n) }
    }
}
