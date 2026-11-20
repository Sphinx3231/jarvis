package ai.jarvis.mobile.runtime.tools

import ai.jarvis.mobile.runtime.MobileMemoryManager
import ai.jarvis.mobile.runtime.MobileTaskManager
import ai.jarvis.mobile.runtime.MobileTool
import ai.jarvis.mobile.runtime.Risk
import ai.jarvis.mobile.runtime.ToolOutcome
import ai.jarvis.mobile.runtime.int
import ai.jarvis.mobile.runtime.schema
import ai.jarvis.mobile.runtime.str
import ai.jarvis.mobile.voice.Speaker
import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.AlarmClock
import android.provider.CalendarContract
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeParseException

private fun JsonObject.s(k: String) = this[k]?.jsonPrimitive?.content
private fun JsonObject.i(k: String) = this[k]?.jsonPrimitive?.int

private fun startActivity(ctx: Context, intent: Intent): ToolOutcome = try {
    ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    ToolOutcome.ok("Opened")
} catch (e: Exception) {
    ToolOutcome.fail("No app on this phone can handle that (${e.javaClass.simpleName})")
}

/**
 * Native capabilities, each narrowly scoped to one public Android API. Nothing here uses an
 * AccessibilityService, controls other apps' UIs, or changes system settings. Actions that hand
 * over to another app (alarm, calendar, dialer, share) open that app for the user to confirm.
 */
fun androidTools(memory: MobileMemoryManager, tasks: MobileTaskManager, speaker: Speaker): List<MobileTool> = listOf(
    object : MobileTool {
        override val name = "device_battery"
        override val title = "Battery status"
        override val description = "Battery level and whether the phone is charging."
        override val parameters = schema(emptyList())
        override val risk = Risk.READ
        override fun summarize(args: JsonObject) = "Read the battery level"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            val bm = context.getSystemService(BatteryManager::class.java)
            val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            return ToolOutcome.ok("""{"levelPercent":$level,"charging":${bm.isCharging}}""")
        }
    },
    object : MobileTool {
        override val name = "device_network"
        override val title = "Network status"
        override val description = "Whether the phone is online, over Wi-Fi or mobile data, and if the connection is metered."
        override val parameters = schema(emptyList())
        override val risk = Risk.READ
        override fun summarize(args: JsonObject) = "Check the network connection"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            val cm = context.getSystemService(ConnectivityManager::class.java)
            val caps = cm.getNetworkCapabilities(cm.activeNetwork)
            val transport = when {
                caps == null -> "none"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                else -> "other"
            }
            val online = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
            return ToolOutcome.ok("""{"online":$online,"transport":"$transport","metered":${cm.isActiveNetworkMetered}}""")
        }
    },
    object : MobileTool {
        override val name = "device_info"
        override val title = "Device info"
        override val description = "Phone model, Android version and free storage."
        override val parameters = schema(emptyList())
        override val risk = Risk.READ
        override fun summarize(args: JsonObject) = "Read device information"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            val stat = StatFs(Environment.getDataDirectory().path)
            return ToolOutcome.ok("""{"model":"${Build.MANUFACTURER} ${Build.MODEL}","android":"${Build.VERSION.RELEASE}","sdk":${Build.VERSION.SDK_INT},"freeStorageGb":${"%.1f".format(stat.availableBytes / 1e9)}}""")
        }
    },
    object : MobileTool {
        override val name = "sensors_list"
        override val title = "Sensors"
        override val description = "The sensors this phone has."
        override val parameters = schema(emptyList())
        override val risk = Risk.READ
        override fun summarize(args: JsonObject) = "List the phone's sensors"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            val sm = context.getSystemService(SensorManager::class.java)
            return ToolOutcome.ok(sm.getSensorList(Sensor.TYPE_ALL).joinToString(prefix = "[", postfix = "]") { "\"${it.name.replace("\"", "'")}\"" })
        }
    },
    object : MobileTool {
        override val name = "apps_list"
        override val title = "Installed apps"
        override val description = "Apps that can be opened on this phone (name and package)."
        override val parameters = schema(emptyList())
        override val risk = Risk.READ
        override fun summarize(args: JsonObject) = "List openable apps"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            val pm = context.packageManager
            val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
                .map { it.loadLabel(pm).toString() to it.activityInfo.packageName }.distinctBy { it.second }.sortedBy { it.first.lowercase() }.take(200)
            return ToolOutcome.ok(apps.joinToString(prefix = "[", postfix = "]") { "{\"name\":\"${it.first.replace("\"", "'")}\",\"package\":\"${it.second}\"}" })
        }
    },
    object : MobileTool {
        override val name = "app_launch"
        override val title = "Open an app"
        override val description = "Open an installed app by its package name (from apps_list)."
        override val parameters = schema(listOf("package"), "package" to str("Android package name, e.g. com.spotify.music", 200))
        override val risk = Risk.ACT
        override fun summarize(args: JsonObject) = "Open the app ${args.s("package")}"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            val intent = context.packageManager.getLaunchIntentForPackage(args.s("package") ?: "") ?: return ToolOutcome.fail("That app is not installed or can't be opened")
            return startActivity(context, intent)
        }
    },
    object : MobileTool {
        override val name = "open_url"
        override val title = "Open a web page"
        override val description = "Open an https:// link in the browser."
        override val parameters = schema(listOf("url"), "url" to str("An https:// URL", 2000))
        override val risk = Risk.ACT
        override fun summarize(args: JsonObject) = "Open ${args.s("url")}"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            val url = args.s("url") ?: ""
            if (!url.startsWith("https://") && !url.startsWith("http://")) return ToolOutcome.fail("Only http(s) links can be opened")
            return startActivity(context, Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }
    },
    object : MobileTool {
        override val name = "web_search"
        override val title = "Search the web"
        override val description = "Open a web search for a query in the browser."
        override val parameters = schema(listOf("query"), "query" to str("What to search for", 300))
        override val risk = Risk.ACT
        override fun summarize(args: JsonObject) = "Search the web for “${args.s("query")}”"
        override suspend fun execute(context: Context, args: JsonObject) =
            startActivity(context, Intent(Intent.ACTION_WEB_SEARCH).putExtra("query", args.s("query")))
    },
    object : MobileTool {
        override val name = "set_alarm"
        override val title = "Set an alarm"
        override val description = "Open the clock app with an alarm ready to save (24-hour time)."
        override val parameters = schema(listOf("hour", "minute"), "hour" to int("Hour 0-23", 0, 23), "minute" to int("Minute 0-59", 0, 59), "label" to str("Alarm label", 100))
        override val risk = Risk.ACT
        override fun summarize(args: JsonObject) = "Set an alarm for %02d:%02d%s".format(args.i("hour"), args.i("minute"), args.s("label")?.let { " ($it)" } ?: "")
        override suspend fun execute(context: Context, args: JsonObject) = startActivity(
            context,
            Intent(AlarmClock.ACTION_SET_ALARM).putExtra(AlarmClock.EXTRA_HOUR, args.i("hour")).putExtra(AlarmClock.EXTRA_MINUTES, args.i("minute"))
                .putExtra(AlarmClock.EXTRA_MESSAGE, args.s("label") ?: "Jarvis").putExtra(AlarmClock.EXTRA_SKIP_UI, false),
        )
    },
    object : MobileTool {
        override val name = "set_timer"
        override val title = "Start a timer"
        override val description = "Open the clock app with a countdown timer."
        override val parameters = schema(listOf("seconds"), "seconds" to int("Length in seconds", 1, 86_400), "label" to str("Timer label", 100))
        override val risk = Risk.ACT
        override fun summarize(args: JsonObject) = "Start a ${args.i("seconds")}-second timer"
        override suspend fun execute(context: Context, args: JsonObject) = startActivity(
            context,
            Intent(AlarmClock.ACTION_SET_TIMER).putExtra(AlarmClock.EXTRA_LENGTH, args.i("seconds")).putExtra(AlarmClock.EXTRA_MESSAGE, args.s("label") ?: "Jarvis").putExtra(AlarmClock.EXTRA_SKIP_UI, false),
        )
    },
    object : MobileTool {
        override val name = "calendar_add"
        override val title = "Add a calendar event"
        override val description = "Open the calendar app with a new event filled in (start as local time yyyy-MM-ddTHH:mm)."
        override val parameters = schema(listOf("title", "start"), "title" to str("Event title", 200), "start" to str("Local start time, e.g. 2026-11-21T15:00", 20), "durationMinutes" to int("Duration", 5, 1440), "location" to str("Location", 200))
        override val risk = Risk.ACT
        override fun summarize(args: JsonObject) = "Add “${args.s("title")}” on ${args.s("start")?.replace('T', ' ')}"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            val start = try { LocalDateTime.parse(args.s("start")).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli() } catch (e: DateTimeParseException) { return ToolOutcome.fail("Start must look like 2026-11-21T15:00") }
            val end = start + (args.i("durationMinutes") ?: 60) * 60_000L
            return startActivity(
                context,
                Intent(Intent.ACTION_INSERT, CalendarContract.Events.CONTENT_URI).putExtra(CalendarContract.Events.TITLE, args.s("title"))
                    .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start).putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end).putExtra(CalendarContract.Events.EVENT_LOCATION, args.s("location") ?: ""),
            )
        }
    },
    object : MobileTool {
        override val name = "phone_dial"
        override val title = "Dial a number"
        override val description = "Open the dialer with a number filled in (the user presses call)."
        override val parameters = schema(listOf("number"), "number" to str("Phone number", 40))
        override val risk = Risk.ACT
        override fun summarize(args: JsonObject) = "Open the dialer with ${args.s("number")}"
        override suspend fun execute(context: Context, args: JsonObject) = startActivity(context, Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(args.s("number")))))
    },
    object : MobileTool {
        override val name = "share_text"
        override val title = "Share text"
        override val description = "Open the share sheet with some text, for the user to pick where it goes."
        override val parameters = schema(listOf("text"), "text" to str("Text to share", 4000))
        override val risk = Risk.ACT
        override fun summarize(args: JsonObject) = "Share: “${args.s("text")?.take(60)}”"
        override suspend fun execute(context: Context, args: JsonObject) =
            startActivity(context, Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, args.s("text")), "Share from Jarvis"))
    },
    object : MobileTool {
        override val name = "clipboard_copy"
        override val title = "Copy to clipboard"
        override val description = "Copy text to the clipboard."
        override val parameters = schema(listOf("text"), "text" to str("Text to copy", 8000))
        override val risk = Risk.ACT
        override fun summarize(args: JsonObject) = "Copy to the clipboard: “${args.s("text")?.take(60)}”"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Jarvis", args.s("text")))
            return ToolOutcome.ok("Copied")
        }
    },
    object : MobileTool {
        override val name = "speak"
        override val title = "Speak aloud"
        override val description = "Say something out loud with the phone's text-to-speech."
        override val parameters = schema(listOf("text"), "text" to str("What to say", 2000))
        override val risk = Risk.ACT
        override fun summarize(args: JsonObject) = "Say: “${args.s("text")?.take(60)}”"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome = if (speaker.speak(args.s("text") ?: "")) ToolOutcome.ok("Spoken") else ToolOutcome.fail("Text-to-speech is not ready on this phone")
    },
    object : MobileTool {
        override val name = "notify"
        override val title = "Show a notification"
        override val description = "Show a notification on this phone now."
        override val parameters = schema(listOf("title"), "title" to str("Title", 120), "body" to str("Text", 500))
        override val risk = Risk.ACT
        override val androidPermission = Manifest.permission.POST_NOTIFICATIONS.takeIf { Build.VERSION.SDK_INT >= 33 }
        override fun summarize(args: JsonObject) = "Notify: ${args.s("title")}"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            Notifications.post(context, args.s("title") ?: "Jarvis", args.s("body") ?: "")
            return ToolOutcome.ok("Shown")
        }
    },
    object : MobileTool {
        override val name = "memory_remember"
        override val title = "Remember"
        override val description = "Save something durable about the user on this phone (preference, fact, plan, rule…)."
        override val parameters = schema(listOf("content", "kind"), "content" to str("One self-contained statement", 1000), "kind" to str("Kind", 20, listOf("rule", "preference", "fact", "plan", "schedule", "idea")))
        override val risk = Risk.READ // internal: writes only to Mobile Jarvis's own memory
        override fun summarize(args: JsonObject) = "Remember: ${args.s("content")}"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            val (m, merged) = memory.remember(args.s("content") ?: "", args.s("kind") ?: "fact", "jarvis (inferred)")
            return ToolOutcome.ok(if (merged) "Already known (#${m.id})" else "Saved (#${m.id})")
        }
    },
    object : MobileTool {
        override val name = "memory_search"
        override val title = "Search memory"
        override val description = "Search what Mobile Jarvis remembers on this phone."
        override val parameters = schema(listOf("query"), "query" to str("What to look for", 300))
        override val risk = Risk.READ
        override fun summarize(args: JsonObject) = "Search memory for “${args.s("query")}”"
        override suspend fun execute(context: Context, args: JsonObject) = ToolOutcome.ok(memory.search(args.s("query") ?: "", 8).joinToString("\n") { "- [${it.kind}] ${it.content}" }.ifBlank { "Nothing found" })
    },
    object : MobileTool {
        override val name = "reminder_schedule"
        override val title = "Schedule a reminder"
        override val description = "Remind the user with a notification after a delay. Survives app restarts and reboots."
        override val parameters = schema(listOf("text", "inMinutes"), "text" to str("What to remind about", 300), "inMinutes" to int("Minutes from now", 1, 60 * 24 * 30))
        override val risk = Risk.ACT
        override fun summarize(args: JsonObject) = "Remind you in ${args.i("inMinutes")} min: “${args.s("text")}”"
        override suspend fun execute(context: Context, args: JsonObject): ToolOutcome {
            val t = tasks.scheduleReminder(args.s("text") ?: "", (args.i("inMinutes") ?: 1) * 60_000L)
            return ToolOutcome.ok("Scheduled (task ${t.id})")
        }
    },
    object : MobileTool {
        override val name = "tasks_list"
        override val title = "Mobile tasks"
        override val description = "The phone's scheduled and recent tasks (reminders, agent runs)."
        override val parameters = schema(emptyList())
        override val risk = Risk.READ
        override fun summarize(args: JsonObject) = "List mobile tasks"
        override suspend fun execute(context: Context, args: JsonObject) = ToolOutcome.ok(tasks.activeNow().joinToString("\n") { "- ${it.title} (${it.status})" }.ifBlank { "No active tasks on the phone" })
    },
)

object Notifications {
    const val CHANNEL = "jarvis"
    fun ensureChannel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) nm.createNotificationChannel(NotificationChannel(CHANNEL, "Jarvis", NotificationManager.IMPORTANCE_DEFAULT))
    }

    @android.annotation.SuppressLint("MissingPermission")
    fun post(context: Context, title: String, body: String) {
        ensureChannel(context)
        val n = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(title).setContentText(body).setAutoCancel(true).build()
        if (NotificationManagerCompat.from(context).areNotificationsEnabled()) NotificationManagerCompat.from(context).notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), n)
    }
}
