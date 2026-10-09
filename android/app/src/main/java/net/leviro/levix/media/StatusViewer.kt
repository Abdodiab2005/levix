package net.leviro.levix.media

import android.app.Dialog
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.text.format.DateFormat
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.MediaController
import android.widget.PopupMenu
import android.widget.TextView
import android.widget.VideoView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.leviro.levix.R

class StatusViewer(
    private val activity: AppCompatActivity,
    items: List<MediaItem>,
    private val isFavorite: (String) -> Boolean,
    private val onSave: (MediaItem) -> Unit,
    private val onShare: (MediaItem) -> Unit,
    private val onSticker: (MediaItem) -> Unit,
    private val onOpen: (MediaItem) -> Unit,
    private val onFavorite: (MediaItem) -> Unit,
    private val onDelete: (MediaItem) -> Unit,
    private val onDismiss: () -> Unit,
) {
    private val pages = items.filter { it.mediaType in VISUAL_TYPES }
    private var dialog: Dialog? = null

    fun show(item: MediaItem): Boolean {
        val start = pages.indexOf(item)
        if (start < 0) return false

        val window = Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(ContextCompat.getColor(activity, R.color.levix_bg))
        }
        val title = TextView(activity).apply {
            setTextColor(ContextCompat.getColor(activity, R.color.levix_text))
            setPadding(dp(18), dp(18), dp(18), dp(8))
        }
        val pager = ViewPager2(activity)
        pager.adapter = PageAdapter(pager)

        // Only the two everyday actions stay inline; everything else lives in
        // the overflow menu so the bar stays one short, calm row.
        val actions = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            setPadding(dp(8), dp(4), dp(8), dp(10))
        }
        fun inline(label: Int, onClick: (MediaItem) -> Unit) {
            val button = TextView(activity).apply {
                text = activity.getString(label)
                gravity = Gravity.CENTER
                minWidth = dp(72)
                minHeight = dp(48)
                textSize = 14f
                setPadding(dp(12), dp(4), dp(12), dp(4))
                setTextColor(ContextCompat.getColor(activity, R.color.levix_cyan))
                setOnClickListener {
                    val target = pages.getOrNull(pager.currentItem) ?: return@setOnClickListener
                    onClick(target)
                }
            }
            actions.addView(button)
        }
        inline(R.string.media_save, onSave)
        inline(R.string.media_share, onShare)
        actions.addView(View(activity), LinearLayout.LayoutParams(0, 1, 1f))
        val more = TextView(activity).apply {
            text = MORE_GLYPH
            gravity = Gravity.CENTER
            minWidth = dp(48)
            minHeight = dp(48)
            textSize = 22f
            contentDescription = activity.getString(R.string.media_more)
            tooltipText = activity.getString(R.string.media_more)
            setTextColor(ContextCompat.getColor(activity, R.color.levix_text))
            setOnClickListener { anchor ->
                val current = pages.getOrNull(pager.currentItem) ?: return@setOnClickListener
                val menu = PopupMenu(activity, anchor)
                val intent = MediaLogic.stickerIntent(current)
                if (intent != StickerIntent.NONE) {
                    menu.menu.add(
                        0, MENU_STICKER, 0,
                        activity.getString(
                            if (intent == StickerIntent.SAVE) R.string.media_sticker_save
                            else R.string.media_sticker_make,
                        ),
                    )
                }
                menu.menu.add(0, MENU_OPEN, 1, activity.getString(R.string.media_open))
                menu.menu.add(
                    0, MENU_FAVORITE, 2,
                    activity.getString(
                        if (isFavorite(current.id)) R.string.media_remove_favorite
                        else R.string.media_favorite,
                    ),
                )
                if (current.isSaved && current.source == MediaSource.LEVIX_SAVED) {
                    menu.menu.add(0, MENU_DELETE, 3, activity.getString(R.string.media_delete_saved_copy))
                }
                menu.setOnMenuItemClickListener { choice ->
                    val target = pages.getOrNull(pager.currentItem)
                        ?: return@setOnMenuItemClickListener true
                    when (choice.itemId) {
                        MENU_STICKER -> onSticker(target)
                        MENU_OPEN -> onOpen(target)
                        MENU_FAVORITE -> onFavorite(target)
                        MENU_DELETE -> onDelete(target)
                    }
                    true
                }
                menu.show()
            }
        }
        actions.addView(more)

        fun updatePage(position: Int) {
            val current = pages[position]
            title.text = activity.getString(
                R.string.media_viewer_title,
                current.displayName,
                typeLabel(current.mediaType),
                dateText(current),
            )
            val recycler = pager.getChildAt(0) as? RecyclerView
            if (recycler != null) {
                for (index in 0 until recycler.childCount) {
                    val child = recycler.getChildAt(index)
                    val video = child.findViewWithTag<VideoView>(VIDEO_TAG)
                    if (child.tag == position) video?.start() else video?.pause()
                }
            }
        }
        val pageChange = object : ViewPager2.OnPageChangeCallback() {
            override fun onPageSelected(position: Int) {
                updatePage(position)
            }
        }
        pager.registerOnPageChangeCallback(pageChange)

        root.addView(title)
        root.addView(pager, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(actions)
        window.setContentView(root)
        window.setOnDismissListener {
            pager.unregisterOnPageChangeCallback(pageChange)
            stopVideos(pager)
            dialog = null
            onDismiss()
        }
        dialog = window
        window.show()
        pager.setCurrentItem(start, false)
        updatePage(start)
        return true
    }

    fun dismiss() {
        dialog?.dismiss()
    }

    private fun stopVideos(pager: ViewPager2) {
        val recycler = pager.getChildAt(0) as? RecyclerView ?: return
        for (index in 0 until recycler.childCount) {
            recycler.getChildAt(index).findViewWithTag<VideoView>(VIDEO_TAG)?.stopPlayback()
        }
    }

    private inner class PageAdapter(private val pager: ViewPager2) : RecyclerView.Adapter<Holder>() {
        override fun getItemCount(): Int = pages.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
            val box = LinearLayout(parent.context).apply {
                gravity = Gravity.CENTER
                orientation = LinearLayout.VERTICAL
                // ViewPager2 refuses any page root that does not fill it — a
                // wrap_content child crashes on first measure ("Pages must
                // fill the whole ViewPager2").
                layoutParams = RecyclerView.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
            }
            return Holder(box)
        }

        override fun onBindViewHolder(holder: Holder, position: Int) {
            val current = pages[position]
            holder.box.removeAllViews()
            holder.box.tag = position
            if (current.mediaType == MediaType.VIDEO) {
                bindVideo(holder, current, position)
            } else {
                bindImage(holder, current)
            }
        }

        private fun bindVideo(holder: Holder, current: MediaItem, position: Int) {
            val video = VideoView(activity).apply { tag = VIDEO_TAG }
            holder.box.addView(
                video,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            try {
                video.setMediaController(MediaController(activity))
                video.setOnPreparedListener {
                    if (pager.currentItem == position) video.start()
                }
                video.setVideoURI(current.uri.toUri())
                video.setOnErrorListener { _, _, _ ->
                    if (holder.box.tag == position) {
                        holder.box.removeAllViews()
                        holder.box.addView(placeholder())
                    }
                    true
                }
            } catch (_: Exception) {
                holder.box.removeAllViews()
                holder.box.addView(placeholder())
            }
        }

        private fun bindImage(holder: Holder, current: MediaItem) {
            val image = ImageView(activity).apply {
                scaleType = ImageView.ScaleType.FIT_CENTER
                contentDescription = current.displayName
            }
            holder.box.addView(
                image,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            holder.job = activity.lifecycleScope.launch {
                val bitmap = withContext(Dispatchers.IO) { decodePreview(current.uri) }
                if (bitmap == null) {
                    image.setImageResource(android.R.drawable.ic_dialog_alert)
                    image.contentDescription = activity.getString(R.string.media_unavailable)
                } else {
                    image.setImageBitmap(bitmap)
                }
            }
        }

        override fun onViewRecycled(holder: Holder) {
            holder.job?.cancel()
            holder.box.findViewWithTag<VideoView>(VIDEO_TAG)?.stopPlayback()
            super.onViewRecycled(holder)
        }
    }

    private class Holder(val box: LinearLayout) : RecyclerView.ViewHolder(box) {
        var job: Job? = null
    }

    private fun placeholder(): TextView = TextView(activity).apply {
        setText(R.string.media_unavailable)
        setTextColor(ContextCompat.getColor(activity, R.color.levix_text))
    }

    private fun decodePreview(uri: String): Bitmap? = try {
        val source = ImageDecoder.createSource(activity.contentResolver, uri.toUri())
        ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
            val scale = minOf(1.0, 1600.0 / maxOf(info.size.width, info.size.height))
            decoder.setTargetSize(
                (info.size.width * scale).toInt().coerceAtLeast(1),
                (info.size.height * scale).toInt().coerceAtLeast(1),
            )
        }
    } catch (_: Exception) {
        null
    }

    private fun typeLabel(value: MediaType): String = activity.getString(when (value) {
        MediaType.IMAGE -> R.string.media_images
        MediaType.VIDEO -> R.string.media_videos
        MediaType.VOICE -> R.string.media_voice
        MediaType.AUDIO -> R.string.media_audio
        MediaType.DOCUMENT -> R.string.media_documents
        MediaType.STICKER -> R.string.media_stickers
    })

    private fun dateText(item: MediaItem): String = DateFormat.format(
        "yyyy-MM-dd HH:mm",
        (item.dateModified.takeIf { it > 0 } ?: item.dateAdded) * 1000,
    ).toString()

    private fun dp(value: Int): Int = (value * activity.resources.displayMetrics.density).toInt()

    companion object {
        private const val VIDEO_TAG = "video"
        private const val MORE_GLYPH = "⋮"
        private const val MENU_STICKER = 1
        private const val MENU_OPEN = 2
        private const val MENU_FAVORITE = 3
        private const val MENU_DELETE = 4
        private val VISUAL_TYPES = setOf(MediaType.IMAGE, MediaType.VIDEO, MediaType.STICKER)
    }
}
