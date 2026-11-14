package net.leviro.levix.billing

import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.ProductDetails

internal object PlayOffers {
    fun userIneligible(subResponseCode: Int): Boolean =
        subResponseCode == BillingClient.OnPurchasesUpdatedSubResponseCode.USER_INELIGIBLE

    fun recurrence(mode: Int): PlusBilling.Recurrence = when (mode) {
        ProductDetails.RecurrenceMode.INFINITE_RECURRING -> PlusBilling.Recurrence.INFINITE
        ProductDetails.RecurrenceMode.FINITE_RECURRING -> PlusBilling.Recurrence.FINITE
        else -> PlusBilling.Recurrence.OTHER
    }

    fun phase(
        formattedPrice: String,
        priceAmountMicros: Long,
        priceCurrencyCode: String,
        billingPeriod: String,
        recurrenceMode: Int,
        billingCycleCount: Int,
    ): PlusBilling.Phase = PlusBilling.Phase(
        formattedPrice, priceAmountMicros, priceCurrencyCode, billingPeriod,
        recurrence(recurrenceMode), billingCycleCount,
    )
}
