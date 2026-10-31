package net.leviro.levix

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PanelWireExactTest {
    @Test fun exactLengthCopiesAndReportsBytes() {
        val input = ByteArray(130_000) { (it % 251).toByte() }
        val output = ByteArrayOutputStream()
        var last = 0L
        assertEquals(input.size.toLong(), PanelWire.writeExact(ByteArrayInputStream(input), output,
            input.size.toLong()) { last = it })
        assertEquals(input.size.toLong(), last)
        assertArrayEquals(input, output.toByteArray())
    }

    @Test fun exactLengthRefusesShortAndLongSources() {
        assertThrows(PanelWire.WrongLength::class.java) {
            PanelWire.writeExact(ByteArrayInputStream(byteArrayOf(1)), ByteArrayOutputStream(), 2)
        }
        assertThrows(PanelWire.WrongLength::class.java) {
            PanelWire.writeExact(ByteArrayInputStream(byteArrayOf(1, 2)), ByteArrayOutputStream(), 1)
        }
    }
}
