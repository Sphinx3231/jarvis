package ai.jarvis.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** The desktop Jarvis palette: near-black, deep violet, electric purple, lavender. */
object J {
    val Bg = Color(0xFF07050E)
    val Bg2 = Color(0xFF0D0820)
    val Panel = Color(0xCC140E2C)
    val Line = Color(0x338B5CF6)
    val LineStrong = Color(0x66A78BFA)
    val Purple = Color(0xFF8B5CF6)
    val PurpleDeep = Color(0xFF5B21B6)
    val Lavender = Color(0xFFC4B5FD)
    val Text = Color(0xFFECE9F6)
    val TextDim = Color(0xFFA8A2C0)
    val TextFaint = Color(0xFF6E6889)
    val Ok = Color(0xFF4ADE80)
    val Warn = Color(0xFFFBBF24)
    val Bad = Color(0xFFF87171)
    val Cyan = Color(0xFF67E8F9)
}

private val scheme = darkColorScheme(
    primary = J.Purple, onPrimary = Color.White, secondary = J.Lavender, background = J.Bg, onBackground = J.Text,
    surface = J.Bg2, onSurface = J.Text, surfaceVariant = J.Panel, onSurfaceVariant = J.TextDim, error = J.Bad, outline = J.Line,
)

val HudLabel = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.2.sp, color = J.Lavender)

@Composable
fun JarvisTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = scheme,
        typography = Typography(
            headlineSmall = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Bold, letterSpacing = 3.sp, color = J.Text),
            titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp, color = J.Text),
            bodyMedium = TextStyle(fontSize = 14.sp, color = J.Text),
            bodySmall = TextStyle(fontSize = 12.sp, color = J.TextDim),
            labelSmall = HudLabel,
        ),
        content = content,
    )
}
