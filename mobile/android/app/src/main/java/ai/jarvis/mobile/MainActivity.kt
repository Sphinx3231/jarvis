package ai.jarvis.mobile

import ai.jarvis.mobile.ui.JarvisApp
import ai.jarvis.mobile.ui.theme.JarvisTheme
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

class MainActivity : ComponentActivity() {
    /** A jarvis://pair link this activity was opened with. Only shown for confirmation; never auto-paired. */
    private var deepLink by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) deepLink = pairLink(intent)
        val container = (application as JarvisApplication).container
        setContent { JarvisTheme { JarvisApp(container, deepLink) { deepLink = null } } }
    }

    override fun onStart() {
        super.onStart()
        (application as JarvisApplication).container.reconnectNow()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        pairLink(intent)?.let { deepLink = it }
    }

    private fun pairLink(i: Intent?): String? = i?.data?.toString()?.takeIf { it.startsWith("jarvis://pair") }
}
