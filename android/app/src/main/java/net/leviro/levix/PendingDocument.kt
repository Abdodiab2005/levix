package net.leviro.levix

import java.util.concurrent.atomic.AtomicInteger

/** A created document is discarded once unless a completed transfer keeps it. */
internal class PendingDocument(private val delete: () -> Unit) {
    private val state = AtomicInteger(0) // 0 pending, 1 kept, 2 discarded

    fun keep(): Boolean = state.compareAndSet(0, 1)

    fun discard() {
        if (state.compareAndSet(0, 2)) delete()
    }
}
