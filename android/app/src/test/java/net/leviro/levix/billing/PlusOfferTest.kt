package net.leviro.levix.billing

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PlusOfferTest {
    private val renewal = PlusBilling.Phase("$2.99", 2_990_000, "USD", "P1M", 1, 0)
    private val intro = PlusBilling.Phase("$0.99", 990_000, "USD", "P1M", 2, 3)
    private val regular = PlusBilling.Offer("monthly", null, "regular-token", listOf(renewal))
    private val introductory = PlusBilling.Offer("monthly", "intro-3months", "intro-token", listOf(intro, renewal))

    @Test fun eligibleNewSubscriberGetsNamedIntroRegardlessOfCatalogOrder() {
        for (offers in listOf(listOf(regular, introductory), listOf(introductory, regular), listOf(introductory))) {
            assertEquals(introductory, PlusBilling.selectOffer(offers))
        }
    }

    @Test fun ineligibleSubscriberGetsRegularMonthlyPlan() {
        assertEquals(regular, PlusBilling.selectOffer(listOf(regular)))
        assertNull(PlusBilling.selectOffer(emptyList()))
    }

    @Test fun otherBasePlansAndOffersNeverBecomeTheFallback() {
        val others = listOf(regular.copy(basePlanId = "annual"), regular.copy(basePlanId = "prepaid"),
            introductory.copy(basePlanId = "other-monthly"), introductory.copy(offerId = "another-offer"))
        assertNull(PlusBilling.selectOffer(others))
        assertEquals(regular, PlusBilling.selectOffer(others + regular))
        assertEquals(introductory, PlusBilling.selectOffer(others + regular + introductory))
    }

    @Test fun onlyThreeMonthlyDiscountedPaymentsFollowedByMonthlyAutoRenewalAreAccepted() {
        val malformed = listOf(
            listOf(intro.copy(billingPeriod = "P3M"), renewal),
            listOf(intro.copy(billingCycleCount = 1), renewal),
            listOf(intro.copy(billingCycleCount = 0), renewal),
            listOf(intro.copy(recurrenceMode = 3), renewal),
            listOf(intro, renewal.copy(billingPeriod = "P1Y")),
            listOf(intro, renewal.copy(recurrenceMode = 2)),
            listOf(intro, renewal.copy(billingCycleCount = 1)),
            listOf(intro.copy(priceAmountMicros = 0), renewal), // free trial
            listOf(intro.copy(priceAmountMicros = renewal.priceAmountMicros), renewal),
            listOf(intro.copy(priceAmountMicros = renewal.priceAmountMicros + 1), renewal),
            listOf(intro.copy(priceCurrencyCode = "EUR"), renewal),
            listOf(intro, intro, renewal), listOf(renewal, intro), listOf(intro), emptyList(),
        )
        for (phases in malformed) {
            val offer = introductory.copy(phases = phases)
            assertNull(PlusBilling.selectOffer(listOf(offer)))
            assertEquals(regular, PlusBilling.selectOffer(listOf(offer, regular)))
        }
    }

    @Test fun malformedRegularOrUnpricedOffersCannotBePurchased() {
        for (phase in listOf(renewal.copy(formattedPrice = ""), renewal.copy(priceAmountMicros = 0),
            renewal.copy(priceAmountMicros = -1), renewal.copy(priceCurrencyCode = ""),
            renewal.copy(billingPeriod = "P4W"), renewal.copy(recurrenceMode = 3))) {
            assertNull(PlusBilling.selectOffer(listOf(regular.copy(phases = listOf(phase)))))
        }
        assertNull(PlusBilling.selectOffer(listOf(regular.copy(offerToken = " "))))
        assertNull(PlusBilling.selectOffer(listOf(regular.copy(phases = listOf(intro, renewal)))))
    }

    @Test fun localizedPlayAmountsAreCarriedVerbatimWithNoUsdPriceAssumption() {
        for ((currency, prices) in listOf("EGP" to ("١٥٫٠٠ ج.م.‏" to "٤٥٫٠٠ ج.م.‏"),
            "BRL" to ("R$ 4,90" to "R$ 14,90"), "EUR" to ("0,89 €" to "2,79 €"))) {
            val offer = introductory.copy(phases = listOf(
                intro.copy(formattedPrice = prices.first, priceCurrencyCode = currency, priceAmountMicros = 10_000_000),
                renewal.copy(formattedPrice = prices.second, priceCurrencyCode = currency, priceAmountMicros = 30_000_000),
            ))
            val selected = PlusBilling.selectOffer(listOf(offer))!!
            val wire = JSONObject(selected.productInfo("levix.plus").toString())
            assertEquals(prices.first, wire.getJSONObject("introduction").getString("formattedPrice"))
            assertEquals(prices.second, wire.getString("formattedPrice"))
        }
    }

    @Test fun wireDescribesBothIntroductoryPaymentsAndSubsequentRenewalWithoutEntitlements() {
        val wire = introductory.productInfo("levix.plus")
        assertEquals("levix.plus", wire.getString("productId"))
        assertEquals("monthly", wire.getString("basePlanId"))
        assertEquals("intro-3months", wire.getString("offerId"))
        assertEquals("intro-token", wire.getString("offerToken"))
        assertEquals("$2.99", wire.getString("formattedPrice"))
        assertEquals("P1M", wire.getString("billingPeriod"))
        val phase = wire.getJSONObject("introduction")
        assertEquals("$0.99", phase.getString("formattedPrice"))
        assertEquals("P1M", phase.getString("billingPeriod"))
        assertEquals(3, phase.getInt("billingCycleCount"))
        assertFalse(wire.has("entitlement"))
        assertFalse(wire.has("active"))
        assertTrue(regular.productInfo("levix.plus").isNull("introduction"))
        assertTrue(regular.productInfo("levix.plus").isNull("offerId"))
    }

    @Test fun checkoutRequiresExactlyTheOfferShownAndNeverSilentlyFallsBack() {
        val catalog = listOf(regular, introductory)
        assertEquals(introductory, PlusBilling.confirmedOffer(catalog, "intro-token", introductory))
        assertNull(PlusBilling.confirmedOffer(catalog, "intro-token", null))
        assertNull(PlusBilling.confirmedOffer(catalog, "forged-token", introductory))
        assertNull(PlusBilling.confirmedOffer(listOf(regular), "intro-token", introductory))
        assertNull(PlusBilling.confirmedOffer(catalog, "regular-token", regular))
        assertEquals(regular, PlusBilling.confirmedOffer(listOf(regular), "regular-token", regular))
    }

    @Test fun pricePhaseOrTokenChangeRequiresAnotherDisclosureEvenWhenTokenIsUnchanged() {
        for (changed in listOf(
            introductory.copy(offerToken = "new-token"),
            introductory.copy(phases = listOf(intro.copy(formattedPrice = "$1.09"), renewal)),
            introductory.copy(phases = listOf(intro, renewal.copy(priceAmountMicros = 3_990_000, formattedPrice = "$3.99"))),
            introductory.copy(phases = listOf(intro.copy(billingCycleCount = 2), renewal)),
        )) assertNull(PlusBilling.confirmedOffer(listOf(changed), "intro-token", introductory))
    }
}
