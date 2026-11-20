package ai.jarvis.mobile

import ai.jarvis.mobile.crypto.E2E
import ai.jarvis.mobile.crypto.SoftwareIdentity
import ai.jarvis.mobile.protocol.Envelope
import ai.jarvis.mobile.protocol.JarvisJson
import ai.jarvis.mobile.protocol.Messages
import ai.jarvis.mobile.protocol.ProtocolException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The Kotlin client against the TypeScript source of truth (shared/protocol). */
class ContractTest {
    private fun fixtures(name: String): File {
        val dir = System.getenv("JARVIS_PROTOCOL_FIXTURES")?.let { File(it) } ?: File("../../../shared/protocol/fixtures")
        return File(dir, name).also { assertTrue("fixtures not found at ${it.absolutePath}", it.exists()) }
    }

    @Test fun everyTypeScriptMessageDecodesAndReEncodesIdentically() {
        val envs = JarvisJson.parseToJsonElement(fixtures("envelopes.json").readText()).jsonArray
        val types = envs.map { it.jsonObject["type"]!!.jsonPrimitive.content }.toSet()
        assertEquals("Kotlin knows exactly the TypeScript message types", types, Messages.ALL)
        for (e in envs) {
            val json = e.toString()
            val env = Envelope.parse(json, checkFreshness = false)
            // Payload decodes into its Kotlin class and re-encodes to the same JSON.
            val s = Messages.PAYLOADS[env.type]!!
            @Suppress("UNCHECKED_CAST")
            val back = JarvisJson.encodeToJsonElement(s as kotlinx.serialization.KSerializer<Any?>, JarvisJson.decodeFromJsonElement(s, env.payload))
            assertEquals("payload round-trip for ${env.type}", norm(e.jsonObject["payload"]!!), norm(back))
            assertEquals("envelope round-trip for ${env.type}", norm(e), norm(JarvisJson.parseToJsonElement(env.toJson())))
        }
    }

    @Test fun validationMatchesTheTypeScriptRules() {
        val env = JarvisJson.parseToJsonElement(fixtures("envelopes.json").readText()).jsonArray.first { it.jsonObject["type"]!!.jsonPrimitive.content == "jarvis.command.submit" }.jsonObject
        fun mutate(k: String, v: String) = JsonObject(env + (k to JarvisJson.parseToJsonElement(v)))
        assertEquals("version", assertThrows(ProtocolException::class.java) { Envelope.parse(mutate("v", "2").toString(), checkFreshness = false) }.code)
        assertEquals("no_idempotency_key", assertThrows(ProtocolException::class.java) { Envelope.parse(JsonObject(env - "idempotencyKey").toString(), checkFreshness = false) }.code)
        assertEquals("bad_payload", assertThrows(ProtocolException::class.java) { Envelope.parse(mutate("payload", "{\"nope\":1}").toString(), checkFreshness = false) }.code)
        assertEquals("stale", assertThrows(ProtocolException::class.java) { Envelope.parse(env.toString()) }.code)
    }

    @Test fun cryptoIsByteIdenticalToNode() {
        val v = JarvisJson.parseToJsonElement(fixtures("crypto-vectors.json").readText()).jsonObject
        fun o(k: String) = v[k]!!.jsonObject
        fun s(obj: JsonObject, k: String) = obj[k]!!.jsonPrimitive.content
        val pc = o("pc")
        val phone = o("phone")
        val pcId = SoftwareIdentity.fromDer(s(pc, "signPriv"), s(pc, "signPub"), s(pc, "agreePriv"), s(pc, "agreePub"))
        val phoneId = SoftwareIdentity.fromDer(s(phone, "signPriv"), s(phone, "signPub"), s(phone, "agreePriv"), s(phone, "agreePub"))
        assertEquals(s(pc, "deviceId"), pcId.deviceId)
        assertEquals(s(phone, "deviceId"), phoneId.deviceId)
        // ECDH + HKDF: the same directional keys as Node, from either side.
        assertEquals(s(v, "messageKeyPhoneToPc"), E2E.hex(E2E.messageKey(phoneId.agree(pcId.agreePubB64), phoneId.deviceId, pcId.deviceId)))
        assertEquals(s(v, "messageKeyPhoneToPc"), E2E.hex(E2E.messageKey(pcId.agree(phoneId.agreePubB64), phoneId.deviceId, pcId.deviceId)))
        assertEquals(s(v, "messageKeyPcToPhone"), E2E.hex(E2E.messageKey(pcId.agree(phoneId.agreePubB64), pcId.deviceId, phoneId.deviceId)))
        // AES-GCM: decrypt Node's ciphertext; encrypting with the same nonce gives the same bytes.
        val sealed = o("sealed")
        val key = E2E.messageKey(phoneId.agree(pcId.agreePubB64), phoneId.deviceId, pcId.deviceId)
        assertEquals(s(sealed, "plaintext"), E2E.open(key, s(sealed, "sealedB64"), s(sealed, "aad").toByteArray()))
        assertEquals(s(sealed, "sealedB64"), E2E.seal(key, s(sealed, "plaintext"), s(sealed, "aad").toByteArray(), E2E.unb64(java.util.Base64.getEncoder().encodeToString(hexBytes(s(sealed, "nonceHex"))))))
        // Tampering or re-addressing fails.
        assertThrows(Exception::class.java) { E2E.open(key, s(sealed, "sealedB64"), E2E.msgAad(pcId.deviceId, phoneId.deviceId)) }
        val pairing = o("pairing")
        assertEquals(s(pairing, "keyHex"), E2E.hex(E2E.pairingKey(s(pairing, "secretB64"), s(pairing, "room"))))
        // Relay authentication: a Kotlin signature verifies (and Node's format is DER, like Java's).
        val msg = o("relayAuth").let { s(it, "message").toByteArray() }
        assertTrue(E2E.verify(phoneId.signPubB64, msg, phoneId.sign(msg)))
        assertFalse(E2E.verify(pcId.signPubB64, msg, phoneId.sign(msg)))
    }

    /** JSON numbers compare by value (0 and 0.0 are the same number to both sides). */
    private fun norm(e: kotlinx.serialization.json.JsonElement): kotlinx.serialization.json.JsonElement = when (e) {
        is JsonObject -> JsonObject(e.mapValues { norm(it.value) })
        is kotlinx.serialization.json.JsonArray -> kotlinx.serialization.json.JsonArray(e.map { norm(it) })
        is kotlinx.serialization.json.JsonPrimitive -> if (!e.isString && e.content.toDoubleOrNull() != null) kotlinx.serialization.json.JsonPrimitive(e.content.toDouble()) else e
        else -> e
    }

    private fun hexBytes(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
