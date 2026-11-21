package ai.jarvis.mobile.control

import ai.jarvis.mobile.JarvisApplication
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * What the user sees while Jarvis works inside other apps: a "Jarvis is using your phone · STOP"
 * pill, approval cards (Jarvis's own screen is in the background then), and the answer when done.
 * Never focusable, and never tapped by Jarvis itself (gesture taps inside it are refused).
 */
class ControlOverlay(private val service: PhoneControlService) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val wm = service.getSystemService(WindowManager::class.java)
    private var root: LinearLayout? = null
    private var shown = false

    private fun dp(v: Int) = (v * service.resources.displayMetrics.density).toInt()
    private fun bg(color: Int) = GradientDrawable().apply { setColor(color); cornerRadius = dp(14).toFloat(); setStroke(dp(1), Color.parseColor("#A78BFA")) }
    private fun text(t: String, size: Float = 14f, color: Int = Color.WHITE) = TextView(service).apply { this.text = t; textSize = size; setTextColor(color) }
    private fun button(t: String, color: String, onClick: () -> Unit) = Button(service).apply {
        text = t; setTextColor(Color.WHITE); isAllCaps = false; background = bg(Color.parseColor(color)); setOnClickListener { onClick() }
        setPadding(dp(14), dp(4), dp(14), dp(4))
    }

    fun start() {
        val c = (service.application as? JarvisApplication)?.container ?: return
        scope.launch {
            combine(PhoneControl.inUse, c.permissions.pending, c.mobile.state) { inUse, pending, session -> Triple(inUse, pending, session) }.collect { (inUse, pending, session) ->
                val content = mutableListOf<View>()
                if (inUse && session.busy) {
                    content += LinearLayout(service).apply {
                        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                        background = bg(Color.parseColor("#E6140C2C")); setPadding(dp(14), dp(6), dp(6), dp(6))
                        addView(text("● Jarvis is using your phone", 13f, Color.parseColor("#C4B5FD")))
                        addView(button("STOP", "#B91C1C") { c.mobile.cancel("Stopped from the STOP button") }.apply { layoutParams = LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(10) } })
                    }
                }
                pending.firstOrNull()?.takeIf { inUse }?.let { p ->
                    content += LinearLayout(service).apply {
                        orientation = LinearLayout.VERTICAL; background = bg(Color.parseColor("#F2140C2C")); setPadding(dp(16), dp(12), dp(16), dp(12))
                        addView(text("Jarvis wants to:", 12f, Color.parseColor("#A8A2C0")))
                        addView(text(p.summary, 15f))
                        addView(LinearLayout(service).apply {
                            orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(8), 0, 0)
                            addView(button("Approve", "#15803D") { c.permissions.resolve(p.id, true) })
                            addView(button("Deny", "#B91C1C") { c.permissions.resolve(p.id, false) }.apply { layoutParams = LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(10) } })
                        })
                    }
                }
                val reply = session.lastReply
                if (!session.busy && reply != null && session.usedPhone && !session.replySeen) {
                    content += LinearLayout(service).apply {
                        orientation = LinearLayout.VERTICAL; background = bg(Color.parseColor("#F2140C2C")); setPadding(dp(16), dp(12), dp(16), dp(12))
                        addView(text("Jarvis", 12f, Color.parseColor("#C4B5FD")))
                        addView(text(reply.take(600), 14f))
                        addView(LinearLayout(service).apply {
                            orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(8), 0, 0)
                            addView(button("Open Jarvis", "#5B21B6") {
                                c.mobile.markReplySeen()
                                service.startActivity(Intent(service, ai.jarvis.mobile.MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
                            })
                            addView(button("Dismiss", "#3F3A5A") { c.mobile.markReplySeen() }.apply { layoutParams = LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(10) } })
                        })
                    }
                    scope.launch { delay(20_000); c.mobile.markReplySeen() }
                }
                render(content)
            }
        }
    }

    private fun render(views: List<View>) {
        if (views.isEmpty()) { hide(); return }
        val r = root ?: LinearLayout(service).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(8), dp(12), dp(8)) }.also { root = it }
        r.removeAllViews()
        views.forEach { r.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(6) }) }
        if (!shown) {
            val lp = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT,
            ).apply { gravity = Gravity.TOP; y = dp(36) }
            runCatching { wm.addView(r, lp); shown = true }
        }
    }

    private fun hide() {
        root?.let { if (shown) runCatching { wm.removeView(it) } }
        shown = false
    }

    /** Where the overlay is on screen (Jarvis's own gesture taps must never land on it). */
    fun bounds(): Rect? = root?.takeIf { shown }?.let { v -> IntArray(2).also { v.getLocationOnScreen(it) }.let { Rect(it[0], it[1], it[0] + v.width, it[1] + v.height) } }

    fun stop() { hide(); scope.cancel() }
}
