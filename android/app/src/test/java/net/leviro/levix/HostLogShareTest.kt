package net.leviro.levix

import org.junit.Assert.assertEquals
import org.junit.Test

class HostLogShareTest {
    @Test fun savedLogsAreNamedByTheirStamp() {
        assertEquals("levix-host-20261017-093000.log", HostLogShare.savedFileName("20261017-093000"))
    }
}
