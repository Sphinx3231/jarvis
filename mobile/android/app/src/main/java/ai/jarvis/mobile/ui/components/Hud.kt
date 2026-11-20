package ai.jarvis.mobile.ui.components

import ai.jarvis.mobile.ui.theme.HudLabel
import ai.jarvis.mobile.ui.theme.J
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.shape.GenericShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/** A panel with two chamfered corners, the desktop HUD's signature shape. */
fun chamfer(cutPx: Float = 30f): Shape = GenericShape { size, _ ->
    val k = min(cutPx, min(size.width, size.height) / 3)
    moveTo(k, 0f); lineTo(size.width, 0f); lineTo(size.width, size.height - k)
    lineTo(size.width - k, size.height); lineTo(0f, size.height); lineTo(0f, k); close()
}

/** Layered background: deep gradient, a soft violet bloom and a faint grid. Static (no battery cost). */
@Composable
fun JarvisBackdrop(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(modifier.fillMaxSize().background(Brush.verticalGradient(listOf(J.Bg2, J.Bg, Color(0xFF05030B))))) {
        Canvas(Modifier.fillMaxSize()) {
            drawCircle(Brush.radialGradient(listOf(Color(0x335B21B6), Color.Transparent), center = Offset(size.width * 0.5f, size.height * 0.28f), radius = size.width * 0.9f), radius = size.width * 0.9f, center = Offset(size.width * 0.5f, size.height * 0.28f))
            val step = 32.dp.toPx()
            val grid = Color(0x0D8B5CF6)
            var x = 0f
            while (x < size.width) { drawLine(grid, Offset(x, 0f), Offset(x, size.height), 1f); x += step }
            var y = 0f
            while (y < size.height) { drawLine(grid, Offset(0f, y), Offset(size.width, y), 1f); y += step }
        }
        content()
    }
}

@Composable
fun HudPanel(modifier: Modifier = Modifier, title: String? = null, trailing: (@Composable () -> Unit)? = null, onClick: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    val shape = chamfer()
    Column(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Brush.linearGradient(listOf(Color(0xE0160F30), Color(0xCC0C0820))))
            .border(BorderStroke(1.dp, Brush.linearGradient(listOf(J.LineStrong, J.Line, Color(0x1A8B5CF6)))), shape)
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(14.dp),
    ) {
        if (title != null) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                Box(Modifier.size(6.dp).background(J.Purple))
                Spacer(Modifier.width(8.dp))
                Text(title.uppercase(), style = HudLabel, modifier = Modifier.weight(1f))
                trailing?.invoke()
            }
        }
        content()
    }
}

/** Small status pill. */
@Composable
fun Chip(text: String, color: Color, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        color = color,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.4.sp,
        maxLines = 1,
        modifier = modifier.border(1.dp, color.copy(alpha = 0.55f), RoundedCornerShape(3.dp)).background(color.copy(alpha = 0.10f), RoundedCornerShape(3.dp)).padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
fun StatusDot(color: Color, modifier: Modifier = Modifier) {
    Box(modifier.size(8.dp).clip(CircleShape).background(color))
}

/** What the core is showing. Mirrors the real assistant state; never animated as "busy" when idle. */
enum class CoreMode { IDLE, LISTENING, THINKING, WORKING, WAITING, ERROR, OFFLINE }

/**
 * The Jarvis core: concentric instrument rings, tick scale, rotating arc segments and a luminous
 * nucleus. Speed and colour follow [mode]; OFFLINE is static and dim.
 */
@Composable
fun JarvisCore(mode: CoreMode, modifier: Modifier = Modifier, label: String = mode.name) {
    val accent = when (mode) {
        CoreMode.ERROR -> J.Bad
        CoreMode.WAITING -> J.Warn
        CoreMode.LISTENING -> J.Cyan
        CoreMode.OFFLINE -> J.TextFaint
        else -> J.Purple
    }
    val speed = when (mode) { CoreMode.THINKING, CoreMode.WORKING -> 4_000; CoreMode.LISTENING -> 6_000; CoreMode.OFFLINE -> 0; else -> 18_000 }
    val t = rememberInfiniteTransition(label = "core")
    val spin by t.animateFloat(0f, if (speed == 0) 0f else 360f, infiniteRepeatable(tween(if (speed == 0) 1000 else speed, easing = LinearEasing)), label = "spin")
    val pulse by t.animateFloat(0.85f, if (mode == CoreMode.OFFLINE) 0.85f else 1f, infiniteRepeatable(tween(if (mode == CoreMode.IDLE) 2600 else 900), RepeatMode.Reverse), label = "pulse")
    Canvas(modifier.semantics { contentDescription = "Jarvis core: $label" }) {
        val r = min(size.width, size.height) / 2
        val c = center
        // outer bezel + tick scale
        drawCircle(accent.copy(alpha = 0.16f), r * 0.98f, c, style = Stroke(1.dp.toPx()))
        for (i in 0 until 72) {
            val a = Math.toRadians(i * 5.0)
            val long = i % 6 == 0
            val r1 = r * (if (long) 0.86f else 0.9f)
            drawLine(accent.copy(alpha = if (long) 0.55f else 0.22f), Offset(c.x + r1 * cos(a).toFloat(), c.y + r1 * sin(a).toFloat()), Offset(c.x + r * 0.94f * cos(a).toFloat(), c.y + r * 0.94f * sin(a).toFloat()), if (long) 2f else 1f)
        }
        // rotating segmented arcs (opposite directions)
        rotate(spin, c) { arcs(accent, r * 0.78f, 3.dp.toPx(), listOf(0f to 70f, 95f to 40f, 180f to 85f, 290f to 30f)) }
        rotate(-spin * 1.6f, c) { arcs(J.Lavender.copy(alpha = 0.7f), r * 0.66f, 1.5.dp.toPx(), listOf(20f to 120f, 200f to 110f)) }
        rotate(spin * 0.5f, c) { arcs(accent.copy(alpha = 0.45f), r * 0.56f, 6.dp.toPx(), (0 until 12).map { it * 30f to 14f }) }
        // inner hex lattice ring
        drawCircle(accent.copy(alpha = 0.25f), r * 0.46f, c, style = Stroke(1.dp.toPx()))
        for (i in 0 until 6) {
            val a = Math.toRadians(i * 60.0 + spin / 3)
            val a2 = Math.toRadians((i + 1) * 60.0 + spin / 3)
            drawLine(accent.copy(alpha = 0.35f), Offset(c.x + r * 0.46f * cos(a).toFloat(), c.y + r * 0.46f * sin(a).toFloat()), Offset(c.x + r * 0.46f * cos(a2).toFloat(), c.y + r * 0.46f * sin(a2).toFloat()), 1.2f)
            drawLine(accent.copy(alpha = 0.18f), c, Offset(c.x + r * 0.46f * cos(a).toFloat(), c.y + r * 0.46f * sin(a).toFloat()), 1f)
        }
        // nucleus
        drawCircle(Brush.radialGradient(listOf(Color.White.copy(alpha = 0.95f * pulse), accent.copy(alpha = 0.75f * pulse), Color.Transparent), c, r * 0.34f), r * 0.34f, c)
        drawCircle(accent.copy(alpha = 0.9f), r * 0.2f * pulse, c, style = Stroke(2.dp.toPx()))
    }
}

private fun DrawScope.arcs(color: Color, radius: Float, width: Float, segments: List<Pair<Float, Float>>) {
    val tl = Offset(center.x - radius, center.y - radius)
    for ((start, sweep) in segments) drawArc(color, start, sweep, false, tl, Size(radius * 2, radius * 2), style = Stroke(width, cap = StrokeCap.Butt))
}

/** An agent node: coloured ring, initial, live state. Dimmed when the agent can't run in this mode. */
@Composable
fun AgentOrb(name: String, color: Color, working: Boolean, available: Boolean, modifier: Modifier = Modifier, size: Dp = 52.dp, onClick: () -> Unit = {}) {
    val t = rememberInfiniteTransition(label = "orb")
    val spin by t.animateFloat(0f, if (working) 360f else 0f, infiniteRepeatable(tween(2200, easing = LinearEasing)), label = "orb-spin")
    val alpha = if (available) 1f else 0.38f
    Column(modifier.clickable(onClick = onClick).semantics { contentDescription = "$name agent, ${if (working) "working" else "idle"}${if (available) "" else ", not available in this mode"}" }, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.size(size)) {
            Canvas(Modifier.fillMaxSize()) {
                val r = this.size.minDimension / 2
                drawCircle(Brush.radialGradient(listOf(color.copy(alpha = 0.35f * alpha), Color.Transparent)), r)
                drawCircle(color.copy(alpha = 0.8f * alpha), r * 0.86f, style = Stroke(1.5.dp.toPx()))
                rotate(spin) { arcs(color.copy(alpha = alpha), r * 0.72f, 2.5.dp.toPx(), if (working) listOf(0f to 90f, 180f to 90f) else listOf(0f to 40f, 120f to 40f, 240f to 40f)) }
            }
            Text(name.take(1), color = Color.White.copy(alpha = alpha), fontWeight = FontWeight.Bold, fontSize = 16.sp)
        }
        Text(name.uppercase(), color = J.TextDim.copy(alpha = alpha), fontSize = 10.sp, letterSpacing = 1.2.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Segmented horizontal gauge (task progress). */
@Composable
fun SegmentGauge(value: Float, color: Color, modifier: Modifier = Modifier, segments: Int = 20) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        val lit = (value.coerceIn(0f, 1f) * segments).toInt()
        repeat(segments) { i -> Box(Modifier.weight(1f).padding(vertical = 0.dp).size(height = 6.dp, width = 1.dp).background(if (i < lit) color else color.copy(alpha = 0.14f))) }
    }
}
