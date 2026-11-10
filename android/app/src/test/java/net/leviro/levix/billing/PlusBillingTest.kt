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

    @Test fun recoveryRequiresProcessOptInAndKeepsItAfterDraining() {
        val recovery = PlusBilling.PurchaseRecovery("plus.monthly", "net.leviro.levix")
        assertFalse(recovery.optedIn)
        recovery.record(listOf("plus.monthly"), 1, "before-opt-in")
        assertEquals(0, recovery.drain().getJSONArray("purchases").length())
        recovery.optIn()
        assertTrue(recovery.optedIn)
        recovery.record(listOf("plus.monthly"), 1, "after-opt-in")
        assertEquals(1, recovery.drain().getJSONArray("purchases").length())
        assertTrue(recovery.optedIn)
        assertFalse(PlusBilling.PurchaseRecovery("plus.monthly", "net.leviro.levix").optedIn)
    }

    @Test fun pendingCanCompleteAfterTheInteractiveCallHasGone() {
        val recovery = PlusBilling.PurchaseRecovery("plus.monthly", "net.leviro.levix")
        recovery.optIn()
        recovery.record(listOf("plus.monthly"), 2, "token\"\\")
        assertEquals(0, recovery.drain().getJSONArray("purchases").length())
        // No interactive call is needed to retain the later completed purchase.
        recovery.record(listOf("other", "plus.monthly"), 1, "token\"\\")
        recovery.record(listOf("plus.monthly"), 1, "token\"\\")
        recovery.record(listOf("plus.monthly"), 2, "token\"\\")
        recovery.record(listOf("plus.monthly"), 0, "token\"\\")
        val result = JSONObject(recovery.drain().toString())
        assertTrue(result.getBoolean("ok"))
        val purchases = result.getJSONArray("purchases")
        assertEquals(1, purchases.length())
        val purchase = purchases.getJSONObject(0)
        assertEquals(4, purchase.length())
        assertEquals("token\"\\", purchase.getString("purchaseToken"))
        assertEquals("plus.monthly", purchase.getString("productId"))
        assertEquals("net.leviro.levix", purchase.getString("packageName"))
        assertEquals("purchased", purchase.getString("status"))
        assertEquals(0, recovery.drain().getJSONArray("purchases").length())
        // A later Play reconciliation may offer the same token again for a failed claim.
        recovery.record(listOf("plus.monthly"), 1, "token\"\\")
        assertEquals(1, recovery.drain().getJSONArray("purchases").length())
    }

    @Test fun recoveryRejectsOtherProductsUnknownStatesAndInvalidClaimFields() {
        val recovery = PlusBilling.PurchaseRecovery("plus.monthly", "net.leviro.levix")
        recovery.optIn()
        recovery.record(listOf("other"), 1, "other-token")
        recovery.record(emptyList(), 1, "missing-product")
        recovery.record(listOf("plus.monthly"), 0, "unknown-state")
        recovery.record(listOf("plus.monthly"), 2, "pending")
        recovery.record(listOf("plus.monthly"), 1, " ")
        assertEquals(0, recovery.drain().getJSONArray("purchases").length())
        for ((product, pkg) in listOf("" to "pkg", "plus.monthly" to "")) {
            val invalid = PlusBilling.PurchaseRecovery(product, pkg)
            invalid.optIn()
            invalid.record(listOf(product), 1, "token")
            assertEquals(0, invalid.drain().getJSONArray("purchases").length())
        }
    }

    @Test fun recoveryQueueIsBoundedAndDuplicateTokensDoNotEvictPurchases() {
        val recovery = PlusBilling.PurchaseRecovery("plus.monthly", "net.leviro.levix")
        recovery.optIn()
        for (index in 0..15) recovery.record(listOf("plus.monthly"), 1, "token-$index")
        recovery.record(listOf("plus.monthly"), 1, "token-0")
        recovery.record(listOf("plus.monthly"), 1, "token-16")
        val purchases = recovery.drain().getJSONArray("purchases")
        assertEquals(16, purchases.length())
        assertEquals("token-1", purchases.getJSONObject(0).getString("purchaseToken"))
        assertEquals("token-16", purchases.getJSONObject(15).getString("purchaseToken"))
        assertEquals(0, recovery.drain().getJSONArray("purchases").length())
    }
}
