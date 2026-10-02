package net.leviro.levix

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import org.junit.Assert.*
import org.junit.Test

class PanelWireTest {
    @Test fun chunkedRequestAndCap() {
        val out = ByteArrayOutputStream()
        assertEquals(5L, PanelWire.writeChunked(ByteArrayInputStream("hello".toByteArray()), out, 5))
        assertEquals("5\r\nhello\r\n0\r\n\r\n", out.toString("UTF-8"))
        val refused = ByteArrayOutputStream()
        try {
            PanelWire.writeChunked(ByteArrayInputStream("123456".toByteArray()), refused, 5)
            fail("expected size cap")
        } catch (_: PanelWire.TooLarge) { }
        assertEquals(0, refused.size())
    }

    @Test fun contentLengthAndChunkedResponseStream() {
        val fixed = ByteArrayOutputStream()
        val one = PanelWire.readResponse(ByteArrayInputStream(
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: image/webp\r\n\r\nhello".toByteArray()), fixed)
        assertEquals(5L, one.bytes)
        assertEquals("image/webp", one.header("content-type"))
        assertEquals("hello", fixed.toString("UTF-8"))
        val chunked = ByteArrayOutputStream()
        val two = PanelWire.readResponse(ByteArrayInputStream(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n".toByteArray()), chunked)
        assertEquals(5L, two.bytes)
        assertEquals("abcde", chunked.toString("UTF-8"))
    }

    @Test fun errorBodyCap() {
        val body = ByteArrayOutputStream()
        val response = PanelWire.readResponse(ByteArrayInputStream(
            "HTTP/1.1 413 Too Large\r\nContent-Length: 6\r\n\r\n123456".toByteArray()),
            { 5L }, { body }, truncateAtLimit = true)
        assertEquals(413, response.status)
        assertEquals("12345", body.toString("UTF-8"))
        val chunked = ByteArrayOutputStream()
        PanelWire.readResponse(ByteArrayInputStream(
            "HTTP/1.1 400 Bad\r\nTransfer-Encoding: chunked\r\n\r\n6\r\nabcdef\r\n0\r\n\r\n".toByteArray()),
            { 4L }, { chunked }, truncateAtLimit = true)
        assertEquals("abcd", chunked.toString("UTF-8"))
    }
}
