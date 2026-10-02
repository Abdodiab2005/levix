package net.leviro.levix

import java.security.SecureRandom

/** Short-lived, activity-owned references to files granted by Android. */
class StickerSources(private val now: () -> Long = System::currentTimeMillis) {
    data class Source(val uri: String, val name: String, val mime: String, val size: Long)
    private data class Entry(val source: Source, val added: Long)
    private val random = SecureRandom()
    private val entries = linkedMapOf<String, Entry>()

    @Synchronized fun register(uri: String, name: String, mime: String, size: Long): String {
        expire()
        while (entries.size >= 8) entries.remove(entries.keys.first())
        val bytes = ByteArray(16)
        var token: String
        do {
            random.nextBytes(bytes)
            token = bytes.joinToString("") { "%02x".format(it) }
        } while (entries.containsKey(token))
        val safeMime = mime.substringBefore(';').trim().take(120)
            .takeIf { it.matches(Regex("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+")) }
            ?: "application/octet-stream"
        entries[token] = Entry(Source(uri, name.take(120), safeMime, size), now())
        return token
    }

    @Synchronized fun get(token: String): Source? {
        expire()
        return entries[token]?.source
    }

    @Synchronized fun remove(token: String) { entries.remove(token) }
    @Synchronized fun clear() { entries.clear() }

    private fun expire() {
        val time = now()
        entries.entries.removeAll { time - it.value.added >= 60 * 60 * 1000L }
    }
}
