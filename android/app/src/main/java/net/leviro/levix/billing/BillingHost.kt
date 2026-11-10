package net.leviro.levix.billing

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import net.leviro.levix.BuildConfig
import net.leviro.levix.PanelFiles
import org.json.JSONArray
import org.json.JSONObject

/** Activity-owned, lazy Play client. Every mutable field is confined to the main thread. */
class BillingHost(context: Context, private val deliver: (String, JSONObject) -> Unit) {
    private val context = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val productId = BuildConfig.PLUS_PRODUCT_ID
    private var client: BillingClient? = null
    private var destroyed = false
    private class Call(val id: String) {
        var purchasing = false
        var timeout: Runnable? = null
    }
    private var current: Call? = null

    private fun finish(call: Call, result: JSONObject) {
        if (current !== call || destroyed) return
        call.timeout?.let { main.removeCallbacks(it) }
        current = null
        deliver(call.id, result)
    }

    private fun submit(id: String, action: (Call, BillingClient) -> Unit): String {
        if (productId.isEmpty()) return PlusBilling.failure("UNAVAILABLE_IN_BUILD").toString()
        if (!PanelFiles.validCallId(id)) return PlusBilling.failure("INVALID_INPUT").toString()
        main.post {
            if (destroyed) return@post
            if (current != null) {
                deliver(id, PlusBilling.failure("BUSY"))
                return@post
            }
            val call = Call(id)
            current = call
            call.timeout = Runnable { finish(call, PlusBilling.failure("SERVICE_TIMEOUT")) }
            main.postDelayed(call.timeout!!, 30_000)
            try {
                val billing = client ?: BillingClient.newBuilder(context)
                    .setListener { result, purchases -> main.post {
                        val pending = current
                        if (pending != null && pending.purchasing) {
                            val purchase = purchases?.firstOrNull { productId in it.products }
                            finish(pending, if (result.responseCode != BillingClient.BillingResponseCode.OK)
                                PlusBilling.purchaseResult(result.responseCode)
                            else purchase?.let(::purchaseJson) ?: PlusBilling.failure("PURCHASE_INVALID"))
                        }
                    } }
                    .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
                    .enableAutoServiceReconnection()
                    .build().also { client = it }
                if (billing.isReady) action(call, billing)
                else billing.startConnection(object : BillingClientStateListener {
                    override fun onBillingSetupFinished(result: BillingResult) {
                        main.post setup@{
                            if (current !== call || destroyed) return@setup
                            if (result.responseCode != BillingClient.BillingResponseCode.OK)
                                finish(call, PlusBilling.failure(PlusBilling.responseName(result.responseCode)))
                            else try { action(call, billing) }
                            catch (_: Exception) { finish(call, PlusBilling.failure("UNAVAILABLE")) }
                        }
                    }
                    override fun onBillingServiceDisconnected() {
                        main.post {
                            if (!call.purchasing) finish(call, PlusBilling.failure("SERVICE_DISCONNECTED"))
                        }
                    }
                })
            } catch (_: Exception) {
                finish(call, PlusBilling.failure("UNAVAILABLE"))
            }
        }
        return JSONObject().put("ok", true).toString()
    }

    // Only a monthly auto-renewing base plan without introductory phases is offered.
    // This keeps the price beside Subscribe equal to the recurring monthly charge.
    private fun monthlyOffers(details: ProductDetails) = details.subscriptionOfferDetails.orEmpty().filter {
        val phases = it.pricingPhases.pricingPhaseList
        it.offerId == null && phases.size == 1 && phases[0].billingPeriod == "P1M" &&
            phases[0].recurrenceMode == ProductDetails.RecurrenceMode.INFINITE_RECURRING
    }

    private fun product(call: Call, billing: BillingClient, ready: (ProductDetails) -> Unit) {
        val params = QueryProductDetailsParams.newBuilder().setProductList(listOf(
            QueryProductDetailsParams.Product.newBuilder().setProductId(productId)
                .setProductType(BillingClient.ProductType.SUBS).build(),
        )).build()
        billing.queryProductDetailsAsync(params) { result, products -> main.post {
            if (current !== call || destroyed) return@post
            if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                finish(call, PlusBilling.failure(PlusBilling.responseName(result.responseCode)))
                return@post
            }
            val details = products.productDetailsList.firstOrNull { it.productId == productId }
            if (details == null) finish(call, PlusBilling.failure("ITEM_UNAVAILABLE"))
            else try { ready(details) }
            catch (_: Exception) { finish(call, PlusBilling.failure("UNAVAILABLE")) }
        } }
    }

    fun productInfo(callId: String): String = submit(callId) { call, billing ->
        product(call, billing) { details ->
            val offer = monthlyOffers(details).firstOrNull()
            if (offer == null || !PlusBilling.validOfferToken(offer.offerToken)) {
                finish(call, PlusBilling.failure("ITEM_UNAVAILABLE"))
            } else {
                val price = offer.pricingPhases.pricingPhaseList[0]
                finish(call, JSONObject().put("ok", true).put("productId", productId)
                    .put("offerToken", offer.offerToken).put("formattedPrice", price.formattedPrice)
                    .put("billingPeriod", price.billingPeriod))
            }
        }
    }

    fun purchase(activity: Activity, callId: String, offerToken: String, installationId: String): String {
        if (productId.isEmpty()) return PlusBilling.failure("UNAVAILABLE_IN_BUILD").toString()
        if (!PlusBilling.validOfferToken(offerToken) || !PlusBilling.validInstallationId(installationId))
            return PlusBilling.failure("INVALID_INPUT").toString()
        return submit(callId) { call, billing ->
            product(call, billing) { details ->
                if (activity.isFinishing || activity.isDestroyed ||
                    monthlyOffers(details).none { it.offerToken == offerToken }) {
                    finish(call, PlusBilling.failure("ITEM_UNAVAILABLE"))
                } else {
                    val params = BillingFlowParams.newBuilder().setObfuscatedAccountId(installationId)
                        .setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder()
                            .setProductDetails(details).setOfferToken(offerToken).build())).build()
                    call.purchasing = true
                    val result = billing.launchBillingFlow(activity, params)
                    if (result.responseCode != BillingClient.BillingResponseCode.OK)
                        finish(call, PlusBilling.purchaseResult(result.responseCode))
                    else {
                        // The operator may spend arbitrary time in the Play purchase screen.
                        call.timeout?.let { main.removeCallbacks(it) }
                    }
                }
            }
        }
    }

    private fun purchaseJson(purchase: Purchase): JSONObject = PlusBilling.purchaseResult(
        BillingClient.BillingResponseCode.OK, purchase.purchaseState, purchase.purchaseToken,
        productId, context.packageName,
    )

    fun restore(callId: String): String = submit(callId) { call, billing ->
        billing.queryPurchasesAsync(QueryPurchasesParams.newBuilder()
            .setProductType(BillingClient.ProductType.SUBS).build()) { result, purchases -> main.post {
            if (current !== call || destroyed) return@post
            if (result.responseCode != BillingClient.BillingResponseCode.OK)
                finish(call, PlusBilling.failure(PlusBilling.responseName(result.responseCode)))
            else {
                val results = JSONArray()
                purchases.filter { productId in it.products }.forEach { results.put(purchaseJson(it)) }
                finish(call, JSONObject().put("ok", true).put("purchases", results))
            }
        } }
    }

    fun manageIntent(): Intent? = if (productId.isEmpty()) null else Intent(
        Intent.ACTION_VIEW, Uri.parse(PlusBilling.manageUrl(productId, context.packageName)),
    )

    fun destroy() {
        current?.let { finish(it, PlusBilling.failure("UNAVAILABLE")) }
        destroyed = true
        runCatching { client?.endConnection() }
        client = null
    }
}
