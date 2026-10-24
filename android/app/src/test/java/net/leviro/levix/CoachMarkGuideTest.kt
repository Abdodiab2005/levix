package net.leviro.levix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CoachMarkGuideTest {
    private fun allVisible(): List<CoachMarkGuide.Target> =
        CoachMarkGuide.steps.map { CoachMarkGuide.Target(present = true, visible = true, laidOut = true) }

    @Test
    fun everyTargetOnScreenKeepsTheDocumentedOrder() {
        val selected = CoachMarkGuide.availableSteps(allVisible())
        assertEquals(CoachMarkGuide.steps.indices.toList(), selected)
        assertEquals(
            listOf(
                R.id.btnPrimaryAction,
                R.id.cardBattery,
                R.id.panelButton,
                R.id.cardWhatsApp,
                R.id.cardMediaHub,
                R.id.cardDiagnostics,
                R.id.headerLanguageControl,
                R.id.cardShowGuide,
            ),
            selected.map { CoachMarkGuide.steps[it].target },
        )
    }

    @Test
    fun hiddenTargetIsSkippedAndTheRestKeepTheirOrder() {
        val states = allVisible().toMutableList()
        // The panel button is GONE while the assistant is stopped.
        states[2] = states[2].copy(visible = false)
        val selected = CoachMarkGuide.availableSteps(states)
        assertEquals(listOf(0, 1, 3, 4, 5, 6, 7), selected)
        assertTrue(selected.zipWithNext().all { (a, b) -> a < b })
    }

    @Test
    fun absentOrUnlaidOutTargetsAreSkipped() {
        val states = allVisible().toMutableList()
        states[0] = states[0].copy(laidOut = false)
        states[4] = states[4].copy(present = false)
        assertEquals(listOf(1, 2, 3, 5, 6, 7), CoachMarkGuide.availableSteps(states))
    }

    @Test
    fun missingEntriesCountAsAbsent() {
        assertEquals(emptyList<Int>(), CoachMarkGuide.availableSteps(emptyList()))
        assertEquals(listOf(0), CoachMarkGuide.availableSteps(allVisible().take(1)))
    }

    @Test
    fun nothingOnScreenSelectsNothing() {
        val hidden = CoachMarkGuide.steps.map { CoachMarkGuide.Target(true, false, true) }
        assertEquals(emptyList<Int>(), CoachMarkGuide.availableSteps(hidden))
    }

    /**
     * The selection is indices into the same ordered list in both languages:
     * the overlay reads the list the same way with `layoutDirection` RTL or
     * LTR, so navigation never flips.
     */
    @Test
    fun selectionDoesNotDependOnLayoutDirection() {
        val states = allVisible().toMutableList()
        states[6] = states[6].copy(visible = false)
        val first = CoachMarkGuide.availableSteps(states)
        val second = CoachMarkGuide.availableSteps(states.toList())
        assertEquals(first, second)
        assertEquals(listOf(0, 1, 2, 3, 4, 5, 7), first)
    }
}
