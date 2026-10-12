package net.leviro.levix

import java.net.URI
import java.security.MessageDigest

/** Pure capture-time redaction shared by Android crash fields. */
object CrashSanitizer {
    private val jid = Regex("\\S+@(s\\.whatsapp\\.net|g\\.us|lid|broadcast|newsletter)", RegexOption.IGNORE_CASE)
    private val email = Regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")
    private val number = Regex("\\+?\\d{7,}")
    private val url = Regex("https?://[^\\s<>\"']+", RegexOption.IGNORE_CASE)
    private val secret = Regex("[A-Za-z0-9_\\-+/=]{24,}")
    private val controls = Regex("[\\x00-\\x1f\\x7f]")

    fun text(raw: String?, limit: Int, dataDir: String = "", homeDir: String = ""): String {
        var result = raw.orEmpty()
        val urls = mutableListOf<String>()
        result = url.replace(result) { match ->
            val safe = try {
                val uri = URI(match.value)
                val host = uri.host ?: return@replace "<path>"
                "${uri.scheme}://$host/<path>"
            } catch (_: Exception) { "<path>" }
            urls.add(safe)
            "\uE000${urls.lastIndex}\uE001"
        }
        val dataRoot = dataDir.trimEnd('/')
        val homeRoot = homeDir.trimEnd('/')
        if (dataRoot.isNotBlank()) {
            result = Regex(Regex.escape(dataRoot) + "(?=/|$)").replace(result, "<data>")
        }
        if (homeRoot.isNotBlank()) {
            result = Regex(Regex.escape(homeRoot) + "(?=/|$)").replace(result, "~")
        }
        result = jid.replace(result, "<jid>")
        result = email.replace(result, "<email>")
        result = number.replace(result, "<number>")
        result = secret.replace(result) { match ->
            if (match.value.any { it.isDigit() || it in "_-/+=" }) "<secret>"
            else match.value
        }
        for (index in urls.indices) result = result.replace("\uE000$index\uE001", urls[index])
        return controls.replace(result, "").trim().take(limit)
    }

    fun fingerprint(category: String, type: String, stack: List<String>): String {
        val source = "$category|$type|${stack.take(3).joinToString("|")}"
        return MessageDigest.getInstance("SHA-256")
            .digest(source.toByteArray(Charsets.UTF_8))
            .take(8).joinToString("") { "%02x".format(it) }
    }
}
