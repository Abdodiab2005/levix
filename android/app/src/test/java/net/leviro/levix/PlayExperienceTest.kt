package net.leviro.levix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure Play policy: installer detection, review consent/cooldown, update-flow
 * outcomes and the status vocabulary. No Play client, Activity or network is
 * involved — these are the decisions the activity host makes before it touches
 * Play at all.
 */
class PlayExperienceTest {
    @Test
    fun onlyThePlayStoreInstallerIsPlay() {
        assertTrue(PlayExperience.isPlayInstaller("com.android.vending"))
        for (installer in listOf(
            null,
            "",
            " ",
            "com.android.vending ",
            " com.android.vending",
            "com.android.vending\n",
            "COM.ANDROID.VENDING",
            "com.android.vending.evil",
            "com.android.vendingx",
            "com.google.android.packageinstaller",
            "com.android.vending/",
        )) {
            assertFalse("installer=$installer", PlayExperience.isPlayInstaller(installer))
        }
    }

    @Test
    fun channelFollowsTheInstallerAndDefaultsToGithub() {
        assertEquals(
            PlayExperience.CHANNEL_PLAY,
            PlayExperience.channelForInstaller("com.android.vending"),
        )
        assertEquals(PlayExperience.CHANNEL_GITHUB, PlayExperience.channelForInstaller(null))
        assertEquals(PlayExperience.CHANNEL_GITHUB, PlayExperience.channelForInstaller(""))
        assertEquals(
            PlayExperience.CHANNEL_GITHUB,
            PlayExperience.channelForInstaller("com.android.vending.evil"),
        )
    }

    @Test
    fun reviewPromptsAreOffByDefault() {
        assertFalse(PlayExperience.REVIEW_PROMPTS_DEFAULT)
        assertEquals(
            PlayExperience.CODE_DISABLED,
            denial(
                Allow(
                    installedByPlay = true,
                    enabled = PlayExperience.REVIEW_PROMPTS_DEFAULT,
                ),
                NOW,
            ),
        )
    }

    @Test
    fun reviewRequiresPlayOptInForegroundAndACleanUpdateCheck() {
        val base = Allow(installedByPlay = true)
        assertNull(denial(base, NOW))
        assertEquals(
            PlayExperience.CODE_UNAVAILABLE,
            denial(base.copy(installedByPlay = false), NOW),
        )
        assertEquals(
            PlayExperience.CODE_DISABLED,
            denial(base.copy(enabled = false), NOW),
        )
        assertEquals(
            PlayExperience.CODE_FOREGROUND,
            denial(base.copy(foreground = false), NOW),
        )
        assertEquals(
            PlayExperience.CODE_CHECK_REQUIRED,
            denial(base.copy(checkedClean = false), NOW),
        )
    }

    @Test
    fun reviewCooldownIsAtLeast120DaysAndNeverAsksTwiceWithinIt() {
        val day = 24L * 60 * 60 * 1000
        assertEquals(120L * day, PlayExperience.REVIEW_INTERVAL_MS)
        assertTrue(PlayExperience.reviewDue(0L, NOW))
        assertFalse(PlayExperience.reviewDue(NOW - 119 * day, NOW))
        assertTrue(PlayExperience.reviewDue(NOW - 120 * day, NOW))
        assertTrue(PlayExperience.reviewDue(NOW - 365 * day, NOW))
        // A clock that moved backwards is not a reason to ask again.
        assertFalse(PlayExperience.reviewDue(NOW + day, NOW))

        val allowed = Allow(installedByPlay = true)
        assertEquals(
            PlayExperience.CODE_COOLDOWN,
            denial(allowed, NOW, lastRequestMs = NOW - 119 * day),
        )
        assertNull(denial(allowed, NOW, lastRequestMs = NOW - 120 * day))
    }

    @Test
    fun decliningOrFailingTheUpdateFlowIsHarmless() {
        assertEquals("started", PlayExperience.flowOutcome(PlayExperience.FLOW_RESULT_OK))
        assertEquals("cancelled", PlayExperience.flowOutcome(PlayExperience.FLOW_RESULT_CANCELLED))
        assertEquals(PlayExperience.FLOW_FAILED, PlayExperience.flowOutcome(1))
        // No result code outside the two known values ever becomes "started".
        assertEquals(PlayExperience.FLOW_FAILED, PlayExperience.flowOutcome(2))
        assertEquals(PlayExperience.FLOW_FAILED, PlayExperience.flowOutcome(-2))
    }

    @Test
    fun updateStatusMapsPlayAvailabilityAndInstallState() {
        // UpdateAvailability: UPDATE_NOT_AVAILABLE=1, UPDATE_AVAILABLE=2,
        // DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS=3.
        // InstallStatus: UNKNOWN=0, PENDING=1, DOWNLOADING=2, INSTALLED=4,
        // DOWNLOADED=11.
        assertEquals("available", PlayExperience.updateStatus(2, 0))
        assertEquals("up_to_date", PlayExperience.updateStatus(1, 4))
        assertEquals("downloading", PlayExperience.updateStatus(3, 2))
        assertEquals("downloading", PlayExperience.updateStatus(2, 1))
        assertEquals("downloaded", PlayExperience.updateStatus(2, 11))
        // A downloaded flexible update wins over the availability flag.
        assertEquals("downloaded", PlayExperience.updateStatus(1, 11))
        assertEquals("unavailable", PlayExperience.updateStatus(0, 0))
    }

    @Test
    fun failuresCarryCodesAndNeverExceptionText() {
        val failure = PlayExperience.failure(PlayExperience.CODE_TIMEOUT)
        assertFalse(failure.getBoolean("ok"))
        assertEquals("SERVICE_TIMEOUT", failure.getString("code"))
        assertFalse(failure.has("error"))
        assertFalse(failure.has("message"))
        assertFalse(failure.has("exception"))
        assertFalse(failure.has("status"))

        val unavailable = PlayExperience.unavailable()
        assertFalse(unavailable.getBoolean("ok"))
        assertEquals(PlayExperience.CODE_UNAVAILABLE, unavailable.getString("code"))
        assertEquals(PlayExperience.STATUS_UNAVAILABLE, unavailable.getString("status"))

        // The immediate answer keeps the host bridge's pending contract.
        assertTrue(PlayExperience.pending().contains("\"ok\":true"))
    }

    private data class Allow(
        val installedByPlay: Boolean,
        val enabled: Boolean = true,
        val foreground: Boolean = true,
        val checkedClean: Boolean = true,
    )

    private fun denial(allow: Allow, nowMs: Long, lastRequestMs: Long = 0L): String? =
        PlayExperience.reviewDenialCode(
            installedByPlay = allow.installedByPlay,
            enabled = allow.enabled,
            foreground = allow.foreground,
            checkedClean = allow.checkedClean,
            lastRequestMs = lastRequestMs,
            nowMs = nowMs,
        )

    private companion object {
        const val NOW = 1_800_000_000_000L
    }
}
