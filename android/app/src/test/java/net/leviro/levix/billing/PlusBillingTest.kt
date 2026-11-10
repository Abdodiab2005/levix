package net.leviro.levix.billing

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlusBillingTest {
    @Test fun installationIdIsAnOpaqueSha256Base64urlDigest() {
        assertTrue(PlusBilling.validInstallationId("aB0_-".repeat(8) + "abc"))
        for (id in listOf("", "a".repeat(42), "a".repeat(44), "a".repeat(42) + "=",
            "a".repeat(42) + "/", "a".repeat(42) + "+", "a".repeat(42) + "\n")) {
            assertFalse(PlusBilling.validInstallationId(id))
        }
    }

    @Test fun offerTokenIsBoundedAndRejectsWhitespaceAndControls() {
        assertTrue(PlusBilling.validOfferToken("opaque+/offer_token-123="))
        assertTrue(PlusBilling.validOfferToken("a".repeat(4096)))
        for (token in listOf("", " ", " a", "a b", "a\n", "a\u0000", "a".repeat(4097))) {
            assertFalse(PlusBilling.validOfferToken(token))
        }
    }

    @Test fun onlyPurchasedResultsCarryClaimFieldsAndNeverGrantEntitlement() {
        val result = JSONObject(PlusBilling.purchaseResult(0, 1, "token\"\\", "plus.monthly", "net.leviro.levix").toString())
        assertTrue(result.getBoolean("ok"))
        assertEquals("purchased", result.getString("status"))
        assertEquals("token\"\\", result.getString("purchaseToken"))
        assertEquals("plus.monthly", result.getString("productId"))
        assertEquals("net.leviro.levix", result.getString("packageName"))
        assertFalse(result.has("entitlement"))
        assertFalse(result.has("active"))
        for (resultWithoutToken in listOf(
            PlusBilling.purchaseResult(0, 2, "secret", "plus", "pkg"),
            PlusBilling.purchaseResult(1, 1, "secret", "plus", "pkg"),
            PlusBilling.purchaseResult(6, 1, "secret", "plus", "pkg"),
            PlusBilling.purchaseResult(0, 0, "secret", "plus", "pkg"),
        )) {
            assertFalse(resultWithoutToken.has("purchaseToken"))
            assertFalse(resultWithoutToken.has("productId"))
            assertFalse(resultWithoutToken.has("packageName"))
        }
    }

    @Test fun pendingCancellationAndInvalidPurchasesStaySeparate() {
        assertEquals("pending", PlusBilling.purchaseResult(0, 2).getString("status"))
        val cancelled = PlusBilling.purchaseResult(1)
        assertFalse(cancelled.getBoolean("ok"))
        assertEquals("cancelled", cancelled.getString("status"))
        assertEquals("USER_CANCELED", cancelled.getString("code"))
        for (result in listOf(PlusBilling.purchaseResult(0, 1),
            PlusBilling.purchaseResult(0, 1, "", "plus", "pkg"),
            PlusBilling.purchaseResult(0, 1, "token", "", "pkg"),
            PlusBilling.purchaseResult(0, 1, "token", "plus", ""))) {
            assertFalse(result.getBoolean("ok"))
            assertEquals("PURCHASE_INVALID", result.getString("code"))
        }
    }

    @Test fun responseCodesUsePlayNamesAndErrorsHaveNoTokens() {
        val names = mapOf(-3 to "SERVICE_TIMEOUT", -2 to "FEATURE_NOT_SUPPORTED", -1 to "SERVICE_DISCONNECTED",
            0 to "OK", 1 to "USER_CANCELED", 2 to "SERVICE_UNAVAILABLE", 3 to "BILLING_UNAVAILABLE",
            4 to "ITEM_UNAVAILABLE", 5 to "DEVELOPER_ERROR", 6 to "ERROR", 7 to "ITEM_ALREADY_OWNED",
            8 to "ITEM_NOT_OWNED", 12 to "NETWORK_ERROR", 999 to "ERROR")
        for ((code, name) in names) assertEquals(name, PlusBilling.responseName(code))
        for (code in names.keys.filter { it != 0 && it != 1 }) {
            val result = PlusBilling.purchaseResult(code, 1, "secret", "plus", "pkg")
            assertFalse(result.getBoolean("ok"))
            assertEquals("error", result.getString("status"))
            assertEquals(names[code], result.getString("code"))
            assertFalse(result.has("purchaseToken"))
        }
        assertEquals("UNAVAILABLE_IN_BUILD", PlusBilling.failure("UNAVAILABLE_IN_BUILD").getString("code"))
    }

    @Test fun manageUrlUsesOnlyEncodedProductAndPackage() {
        assertEquals("https://play.google.com/store/account/subscriptions?sku=plus.monthly&package=net.leviro.levix",
            PlusBilling.manageUrl("plus.monthly", "net.leviro.levix"))
        assertEquals("https://play.google.com/store/account/subscriptions?sku=a%26b&package=p%3Fq",
            PlusBilling.manageUrl("a&b", "p?q"))
    }
}
