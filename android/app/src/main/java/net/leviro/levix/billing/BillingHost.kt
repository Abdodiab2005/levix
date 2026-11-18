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
class BillingHost(
    context: Context,
    private val onPurchase: () -> Unit,
    private val deliver: (String, JSONObject) -> Unit,
) {
    private val context = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val productId = BuildConfig.PLUS_PRODUCT_ID
    private var client: BillingClient? = null
    private var destroyed = false
    private var connecting = false
    private val connections = mutableListOf<(BillingResult, BillingClient) -> Unit>()
    private class Call(val id: String) {
        var purchasing = false
        var timeout: Runnable? = null
    }
    private var current: Call? = null
    /** Activity recreation creates a new host with an empty session. The reloaded page fetches the offer again. */
    private val offerSession = PlusBilling.OfferSession()

    fun optIn() { main.post { recovery.optIn() } }

    private fun handlePurchases(result: BillingResult, purchases: List<Purchase>) {
        if (destroyed) return
        var queued = false
        if (result.responseCode == BillingClient.BillingResponseCode.OK) {
            purchases.forEach {
                if (recovery.record(it.products, it.purchaseState, it.purchaseToken, it.isAcknowledged)) queued = true
            }
        }
        if (queued) onPurchase()
        val call = current
        if (call != null && call.purchasing) {
            if (result.responseCode != BillingClient.BillingResponseCode.OK &&
                result.responseCode != BillingClient.BillingResponseCode.USER_CANCELED &&
                PlayOffers.userIneligible(result.onPurchasesUpdatedSubResponseCode)) {
                offerSession.clear()
                finish(call, PlusBilling.failure("OFFER_CHANGED"))
                return
            }
            val purchase = purchases.firstOrNull { productId in it.products }
            finish(call, if (result.responseCode != BillingClient.BillingResponseCode.OK)
                PlusBilling.purchaseResult(result.responseCode)
            else purchase?.let(::purchaseJson) ?: PlusBilling.failure("PURCHASE_INVALID"))
        }
    }

    private fun connect(ready: (BillingResult, BillingClient) -> Unit) {
        val billing = client ?: BillingClient.newBuilder(context)
            .setListener { result, purchases -> main.post { handlePurchases(result, purchases.orEmpty()) } }
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .enableAutoServiceReconnection()
            .build().also { client = it }
        if (billing.isReady) {
            ready(BillingResult.newBuilder().setResponseCode(BillingClient.BillingResponseCode.OK).build(), billing)
            return
        }
        connections.add(ready)
        if (connecting) return
        connecting = true
        try { billing.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                main.post {
                    if (destroyed) return@post
                    connecting = false
                    if (result.responseCode == BillingClient.BillingResponseCode.OK) queryPurchases(billing)
                    val waiting = connections.toList()
                    connections.clear()
                    waiting.forEach { it(result, billing) }
                }
            }
            override fun onBillingServiceDisconnected() {
                main.post {
                    if (destroyed) return@post
                    connecting = false
                    val waiting = connections.toList()
                    connections.clear()
                    val result = BillingResult.newBuilder()
                        .setResponseCode(BillingClient.BillingResponseCode.SERVICE_DISCONNECTED).build()
                    waiting.forEach { it(result, billing) }
                    current?.takeUnless { it.purchasing }?.let {
                        finish(it, PlusBilling.failure("SERVICE_DISCONNECTED"))
                    }
                }
            }
        }) } catch (error: Exception) {
            connecting = false
            connections.clear()
            throw error
        }
    }

    private fun queryPurchases(billing: BillingClient, done: ((BillingResult, List<Purchase>) -> Unit)? = null) {
        fun complete(result: BillingResult, purchases: List<Purchase>) {
            if (destroyed) return
            var queued = false
            if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                purchases.forEach {
                    if (recovery.record(it.products, it.purchaseState, it.purchaseToken, it.isAcknowledged)) queued = true
                }
            }
            if (queued && done == null) onPurchase()
            done?.invoke(result, purchases)
        }
        try {
            billing.queryPurchasesAsync(QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.SUBS).build()) { result, purchases ->
                main.post { complete(result, purchases) }
            }
        } catch (_: Exception) {
            complete(BillingResult.newBuilder()
                .setResponseCode(BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE).build(), emptyList())
        }
    }

    fun onResume() { main.post {
        if (destroyed || !recovery.optedIn || productId.isEmpty() || connecting) return@post
        runCatching { connect { result, billing ->
            if (result.responseCode == BillingClient.BillingResponseCode.OK) queryPurchases(billing)
        } }
    } }

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
                connect { result, billing ->
                    if (current !== call || destroyed) return@connect
                    if (result.responseCode != BillingClient.BillingResponseCode.OK)
                        finish(call, PlusBilling.failure(PlusBilling.responseName(result.responseCode)))
                    else try { action(call, billing) }
                    catch (_: Exception) { finish(call, PlusBilling.failure("UNAVAILABLE")) }
                }
            } catch (_: Exception) {
                finish(call, PlusBilling.failure("UNAVAILABLE"))
            }
        }
        return JSONObject().put("ok", true).toString()
    }

    private fun eligibleOffers(details: ProductDetails) = details.subscriptionOfferDetails.orEmpty().map { offer ->
        PlusBilling.Offer(offer.basePlanId, offer.offerId, offer.offerToken,
            offer.pricingPhases.pricingPhaseList.map { phase ->
                PlayOffers.phase(phase.formattedPrice, phase.priceAmountMicros, phase.priceCurrencyCode,
                    phase.billingPeriod, phase.recurrenceMode, phase.billingCycleCount)
            })
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
        offerSession.clear()
        product(call, billing) { details ->
            val offer = PlusBilling.selectOffer(eligibleOffers(details))
            if (offer == null) {
                finish(call, PlusBilling.failure("ITEM_UNAVAILABLE"))
            } else {
                offerSession.show(offer)
                finish(call, offer.productInfo(productId))
            }
        }
    }

    fun purchase(activity: Activity, callId: String, offerToken: String, installationId: String): String {
        if (productId.isEmpty()) return PlusBilling.failure("UNAVAILABLE_IN_BUILD").toString()
        if (!PlusBilling.validOfferToken(offerToken) || !PlusBilling.validInstallationId(installationId))
            return PlusBilling.failure("INVALID_INPUT").toString()
        return submit(callId) { call, billing ->
            product(call, billing) { details ->
                if (activity.isFinishing || activity.isDestroyed) {
                    finish(call, PlusBilling.failure("ITEM_UNAVAILABLE"))
                    return@product
                }
                val offer = offerSession.confirm(eligibleOffers(details), offerToken)
                if (offer == null) {
                    finish(call, PlusBilling.failure("OFFER_CHANGED"))
                } else {
                    val params = BillingFlowParams.newBuilder().setObfuscatedAccountId(installationId)
                        .setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder()
                            .setProductDetails(details).setOfferToken(offer.offerToken).build())).build()
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
        productId, context.packageName, purchase.isAcknowledged,
    )

    fun restore(callId: String): String = submit(callId) { call, billing ->
        queryPurchases(billing) { result, purchases ->
            if (current !== call || destroyed) return@queryPurchases
            if (result.responseCode != BillingClient.BillingResponseCode.OK)
                finish(call, PlusBilling.failure(PlusBilling.responseName(result.responseCode)))
            else {
                val results = JSONArray()
                purchases.filter { productId in it.products }.forEach { results.put(purchaseJson(it)) }
                finish(call, JSONObject().put("ok", true).put("purchases", results))
            }
        }
    }

    fun pendingPurchases(callId: String): String = submit(callId) { call, billing ->
        queryPurchases(billing) { result, _ ->
            if (current !== call || destroyed) return@queryPurchases
            finish(call, if (result.responseCode == BillingClient.BillingResponseCode.OK) recovery.drain()
                else PlusBilling.failure(PlusBilling.responseName(result.responseCode)))
        }
    }

    fun manageIntent(): Intent? = if (productId.isEmpty()) null else Intent(
        Intent.ACTION_VIEW, Uri.parse(PlusBilling.manageUrl(productId, context.packageName)),
    )

    fun destroy() {
        current?.let { finish(it, PlusBilling.failure("UNAVAILABLE")) }
        destroyed = true
        offerSession.clear()
        connections.clear()
        runCatching { client?.endConnection() }
        client = null
    }

    companion object {
        private val recovery = PlusBilling.PurchaseRecovery(BuildConfig.PLUS_PRODUCT_ID, BuildConfig.APPLICATION_ID)
    }
}
