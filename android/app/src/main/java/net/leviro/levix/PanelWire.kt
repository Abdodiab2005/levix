package net.leviro.levix

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/** HTTP body framing kept independent of Android for stream tests. */
object PanelWire {
    class TooLarge : IOException("source exceeds upload limit")
    data class Response(val status: Int, val reason: String, val headers: Map<String, String>, val bytes: Long) {
        fun header(name: String) = headers.entries.firstOrNull { it.key.equals(name, true) }?.value
    }

    fun writeChunked(source: InputStream, output: OutputStream, maxBytes: Long): Long {
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val count = source.read(buffer)
            if (count < 0) break
            if (count == 0) continue
            total += count
            if (total > maxBytes) throw TooLarge()
            output.write("${count.toString(16)}\r\n".toByteArray(Charsets.US_ASCII))
            output.write(buffer, 0, count)
            output.write("\r\n".toByteArray(Charsets.US_ASCII))
        }
        output.write("0\r\n\r\n".toByteArray(Charsets.US_ASCII))
        output.flush()
        return total
    }

    fun readResponse(input: InputStream, output: OutputStream, maxBytes: Long = Long.MAX_VALUE): Response =
        readResponse(input, maxBytes) { output }

    fun readResponse(input: InputStream, maxBytes: Long = Long.MAX_VALUE, outputFor: (Response) -> OutputStream): Response =
        readResponse(input, { maxBytes }, outputFor)

    fun readResponse(input: InputStream, limitFor: (Response) -> Long, outputFor: (Response) -> OutputStream,
        truncateAtLimit: Boolean = false): Response {
        val statusLine = line(input) ?: throw IOException("empty response")
        val parts = statusLine.split(' ', limit = 3)
        val status = parts.getOrNull(1)?.toIntOrNull() ?: throw IOException("bad status")
        val headers = linkedMapOf<String, String>()
        while (true) {
            val next = line(input) ?: throw IOException("incomplete headers")
            if (next.isEmpty()) break
            val colon = next.indexOf(':')
            if (colon > 0) headers[next.substring(0, colon).trim()] = next.substring(colon + 1).trim()
        }
        val response = Response(status, parts.getOrNull(2) ?: "", headers, 0)
        val maxBytes = limitFor(response)
        val output = outputFor(response)
        val length = response.header("Content-Length")?.toLongOrNull()
        var copied = 0L
        fun copy(count: Long): Boolean {
            if (count < 0) throw IOException("bad length")
            val truncated = count > maxBytes - copied
            if (truncated && !truncateAtLimit) throw TooLarge()
            val buffer = ByteArray(64 * 1024)
            var remaining = minOf(count, maxBytes - copied)
            while (remaining > 0) {
                val n = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                if (n < 0) throw IOException("truncated response")
                output.write(buffer, 0, n)
                remaining -= n
                copied += n
            }
            return !truncated
        }
        if (status != 204 && status != 304 && status >= 200) {
            if (response.header("Transfer-Encoding")?.contains("chunked", true) == true) {
                while (true) {
                    val size = line(input)?.substringBefore(';')?.trim()?.toLongOrNull(16)
                        ?: throw IOException("bad chunk")
                    if (size == 0L) {
                        while (true) {
                            val trailer = line(input) ?: throw IOException("truncated trailer")
                            if (trailer.isEmpty()) break
                        }
                        break
                    }
                    if (!copy(size)) return response.copy(bytes = copied)
                    if (line(input) != "") throw IOException("bad chunk terminator")
                }
            } else if (length != null) {
                if (!copy(length)) return response.copy(bytes = copied)
            } else {
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    if (n > maxBytes - copied) {
                        if (!truncateAtLimit) throw TooLarge()
                        val keep = (maxBytes - copied).toInt()
                        output.write(buffer, 0, keep)
                        copied += keep
                        return response.copy(bytes = copied)
                    }
                    output.write(buffer, 0, n)
                    copied += n
                }
            }
        }
        return response.copy(bytes = copied)
    }

    private fun line(input: InputStream): String? {
        val out = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return if (out.size() == 0) null else throw IOException("truncated line")
            if (b == '\n'.code) break
            if (b != '\r'.code) out.write(b)
            if (out.size() > 64 * 1024) throw IOException("line too long")
        }
        return out.toString(Charsets.ISO_8859_1.name())
    }
}
