package net.leviro.levix.media

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.text.format.DateFormat
import android.util.LruCache
import android.util.Size
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.leviro.levix.R

class MediaAdapter(
    private val context: Context,
    private val resolver: ContentResolver,
    private val scope: CoroutineScope,
    private val selection: SelectionState,
    private val spanCount: () -> Int,
    private val onTap: (MediaItem) -> Unit,
    private val onLongPress: (MediaItem) -> Unit,
) : ListAdapter<MediaItem, MediaAdapter.Holder>(DIFF) {
    private val thumbs = object : LruCache<String, Bitmap>(
        (Runtime.getRuntime().maxMemory() / 16).coerceAtMost(24L * 1024 * 1024).toInt(),
    ) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    init {
        setHasStableIds(true)
    }

    override fun getItemId(position: Int): Long = getItem(position).id.hashCode().toLong()

    override fun getItemViewType(position: Int): Int = if (spanCount() == 3) 1 else 0

    fun notifySelectionChanged(id: String) {
        val position = currentList.indexOfFirst { it.id == id }
        if (position >= 0) notifyItemChanged(position, SELECTION_PAYLOAD)
    }

    fun notifyAllSelectionChanged() {
        if (itemCount > 0) notifyItemRangeChanged(0, itemCount, SELECTION_PAYLOAD)
    }

    class Holder(
        val root: LinearLayout,
        val picture: ImageView,
        val badge: ImageView,
        val label: TextView,
    ) : RecyclerView.ViewHolder(root) {
        var job: Job? = null
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val visual = viewType == 1
        val root = LinearLayout(parent.context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_card_panel)
            isClickable = true
            isFocusable = true
        }
        val frame = FrameLayout(parent.context)
        val picture = ImageView(parent.context).apply {
            scaleType = if (visual) ImageView.ScaleType.CENTER_CROP else ImageView.ScaleType.CENTER
            contentDescription = context.getString(R.string.media_preview)
        }
        val badge = ImageView(parent.context).apply {
            setImageResource(R.drawable.ic_media_check)
            scaleType = ImageView.ScaleType.CENTER
            setBackgroundResource(R.drawable.bg_badge_subtle)
            contentDescription = context.getString(R.string.media_selected_state)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            visibility = View.GONE
        }
        val label = TextView(parent.context).apply {
            setTextColor(ContextCompat.getColor(context, R.color.levix_text))
            textSize = 12f
            maxLines = 2
            setPadding(dp(8), dp(5), dp(8), dp(8))
        }
        frame.addView(
            picture,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        frame.addView(badge, FrameLayout.LayoutParams(dp(36), dp(36), Gravity.TOP or Gravity.END).apply {
            setMargins(dp(4), dp(4), dp(4), dp(4))
        })
        root.addView(frame, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(if (visual) 115 else 64)))
        root.addView(
            label,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                if (visual) dp(48) else ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        root.layoutParams = RecyclerView.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply {
            setMargins(dp(3), dp(3), dp(3), dp(3))
        }
        return Holder(root, picture, badge, label)
    }

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val item = getItem(position)
        holder.job?.cancel()
        holder.picture.setImageDrawable(null)
        holder.picture.tag = item.id
        holder.label.text = buildString {
            append(typeLabel(item.mediaType))
            if (item.mediaType == MediaType.VIDEO) {
                val seconds = (item.duration / 1000).toInt()
                append(" · ${context.resources.getQuantityString(R.plurals.media_seconds, seconds, seconds)}")
            }
            append(" · ")
            append(item.displayName)
        }
        holder.root.setOnClickListener { onTap(item) }
        holder.root.setOnLongClickListener {
            onLongPress(item)
            true
        }
        bindSelection(holder, item)

        if (item.mediaType in VISUAL_TYPES) {
            val cached = thumbs.get(item.id)
            if (cached != null) {
                holder.picture.setImageBitmap(cached)
                return
            }
            holder.job = scope.launch {
                val bitmap = withContext(Dispatchers.IO) {
                    try {
                        resolver.loadThumbnail(item.uri.toUri(), Size(256, 256), null)
                    } catch (_: Exception) {
                        null
                    }
                }
                if (holder.picture.tag == item.id) {
                    if (bitmap == null) {
                        holder.picture.setImageResource(android.R.drawable.ic_dialog_alert)
                    } else {
                        thumbs.put(item.id, bitmap)
                        holder.picture.setImageBitmap(bitmap)
                    }
                }
            }
        } else {
            holder.picture.setImageResource(when (item.mediaType) {
                MediaType.VOICE -> R.drawable.ic_media_voice
                MediaType.AUDIO -> R.drawable.ic_media_audio
                else -> R.drawable.ic_media_document
            })
        }
    }

    override fun onBindViewHolder(holder: Holder, position: Int, payloads: MutableList<Any>) {
        if (SELECTION_PAYLOAD in payloads) {
            bindSelection(holder, getItem(position))
        } else {
            super.onBindViewHolder(holder, position, payloads)
        }
    }

    private fun bindSelection(holder: Holder, item: MediaItem) {
        val selected = item.id in selection.selected
        holder.root.isSelected = selected
        holder.root.setBackgroundResource(
            if (selected) R.drawable.bg_card_media_selected else R.drawable.bg_card_panel,
        )
        holder.badge.visibility = if (selected) View.VISIBLE else View.GONE
        val date = DateFormat.format(
            "yyyy-MM-dd HH:mm",
            (item.dateModified.takeIf { it > 0 } ?: item.dateAdded) * 1000,
        )
        val state = if (selected) ", ${context.getString(R.string.media_selected_state)}" else ""
        holder.root.contentDescription = "${holder.label.text}, $date$state"
        if (Build.VERSION.SDK_INT >= 30) {
            holder.root.stateDescription = if (selected) context.getString(R.string.media_selected_state) else null
        }
    }

    override fun onViewRecycled(holder: Holder) {
        holder.job?.cancel()
        holder.picture.tag = null
        holder.picture.setImageDrawable(null)
        super.onViewRecycled(holder)
    }

    private fun typeLabel(value: MediaType): String = context.getString(when (value) {
        MediaType.IMAGE -> R.string.media_images
        MediaType.VIDEO -> R.string.media_videos
        MediaType.VOICE -> R.string.media_voice
        MediaType.AUDIO -> R.string.media_audio
        MediaType.DOCUMENT -> R.string.media_documents
        MediaType.STICKER -> R.string.media_stickers
    })

    private fun dp(value: Int): Int = (value * context.resources.displayMetrics.density).toInt()

    companion object {
        private const val SELECTION_PAYLOAD = "selection"
        private val VISUAL_TYPES = setOf(MediaType.IMAGE, MediaType.VIDEO, MediaType.STICKER)
        private val DIFF = object : DiffUtil.ItemCallback<MediaItem>() {
            override fun areItemsTheSame(oldItem: MediaItem, newItem: MediaItem): Boolean = oldItem.id == newItem.id
            override fun areContentsTheSame(oldItem: MediaItem, newItem: MediaItem): Boolean = oldItem == newItem
        }
    }
}
