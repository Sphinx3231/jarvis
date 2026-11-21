package ai.jarvis.mobile.control

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Jarvis's hands on the phone: reads the screen and taps, types and scrolls — only after the user
 * has switched it on in Android's Accessibility settings (an app can't enable this itself), and only
 * while Jarvis is carrying out something the user asked for. Games are never controlled, password
 * fields are never read or typed into, and consequential taps ask first (see ActionRisk).
 */
class PhoneControlService : AccessibilityService() {
    private val nodes = HashMap<Int, AccessibilityNodeInfo>()
    private var overlay: ControlOverlay? = null

    override fun onServiceConnected() {
        instance = this
        _connected.value = true
        overlay = ControlOverlay(this).also { it.start() }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) { /* the screen is read on demand */ }
    override fun onInterrupt() {}

    override fun onDestroy() {
        overlay?.stop()
        overlay = null
        instance = null
        _connected.value = false
        super.onDestroy()
    }

    fun foregroundPackage(): String? = rootInActiveWindow?.packageName?.toString()

    fun isGame(pkg: String): Boolean {
        if (ActionRisk.isKnownGame(pkg)) return true
        val info = runCatching { packageManager.getApplicationInfo(pkg, 0) }.getOrNull() ?: return false
        @Suppress("DEPRECATION")
        return info.category == ApplicationInfo.CATEGORY_GAME || (info.flags and ApplicationInfo.FLAG_IS_GAME) != 0
    }

    private fun appName(pkg: String): String = runCatching { packageManager.getApplicationInfo(pkg, 0).loadLabel(packageManager).toString() }.getOrDefault(pkg)

    /** The current screen as numbered elements (ids are valid until the next read). */
    fun snapshot(maxElements: Int = 70): ScreenSnapshot {
        nodes.clear()
        val root = rootInActiveWindow ?: return ScreenSnapshot("unknown", "Unknown", emptyList())
        val pkg = root.packageName?.toString() ?: "unknown"
        // Jarvis never operates its own screens (it could otherwise answer its own approval prompts).
        if (pkg == packageName) return ScreenSnapshot(pkg, "Jarvis", emptyList(), ownApp = true).also { last = it }
        if (isGame(pkg)) return ScreenSnapshot(pkg, appName(pkg), emptyList(), isGame = true).also { last = it }
        val out = mutableListOf<UiElement>()
        var truncated = false

        fun ownText(n: AccessibilityNodeInfo): String = if (n.isPassword) "" else listOfNotNull(n.text?.toString(), n.hintText?.toString().takeIf { n.text.isNullOrBlank() }).joinToString(" ").replace(Regex("\\s+"), " ").trim()
        fun descendantText(n: AccessibilityNodeInfo, depth: Int = 0, acc: MutableList<String> = mutableListOf()): MutableList<String> {
            if (depth > 6 || acc.size >= 4) return acc
            for (i in 0 until n.childCount) {
                val c = n.getChild(i) ?: continue
                if (!c.isVisibleToUser) continue
                ownText(c).takeIf { it.isNotBlank() }?.let { acc += it } ?: c.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { acc += it }
                descendantText(c, depth + 1, acc)
            }
            return acc
        }
        fun role(n: AccessibilityNodeInfo): String {
            val cls = n.className?.toString()?.substringAfterLast('.') ?: ""
            return when {
                n.isEditable -> "field"
                cls.contains("CheckBox") -> "checkbox"
                cls.contains("Switch") || cls.contains("Toggle") -> "switch"
                cls.contains("Button") -> "button"
                cls.contains("Image") -> if (n.isClickable) "button" else "image"
                cls.contains("RecyclerView") || cls.contains("ListView") || cls.contains("ScrollView") || cls.contains("Pager") -> "list"
                cls.contains("Tab") -> "tab"
                n.isClickable -> "item"
                else -> "text"
            }
        }
        fun visit(n: AccessibilityNodeInfo, insideLabelled: Boolean, depth: Int) {
            if (out.size >= maxElements) { truncated = true; return }
            if (depth > 40 || !n.isVisibleToUser) return
            val text = ownText(n)
            val desc = n.contentDescription?.toString()?.trim().orEmpty()
            val interactive = n.isClickable || n.isEditable || n.isCheckable
            var labelled = insideLabelled
            if (interactive || n.isScrollable || ((text.isNotBlank() || desc.isNotBlank()) && !insideLabelled)) {
                // A tappable row without its own text (an email in a list) is labelled with what's inside it.
                val label = if (n.isClickable && text.isBlank() && desc.isBlank()) descendantText(n).joinToString(" · ").take(140) else text
                if (label.isNotBlank() || desc.isNotBlank() || n.isEditable || n.isScrollable || n.isPassword) {
                    val id = out.size + 1
                    nodes[id] = n
                    out += UiElement(id, role(n), label, desc.takeIf { it != label }.orEmpty(), n.isClickable, n.isEditable, n.isScrollable, n.isPassword, if (n.isCheckable) n.isChecked else null, n.isSelected)
                    if (n.isClickable && text.isBlank() && desc.isBlank()) labelled = true
                }
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { visit(it, labelled, depth + 1) }
        }
        visit(root, false, 0)
        return ScreenSnapshot(pkg, appName(pkg), out, truncated = truncated).also { last = it }
    }

    fun element(id: Int): AccessibilityNodeInfo? = nodes[id]

    /** The last screen Jarvis read (what element numbers refer to). */
    @Volatile var last: ScreenSnapshot? = null
        private set

    /** Tap an element: its own click action, an ancestor's, or a real tap at its centre. */
    fun tap(id: Int): Boolean {
        val n = nodes[id] ?: return false
        var c: AccessibilityNodeInfo? = n
        var depth = 0
        while (c != null && depth < 5) {
            if (c.isClickable && c.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            c = c.parent
            depth++
        }
        val r = Rect().also { n.getBoundsInScreen(it) }
        // Never tap Jarvis's own overlay (approve/deny buttons) with a synthetic gesture.
        if (overlay?.bounds()?.contains(r.centerX(), r.centerY()) == true) return false
        return gesture(Path().apply { moveTo(r.exactCenterX(), r.exactCenterY()) }, 60)
    }

    fun type(id: Int, text: String): Boolean {
        val n = nodes[id] ?: return false
        if (n.isPassword) return false
        if (!n.isFocused) n.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        return n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) })
    }

    /** Scroll the main list, or swipe if nothing on screen scrolls. */
    fun scroll(down: Boolean): Boolean {
        val scrollable = nodes.values.filter { it.isScrollable }.maxByOrNull { Rect().also { r -> it.getBoundsInScreen(r) }.let { r -> r.width() * r.height() } }
        if (scrollable?.performAction(if (down) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD) == true) return true
        val dm = resources.displayMetrics
        val x = dm.widthPixels / 2f
        val (from, to) = if (down) dm.heightPixels * 0.7f to dm.heightPixels * 0.3f else dm.heightPixels * 0.3f to dm.heightPixels * 0.7f
        return gesture(Path().apply { moveTo(x, from); lineTo(x, to) }, 350)
    }

    fun back() = performGlobalAction(GLOBAL_ACTION_BACK)
    fun home() = performGlobalAction(GLOBAL_ACTION_HOME)

    private fun gesture(path: Path, durationMs: Long): Boolean =
        dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, durationMs)).build(), null, null)

    companion object {
        @Volatile var instance: PhoneControlService? = null
            private set
        private val _connected = MutableStateFlow(false)
        /** True while the user has phone control switched on (the service is bound). */
        val connected: StateFlow<Boolean> = _connected

        /** Whether the user has switched it on in Accessibility settings (even if not bound yet). */
        fun enabledInSettings(context: Context): Boolean {
            val list = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            return list.split(':').any { it.equals("${context.packageName}/${PhoneControlService::class.java.name}", true) || it.endsWith("/.control.PhoneControlService") && it.startsWith(context.packageName) }
        }
    }
}
