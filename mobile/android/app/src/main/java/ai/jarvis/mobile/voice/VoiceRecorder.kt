package ai.jarvis.mobile.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt

/**
 * Records a voice command for on-device transcription (16 kHz mono PCM, the model's input format).
 * Push-to-talk: it starts on the user's tap and stops on a second tap, after a pause in speech, or
 * after 30 s. Nothing is recorded in the background.
 */
class VoiceRecorder(private val outFile: File) {
    data class State(val recording: Boolean = false, val level: Float = 0f, val heardSpeech: Boolean = false)

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state
    @Volatile private var stopRequested = false
    private var thread: Thread? = null

    /** Needs RECORD_AUDIO (requested by the UI). [onDone] gets the WAV, or null if nothing was said. */
    @SuppressLint("MissingPermission")
    fun start(onDone: (File?) -> Unit) {
        if (thread?.isAlive == true) return
        stopRequested = false
        val minBuf = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, RATE / 5 * 2))
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); onDone(null); return }
        _state.value = State(recording = true)
        thread = Thread {
            val pcm = ByteArrayOutputStream()
            val frame = ShortArray(RATE / 50) // 20 ms
            val vad = Vad()
            try {
                rec.startRecording()
                while (!stopRequested) {
                    val n = rec.read(frame, 0, frame.size)
                    if (n <= 0) continue
                    val bytes = ByteBuffer.allocate(n * 2).order(ByteOrder.LITTLE_ENDIAN).apply { for (i in 0 until n) putShort(frame[i]) }.array()
                    pcm.write(bytes)
                    val level = rms(frame, n)
                    val stop = vad.feed(level, 20)
                    _state.value = State(recording = true, level = (level / 3000f).coerceIn(0f, 1f), heardSpeech = vad.heardSpeech)
                    if (stop) break
                }
            } finally {
                runCatching { rec.stop() }
                rec.release()
            }
            _state.value = State()
            if (!vad.heardSpeech) { onDone(null); return@Thread }
            outFile.parentFile?.mkdirs()
            outFile.writeBytes(wav(pcm.toByteArray(), RATE))
            onDone(outFile)
        }.apply { name = "jarvis-voice"; start() }
    }

    fun stop() { stopRequested = true }

    companion object {
        const val RATE = 16_000

        fun rms(frame: ShortArray, n: Int): Float {
            var sum = 0.0
            for (i in 0 until n) sum += frame[i].toDouble() * frame[i]
            return sqrt(sum / maxOf(1, n)).toFloat()
        }

        /** A 16-bit mono PCM WAV file. */
        fun wav(pcm: ByteArray, rate: Int): ByteArray = ByteBuffer.allocate(44 + pcm.size).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray()); putInt(36 + pcm.size); put("WAVE".toByteArray())
            put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1); putInt(rate); putInt(rate * 2); putShort(2); putShort(16)
            put("data".toByteArray()); putInt(pcm.size); put(pcm)
        }.array()
    }
}

/**
 * Energy-based end-of-speech detection: learns the background level from the first 300 ms, counts
 * speech when the level is well above it, and stops after 1.2 s of quiet following speech, after
 * 6 s with no speech at all, or at 30 s.
 */
class Vad(private val silenceMs: Int = 1200, private val noSpeechMs: Int = 6000, private val maxMs: Int = 30_000) {
    var heardSpeech = false
        private set
    private var elapsed = 0
    private var quiet = 0
    private var noise = 0f
    private var calibrated = 0

    fun feed(level: Float, frameMs: Int): Boolean {
        elapsed += frameMs
        if (calibrated < 300) { noise = if (calibrated == 0) level else noise * 0.8f + level * 0.2f; calibrated += frameMs; return false }
        val threshold = maxOf(noise * 3f, 450f)
        if (level > threshold) { heardSpeech = true; quiet = 0 } else { quiet += frameMs; if (!heardSpeech) noise = noise * 0.98f + level * 0.02f }
        return elapsed >= maxMs || (heardSpeech && quiet >= silenceMs) || (!heardSpeech && elapsed >= noSpeechMs)
    }
}
