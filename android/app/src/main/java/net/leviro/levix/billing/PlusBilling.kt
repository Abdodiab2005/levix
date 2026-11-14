package net.leviro.levix.billing

import java.net.URLEncoder
import org.json.JSONArray
import org.json.JSONObject

/** Wire rules only. No Play or Android types and no entitlement decisions. */
object PlusBilling {
    /** Process memory only; callers confine access to the main thread. */
    class PurchaseRecovery(private val productId: String, private val packageName: String) {
        var optedIn = false
            private set
        private val purchases = linkedMapOf<String, JSONObject>()

        fun optIn() { optedIn = true }

        fun record(products: List<String>, purchaseState: Int, purchaseToken: String, acknowledged: Boolean = false): Boolean {
            if (!optedIn || productId.isEmpty() || productId !in products || purchaseState != 1) return false
            val result = purchaseResult(0, purchaseState, purchaseToken, productId, packageName, acknowledged)
            if (!result.getBoolean("ok")) return false
            result.remove("ok")
            purchases[purchaseToken] = result
            if (purchases.size > 16) purchases.remove(purchases.keys.first())
            return true
        }

        fun drain(): JSONObject {
            val result = JSONObject().put("ok", true).put("purchases", JSONArray(purchases.values.toList()))
            purchases.clear()
            return result
        }
    }

    fun validInstallationId(value: String): Boolean = value.matches(Regex("[A-Za-z0-9_-]{43}"))

    fun validOfferToken(value: String): Boolean = value.length in 1..4096 &&
        value.none { it.isWhitespace() || it.isISOControl() }

    fun responseName(code: Int): String = when (code) {
        -3 -> "SERVICE_TIMEOUT"
        -2 -> "FEATURE_NOT_SUPPORTED"
        -1 -> "SERVICE_DISCONNECTED"
        0 -> "OK"
        1 -> "USER_CANCELED"
        2 -> "SERVICE_UNAVAILABLE"
        3 -> "BILLING_UNAVAILABLE"
        4 -> "ITEM_UNAVAILABLE"
        5 -> "DEVELOPER_ERROR"
        6 -> "ERROR"
        7 -> "ITEM_ALREADY_OWNED"
        8 -> "ITEM_NOT_OWNED"
        12 -> "NETWORK_ERROR"
        else -> "ERROR"
    }

    fun failure(code: String): JSONObject = JSONObject().put("ok", false)
        .put("status", "error").put("code", code)

    // PurchaseState values: UNSPECIFIED_STATE = 0, PURCHASED = 1, PENDING = 2.
    fun purchaseResult(responseCode: Int, purchaseState: Int = 0, purchaseToken: String? = null,
        productId: String? = null, packageName: String? = null, acknowledged: Boolean = false): JSONObject {
        if (responseCode == 1) return JSONObject().put("ok", false)
            .put("status", "cancelled").put("code", responseName(responseCode))
        if (responseCode != 0) return failure(responseName(responseCode))
        if (purchaseState == 2) return JSONObject().put("ok", true).put("status", "pending")
        if (purchaseState != 1 || purchaseToken.isNullOrBlank() || productId.isNullOrBlank() ||
            packageName.isNullOrBlank()) return failure("PURCHASE_INVALID")
        return JSONObject().put("ok", true).put("status", "purchased")
            .put("purchaseToken", purchaseToken).put("productId", productId).put("packageName", packageName)
            .put("acknowledged", acknowledged)
    }

    fun manageUrl(productId: String, packageName: String): String =
        "https://play.google.com/store/account/subscriptions?sku=" +
            URLEncoder.encode(productId, "UTF-8") + "&package=" + URLEncoder.encode(packageName, "UTF-8")
}
