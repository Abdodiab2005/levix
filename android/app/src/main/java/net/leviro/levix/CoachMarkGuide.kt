package net.leviro.levix

/**
 * The home-screen tour, in the order an operator meets it.
 *
 * Kept free of Android view types: the overlay reports what it can learn about
 * each target, and [availableSteps] decides which stops are worth showing. A
 * step whose control is hidden by the current host state (the panel button
 * while the assistant is stopped, for instance) is skipped instead of
 * spotlighting a hole in an empty card. Nothing here looks at layout
 * direction, so the order is identical in Arabic and in English.
 */
object CoachMarkGuide {
    /** One tour stop: the view it points at and the two strings it says. */
    data class Step(val target: Int, val title: Int, val body: Int)

    /** What the overlay can learn about a target without handing over a View. */
    data class Target(val present: Boolean, val visible: Boolean, val laidOut: Boolean)

    val steps: List<Step> = listOf(
        Step(R.id.btnPrimaryAction, R.string.guide_start_title, R.string.guide_start_body),
        Step(R.id.cardBattery, R.string.guide_battery_title, R.string.guide_battery_body),
        Step(R.id.panelButton, R.string.guide_panel_title, R.string.guide_panel_body),
        Step(R.id.cardWhatsApp, R.string.guide_link_title, R.string.guide_link_body),
        Step(R.id.cardMediaHub, R.string.guide_media_title, R.string.guide_media_body),
        Step(R.id.cardDiagnostics, R.string.guide_privacy_title, R.string.guide_privacy_body),
        Step(R.id.headerLanguageControl, R.string.guide_header_title, R.string.guide_header_body),
        Step(R.id.cardShowGuide, R.string.guide_again_title, R.string.guide_again_sub),
    )

    /**
     * Indices into [steps], in tour order, for the targets that are actually
     * on screen. [targets] is positional: entry 0 describes `steps[0]`. A
     * missing entry counts as absent.
     */
    fun availableSteps(targets: List<Target>): List<Int> =
        steps.indices.filter { index ->
            val target = targets.getOrNull(index) ?: return@filter false
            target.present && target.visible && target.laidOut
        }
}
