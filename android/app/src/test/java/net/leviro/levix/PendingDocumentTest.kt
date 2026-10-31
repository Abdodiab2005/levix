package net.leviro.levix

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Test

class PendingDocumentTest {
    @Test fun queuedCancellationDiscardsOnce() {
        var deletes = 0
        val destination = PendingDocument { deletes++ }
        destination.discard()
        destination.discard()
        assertFalse(destination.keep())
        assertEquals(1, deletes)
    }

    @Test fun completedSaveSurvivesLaterCleanup() {
        var deletes = 0
        val destination = PendingDocument { deletes++ }
        assertTrue(destination.keep())
        destination.discard()
        assertEquals(0, deletes)
    }
}
