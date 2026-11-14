package net.leviro.levix.billing

import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.ProductDetails
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayOffersTest {
    private val renewal = PlayOffers.phase("$2.99", 2_990_000, "USD", "P1M",
        ProductDetails.RecurrenceMode.INFINITE_RECURRING, 0)
    private val intro = PlayOffers.phase("$0.99", 990_000, "USD", "P1M",
        ProductDetails.RecurrenceMode.FINITE_RECURRING, 3)
    private val regular = PlusBilling.Offer("monthly", null, "regular-token", listOf(renewal))
    private val introductory = PlusBilling.Offer("monthly", "intro-3months", "intro-token", listOf(intro, renewal))

    @Test fun onlyUserIneligibleSubResponseRejectsOfferEligibility() {
        assertTrue(PlayOffers.userIneligible(BillingClient.OnPurchasesUpdatedSubResponseCode.USER_INELIGIBLE))
        for (code in listOf(
            BillingClient.OnPurchasesUpdatedSubResponseCode.NO_APPLICABLE_SUB_RESPONSE_CODE,
            BillingClient.OnPurchasesUpdatedSubResponseCode.PAYMENT_DECLINED_DUE_TO_INSUFFICIENT_FUNDS,
            -1, 99,
        )) assertFalse(PlayOffers.userIneligible(code))
    }

    @Test fun sdkRecurrenceConstantsMapToDomainValues() {
        assertEquals(PlusBilling.Recurrence.INFINITE,
            PlayOffers.recurrence(ProductDetails.RecurrenceMode.INFINITE_RECURRING))
        assertEquals(PlusBilling.Recurrence.FINITE,
            PlayOffers.recurrence(ProductDetails.RecurrenceMode.FINITE_RECURRING))
        for (mode in listOf(ProductDetails.RecurrenceMode.NON_RECURRING, 0, -1, 99)) {
            assertEquals(PlusBilling.Recurrence.OTHER, PlayOffers.recurrence(mode))
        }
    }

    @Test fun sdkRecurrenceConstantsArePairwiseDistinct() {
        assertTrue(ProductDetails.RecurrenceMode.INFINITE_RECURRING != ProductDetails.RecurrenceMode.FINITE_RECURRING)
        assertTrue(ProductDetails.RecurrenceMode.INFINITE_RECURRING != ProductDetails.RecurrenceMode.NON_RECURRING)
        assertTrue(ProductDetails.RecurrenceMode.FINITE_RECURRING != ProductDetails.RecurrenceMode.NON_RECURRING)
    }

    @Test fun mappedPhasesSelectIntroductoryAndRegularMonthlyOffers() {
        assertEquals(introductory, PlusBilling.selectOffer(listOf(regular, introductory)))
        assertEquals(regular, PlusBilling.selectOffer(listOf(regular)))
        assertEquals(PlusBilling.Phase("$0.99", 990_000, "USD", "P1M", PlusBilling.Recurrence.FINITE, 3), intro)
        assertEquals(PlusBilling.Phase("$2.99", 2_990_000, "USD", "P1M", PlusBilling.Recurrence.INFINITE, 0), renewal)
    }

    @Test fun nonRecurringFirstPhaseIsRejected() {
        val nonRecurring = PlayOffers.phase("$0.99", 990_000, "USD", "P1M",
            ProductDetails.RecurrenceMode.NON_RECURRING, 3)
        assertNull(PlusBilling.selectOffer(listOf(introductory.copy(phases = listOf(nonRecurring, renewal)))))
    }

    @Test fun finiteLastPhaseIsRejected() {
        val finite = PlayOffers.phase("$2.99", 2_990_000, "USD", "P1M",
            ProductDetails.RecurrenceMode.FINITE_RECURRING, 0)
        assertNull(PlusBilling.selectOffer(listOf(introductory.copy(phases = listOf(intro, finite)))))
        assertNull(PlusBilling.selectOffer(listOf(regular.copy(phases = listOf(finite)))))
    }
}
