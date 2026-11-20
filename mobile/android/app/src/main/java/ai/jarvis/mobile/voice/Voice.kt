package ai.jarvis.mobile.voice

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.Locale

/** Text-to-speech on the phone (both modes: Mobile replies and Remote replies from the PC). */
class Speaker(context: Context) {
    @Volatile private var ready = false
    private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status ->
        ready = status == TextToSpeech.SUCCESS
        if (ready) tts.language = Locale.getDefault()
    }

    fun speak(text: String): Boolean {
        if (!ready || text.isBlank()) return false
        tts.speak(text.take(TextToSpeech.getMaxSpeechInputLength() - 1), TextToSpeech.QUEUE_FLUSH, null, "jarvis-${System.nanoTime()}")
        return true
    }

    fun stop() = tts.stop()
    fun shutdown() = tts.shutdown()
}

/**
 * Speech recognition with Android's SpeechRecognizer — only while the user holds the mic button
 * (no always-on listening: Android restricts background microphone use, and it would drain the
 * battery). Needs RECORD_AUDIO, requested in the UI when the user first taps the mic.
 */
class SpeechInput(private val context: Context) {
    data class State(val listening: Boolean = false, val partial: String = "", val error: String? = null)

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state
    private var recognizer: SpeechRecognizer? = null

    fun available() = SpeechRecognizer.isRecognitionAvailable(context)

    fun start(onResult: (String) -> Unit) {
        if (!available()) {
            _state.value = State(error = "Speech recognition is not available on this phone")
            return
        }
        stop()
        val r = SpeechRecognizer.createSpeechRecognizer(context)
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { _state.value = State(listening = true) }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() { _state.value = _state.value.copy(listening = false) }
            override fun onError(error: Int) {
                _state.value = State(error = when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Didn't catch that"
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission is needed"
                    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech recognition needs a connection on this phone"
                    else -> "Speech recognition error ($error)"
                })
            }
            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                _state.value = State()
                if (text.isNotBlank()) onResult(text)
            }
            override fun onPartialResults(partialResults: Bundle?) {
                _state.value = _state.value.copy(partial = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty())
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        r.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM).putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true))
    }

    fun stop() {
        recognizer?.destroy()
        recognizer = null
        _state.value = _state.value.copy(listening = false)
    }
}
