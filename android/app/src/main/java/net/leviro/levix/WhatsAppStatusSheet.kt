package net.leviro.levix

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import androidx.annotation.ColorRes
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * A read-only look at the WhatsApp connection.
 *
 * The home screen's WhatsApp card opens this instead of the panel's Connection
 * page: it answers "what is the connection doing right now?" and nothing else.
 * There are deliberately no controls here — start, stop, unlink, restart and
 * pairing all stay in the control panel, which is the only place that owns the
 * session lifecycle. Dismiss by swipe-down, tap outside, or Back.
 */
object WhatsAppStatusSheet {
    private val mainHandler = Handler(Looper.getMainLooper())

    fun show(context: Context) {
        val dialog = BottomSheetDialog(context)
        val content = LayoutInflater.from(context).inflate(R.layout.sheet_whatsapp_status, null)
        dialog.setContentView(content)
        dialog.setCanceledOnTouchOutside(true)

        val views = Views(
            header = content.findViewById(R.id.waStatusHeader),
            dot = content.findViewById(R.id.waStatusDot),
            title = content.findViewById(R.id.waStatusTitle),
            description = content.findViewById(R.id.waStatusDescription),
            state = content.findViewById(R.id.waStatusStateValue),
            since = content.findViewById(R.id.waStatusSinceValue),
            errorRow = content.findViewById(R.id.waErrorRow),
            error = content.findViewById(R.id.waStatusErrorValue),
            network = content.findViewById(R.id.waStatusNetworkValue),
            engine = content.findViewById(R.id.waStatusEngineValue),
        )
        // The state title is this sheet's heading, so screen readers announce it
        // as such rather than as ordinary body text.
        ViewCompat.setAccessibilityHeading(views.title, true)

        val unsubscribe = HostState.listen { snapshot ->
            mainHandler.post {
                if (dialog.isShowing) render(context, views, snapshot)
            }
        }
        dialog.setOnDismissListener { unsubscribe() }
        dialog.show()
    }

    private class Views(
        val header: View,
        val dot: ImageView,
        val title: TextView,
        val description: TextView,
        val state: TextView,
        val since: TextView,
        val errorRow: View,
        val error: TextView,
        val network: TextView,
        val engine: TextView,
    )

    private class StatusVisual(
        @param:StringRes val title: Int,
        @param:DrawableRes val dot: Int,
        @param:ColorRes val color: Int,
        @param:StringRes val description: Int,
    )

    private fun render(context: Context, views: Views, snapshot: HostState.Snapshot) {
        val visual = visual(snapshot)
        views.dot.setImageResource(visual.dot)
        views.title.setText(visual.title)
        views.title.setTextColor(ContextCompat.getColor(context, visual.color))
        views.description.setText(visual.description)
        views.header.contentDescription = context.getString(
            R.string.wa_status_header_cd,
            context.getString(visual.title),
        )

        val stateLabel = when (snapshot.whatsAppState) {
            "idle" -> R.string.status_stopped
            "starting" -> R.string.status_starting
            "waiting_for_qr" -> R.string.status_pairing
            "linking" -> R.string.notif_starting
            "connected" -> R.string.status_connected
            "reconnecting" -> R.string.status_reconnecting
            "disconnected" -> R.string.status_offline
            "retry_exhausted" -> R.string.status_failed
            "logged_out" -> R.string.status_expired
            "error" -> R.string.wa_detail_error
            "paused" -> R.string.status_paused
            else -> null
        }
        views.state.text = stateLabel?.let(context::getString)
            ?: snapshot.whatsAppState
            ?: context.getString(R.string.wa_detail_unknown)
        views.state.setTextColor(ContextCompat.getColor(context, visual.color))

        views.since.text = formatSince(context, snapshot.whatsAppSinceMs)

        renderError(views, snapshot)

        val online = HostNetwork.isValidated(context)
        views.network.setText(if (online) R.string.wa_network_online else R.string.wa_network_offline)
        views.network.setTextColor(
            ContextCompat.getColor(context, if (online) R.color.levix_ok else R.color.levix_danger),
        )

        val engineRunning = snapshot.running && snapshot.nodeAlive && snapshot.levixReady && snapshot.nodeError == null
        views.engine.setText(
            if (engineRunning) R.string.wa_engine_running
            else if (snapshot.nodeError != null) R.string.status_failed
            else if (snapshot.running) R.string.home_unknown
            else R.string.wa_engine_stopped,
        )
        views.engine.setTextColor(
            ContextCompat.getColor(
                context,
                if (engineRunning) R.color.levix_ok else R.color.levix_text_muted,
            ),
        )
    }

    private fun renderError(views: Views, snapshot: HostState.Snapshot) {
        val code = snapshot.whatsAppCode
        val reason = snapshot.whatsAppReason
        if (code == null && reason.isNullOrBlank()) {
            views.errorRow.visibility = View.GONE
            return
        }
        views.errorRow.visibility = View.VISIBLE
        val text = buildString {
            if (code != null) append(code)
            if (!reason.isNullOrBlank()) {
                if (isNotEmpty()) append(" · ")
                append(reason)
            }
        }
        views.error.text = text
    }

    private fun formatSince(context: Context, sinceMs: Long): CharSequence {
        if (sinceMs <= 0L) return context.getString(R.string.wa_detail_unknown)
        return DateUtils.getRelativeTimeSpanString(
            sinceMs,
            System.currentTimeMillis(),
            DateUtils.SECOND_IN_MILLIS,
        )
    }

    private fun visual(snapshot: HostState.Snapshot): StatusVisual {
        if (!snapshot.running) return StatusVisual(
            R.string.status_offline, R.drawable.ic_dot_red,
            R.color.levix_text_muted, R.string.card_whatsapp_desc_offline_long,
        )
        val home = HomePresentation.from(snapshot, System.currentTimeMillis())
        val good = home.state == HomePresentation.State.READY
        val error = home.state in listOf(HomePresentation.State.FAILED, HomePresentation.State.EXPIRED)
        return StatusVisual(
            title = home.title,
            dot = if (good) R.drawable.ic_dot_green else if (error) R.drawable.ic_dot_red else R.drawable.ic_dot_amber,
            color = if (good) R.color.levix_ok else if (error) R.color.levix_danger else R.color.levix_warn,
            description = home.body,
        )
    }
}
