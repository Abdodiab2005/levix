package net.leviro.levix.media

import android.Manifest
import android.app.Activity
import android.app.Dialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.Settings
import android.text.format.Formatter
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.TextView
import android.widget.Toast
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.widget.addTextChangedListener
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.leviro.levix.R
import java.time.Instant
import java.time.ZoneId

class MediaHubActivity : AppCompatActivity() {
    private lateinit var repo: MediaRepository
    private lateinit var model: MediaHubViewModel
    private lateinit var gallery: RecyclerView
    private lateinit var adapter: MediaAdapter
    private lateinit var banner: View
    private lateinit var bannerText: TextView
    private lateinit var bannerAction: Button
    private lateinit var bannerOther: Button
    private lateinit var sources: LinearLayout
    private lateinit var categories: LinearLayout
    private lateinit var filters: LinearLayout

    private var source: MediaSource? = null
    private var category = "Statuses"
    private var filter = MediaFilter.ALL
    private var sort = MediaSort.NEWEST
    private var query = ""
    private var shown = emptyList<MediaItem>()
    private var viewer: StatusViewer? = null
    private var progressDialog: Dialog? = null
    private var bulkJob: Job? = null
    private var searchJob: Job? = null
    private var observer: ContentObserver? = null
    private val handler = Handler(Looper.getMainLooper())
    private val scanLater = Runnable { model.refresh(repo, true) }

    private val permissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        render()
        model.refresh(repo, true)
    }

    private val treePicker = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@registerForActivityResult
        val tree = result.data?.data ?: return@registerForActivityResult
        val documentId = try {
            DocumentsContract.getTreeDocumentId(tree).lowercase()
        } catch (_: Exception) {
            ""
        }
        val business = documentId.contains("com.whatsapp.w4b") ||
            documentId.contains("whatsapp business")
        val regular = documentId.contains("com.whatsapp/") ||
            documentId.contains("whatsapp/media")
        val mediaFolder = documentId.endsWith("/media") ||
            documentId.endsWith("/media/.statuses") ||
            documentId.contains("/media/.statuses/")
        if (!(business || regular) || !mediaFolder) {
            toast(R.string.media_wrong_folder)
            return@registerForActivityResult
        }
        try {
            contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            val source = if (business) MediaSource.WHATSAPP_BUSINESS else MediaSource.WHATSAPP
            repo.rememberTree(source, tree)
            model.refresh(repo, true)
        } catch (_: Exception) {
            toast(R.string.media_access_removed)
        }
    }

    private val deleteConsent = registerForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult(),
    ) {
        model.refresh(repo, true)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        setContentView(R.layout.activity_media_hub)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.mediaRoot)) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            view.setPadding(bars.left + dp(16), bars.top, bars.right + dp(16), bars.bottom)
            insets
        }
        repo = MediaRepository(this)
        model = ViewModelProvider(this)[MediaHubViewModel::class.java]
        gallery = findViewById(R.id.mediaList)
        banner = findViewById(R.id.mediaBanner)
        bannerText = findViewById(R.id.mediaBannerText)
        bannerAction = findViewById(R.id.mediaBannerAction)
        bannerOther = findViewById(R.id.mediaBannerOther)
        sources = findViewById(R.id.mediaSources)
        categories = findViewById(R.id.mediaCategories)
        filters = findViewById(R.id.mediaFilters)
        adapter = MediaAdapter(
            context = this,
            resolver = contentResolver,
            scope = lifecycleScope,
            selection = model.selection,
            spanCount = { (gallery.layoutManager as? GridLayoutManager)?.spanCount ?: 1 },
            onTap = ::onItem,
            onLongPress = { toggleSelection(it.id) },
        )
        gallery.adapter = adapter
        bindControls()
        render()
        model.refresh(repo)
    }

    private fun bindControls() {
        findViewById<View>(R.id.mediaBack).setOnClickListener { finish() }
        findViewById<View>(R.id.mediaInsights).setOnClickListener { showInsights() }
        findViewById<View>(R.id.mediaSort).setOnClickListener { view ->
            PopupMenu(this, view).apply {
                MediaSort.entries.forEach { option ->
                    menu.add(option.ordinal, option.ordinal, option.ordinal, sortTitle(option))
                }
                setOnMenuItemClickListener { choice ->
                    sort = MediaSort.entries[choice.itemId]
                    render()
                    true
                }
                show()
            }
        }
        findViewById<EditText>(R.id.mediaSearch).addTextChangedListener { text ->
            searchJob?.cancel()
            val nextQuery = text?.toString().orEmpty()
            searchJob = lifecycleScope.launch {
                delay(250)
                query = nextQuery
                render()
            }
        }
        findViewById<View>(R.id.mediaSelectAll).setOnClickListener {
            model.selection.selectAll(shown)
            renderSelectionBar()
            adapter.notifyAllSelectionChanged()
        }
        findViewById<View>(R.id.mediaClear).setOnClickListener {
            model.selection.clear()
            renderSelectionBar()
            adapter.notifyAllSelectionChanged()
        }
        findViewById<View>(R.id.mediaSave).setOnClickListener { saveItems(selected()) }
        findViewById<View>(R.id.mediaShare).setOnClickListener { shareItems(selected()) }
        findViewById<View>(R.id.mediaFavorite).setOnClickListener { favoriteItems(selected()) }
        findViewById<View>(R.id.mediaDelete).setOnClickListener { confirmDelete(selected()) }

        var touchY = 0f
        gallery.addOnItemTouchListener(object : RecyclerView.SimpleOnItemTouchListener() {
            override fun onInterceptTouchEvent(rv: RecyclerView, event: MotionEvent): Boolean {
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> touchY = event.y
                    MotionEvent.ACTION_UP -> {
                        if (!rv.canScrollVertically(-1) && event.y - touchY > dp(90)) {
                            model.refresh(repo, true)
                            toast(R.string.media_refreshing)
                        }
                    }
                }
                return false
            }
        })
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch { model.items.collect { render() } }
                launch { model.loading.collect { render() } }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        observer = object : ContentObserver(handler) {
            override fun onChange(selfChange: Boolean) {
                handler.removeCallbacks(scanLater)
                handler.postDelayed(scanLater, 800)
            }
        }.also { current ->
            repo.observedUris.forEach { uri ->
                contentResolver.registerContentObserver(uri, true, current)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (::repo.isInitialized) model.refresh(repo)
    }

    override fun onStop() {
        observer?.let(contentResolver::unregisterContentObserver)
        observer = null
        handler.removeCallbacks(scanLater)
        super.onStop()
    }

    override fun onDestroy() {
        viewer?.dismiss()
        progressDialog?.dismiss()
        bulkJob?.cancel()
        searchJob?.cancel()
        super.onDestroy()
    }

    private fun access(): String {
        if (Build.VERSION.SDK_INT < 33) {
            return if (granted(Manifest.permission.READ_EXTERNAL_STORAGE)) "full" else "denied"
        }
        val fullVisual = granted(Manifest.permission.READ_MEDIA_IMAGES) &&
            granted(Manifest.permission.READ_MEDIA_VIDEO)
        val partial = Build.VERSION.SDK_INT >= 34 &&
            granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) && !fullVisual
        return when {
            fullVisual -> "full"
            partial -> "partial"
            granted(Manifest.permission.READ_MEDIA_IMAGES) ||
                granted(Manifest.permission.READ_MEDIA_VIDEO) -> "partial"
            else -> "denied"
        }
    }

    private fun hasAnyAccess(): Boolean = access() != "denied" ||
        Build.VERSION.SDK_INT >= 33 && granted(Manifest.permission.READ_MEDIA_AUDIO)

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun requestMedia() {
        val names = if (Build.VERSION.SDK_INT >= 33) {
            mutableListOf(
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.READ_MEDIA_AUDIO,
            ).apply {
                if (Build.VERSION.SDK_INT >= 34) add(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
            }.toTypedArray()
        } else {
            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        permissions.launch(names)
    }

    private fun settings() {
        val uri = "package:$packageName".toUri()
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri))
    }

    private fun tree() {
        val choose = { business: Boolean ->
            val pkg = if (business) "com.whatsapp.w4b/WhatsApp Business" else "com.whatsapp/WhatsApp"
            val initial = DocumentsContract.buildDocumentUri(
                "com.android.externalstorage.documents",
                "primary:Android/media/$pkg/Media",
            )
            treePicker.launch(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                putExtra(DocumentsContract.EXTRA_INITIAL_URI, initial)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            })
        }
        when (source) {
            MediaSource.WHATSAPP_BUSINESS -> choose(true)
            MediaSource.WHATSAPP -> choose(false)
            else -> MaterialAlertDialogBuilder(this)
                .setTitle(R.string.media_choose_app)
                .setItems(arrayOf(getString(R.string.media_whatsapp), getString(R.string.media_business))) {
                    _, which -> choose(which == 1)
                }.show()
        }
    }

    private fun installed(pkg: String): Boolean = try {
        packageManager.getPackageInfo(pkg, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    private fun render() {
        if (!::model.isInitialized) return
        val all = model.items.value
        val both = installed("com.whatsapp") && installed("com.whatsapp.w4b") ||
            all.any { it.source == MediaSource.WHATSAPP } &&
            all.any { it.source == MediaSource.WHATSAPP_BUSINESS }
        findViewById<View>(R.id.mediaSourcesScroll).visibility = if (both) View.VISIBLE else View.GONE
        if (both) {
            val names = listOf(
                getString(R.string.media_all),
                getString(R.string.media_whatsapp),
                getString(R.string.media_business),
            )
            val selectedSource = when (source) {
                MediaSource.WHATSAPP -> 1
                MediaSource.WHATSAPP_BUSINESS -> 2
                else -> 0
            }
            chips(sources, names, selectedSource) { index ->
                source = when (index) {
                    1 -> MediaSource.WHATSAPP
                    2 -> MediaSource.WHATSAPP_BUSINESS
                    else -> null
                }
                render()
            }
        }
        val categoryKeys = listOf(
            "Statuses", "Images", "Videos", "Voice notes", "Audio", "Documents", "Stickers", "Saved",
        )
        val categoryLabels = listOf(
            R.string.media_statuses, R.string.media_images, R.string.media_videos, R.string.media_voice,
            R.string.media_audio, R.string.media_documents, R.string.media_stickers, R.string.media_saved,
        )
        chips(categories, categoryLabels.map(::getString), categoryKeys.indexOf(category)) { index ->
            category = categoryKeys[index]
            render()
        }
        val filterLabels = listOf(
            R.string.media_all, R.string.media_today, R.string.media_yesterday, R.string.media_week,
            R.string.media_large, R.string.media_saved, R.string.media_favorites,
        )
        chips(filters, filterLabels.map(::getString), filter.ordinal) { index ->
            filter = MediaFilter.entries[index]
            render()
        }
        shown = MediaLogic.visible(
            all, category, source, filter, sort, query, Instant.now(), ZoneId.systemDefault(),
        )
        val grid = category in setOf("Statuses", "Images", "Videos", "Stickers") ||
            category == "Saved" && shown.all {
                it.mediaType in setOf(MediaType.IMAGE, MediaType.VIDEO, MediaType.STICKER)
            }
        val span = if (grid) 3 else 1
        if ((gallery.layoutManager as? GridLayoutManager)?.spanCount != span) {
            gallery.layoutManager = GridLayoutManager(this, span)
        }
        adapter.submitList(shown)
        val countText = if (model.loading.value) {
            getString(R.string.media_loading)
        } else {
            resources.getQuantityString(R.plurals.media_count, shown.size, shown.size)
        }
        findViewById<TextView>(R.id.mediaCount).text = countText
        renderSelectionBar()
        showBanner(all)
    }

    private fun renderSelectionBar() {
        val count = model.selection.selected.size
        findViewById<View>(R.id.mediaSelection).visibility = if (count > 0) View.VISIBLE else View.GONE
        findViewById<TextView>(R.id.mediaSelectionCount).text =
            resources.getQuantityString(R.plurals.media_selected_count, count, count)
    }

    private fun showBanner(all: List<MediaItem>) {
        banner.visibility = View.VISIBLE
        bannerOther.visibility = View.GONE
        when {
            access() == "denied" &&
                (category != "Audio" && category != "Voice notes" || !hasAnyAccess()) -> {
                bannerText.setText(R.string.media_rationale)
                bannerAction.setText(R.string.media_allow)
                bannerAction.setOnClickListener { requestMedia() }
                bannerOther.visibility = View.VISIBLE
                bannerOther.setText(R.string.media_settings)
                bannerOther.setOnClickListener { settings() }
            }
            Build.VERSION.SDK_INT >= 33 &&
                (category == "Audio" || category == "Voice notes") &&
                !granted(Manifest.permission.READ_MEDIA_AUDIO) -> {
                bannerText.setText(R.string.media_audio_permission)
                bannerAction.setText(R.string.media_allow)
                bannerAction.setOnClickListener { requestMedia() }
            }
            access() == "partial" && category != "Audio" && category != "Voice notes" -> {
                bannerText.setText(R.string.media_partial)
                bannerAction.setText(R.string.media_select_more)
                bannerAction.setOnClickListener { requestMedia() }
                bannerOther.visibility = View.VISIBLE
                bannerOther.setText(R.string.media_settings)
                bannerOther.setOnClickListener { settings() }
            }
            category == "Statuses" || category == "Documents" -> showStatusBanner(all)
            shown.isEmpty() && !model.loading.value -> {
                bannerText.setText(
                    if (all.isEmpty() && !installed("com.whatsapp") && !installed("com.whatsapp.w4b")) {
                        R.string.media_not_installed
                    } else {
                        R.string.media_empty
                    },
                )
                bannerAction.setText(R.string.media_refresh)
                bannerAction.setOnClickListener { model.refresh(repo, true) }
            }
            else -> banner.visibility = View.GONE
        }
    }

    private fun showStatusBanner(all: List<MediaItem>) {
        val targetSources = if (source == null) {
            listOf(MediaSource.WHATSAPP, MediaSource.WHATSAPP_BUSINESS)
        } else {
            listOf(source!!)
        }
        val revoked = targetSources.any { it in repo.brokenTrees }
        val missing = !model.loading.value && all.none { item ->
            (source == null || item.source == source) &&
                if (category == "Statuses") item.isStatus else item.mediaType == MediaType.DOCUMENT
        }
        when {
            revoked -> bannerText.setText(R.string.media_access_removed)
            missing && all.isEmpty() && !installed("com.whatsapp") && !installed("com.whatsapp.w4b") -> {
                bannerText.setText(R.string.media_not_installed)
            }
            missing -> bannerText.setText(R.string.media_enable_status_info)
            else -> {
                banner.visibility = View.GONE
                return
            }
        }
        bannerAction.setText(R.string.media_enable_status)
        bannerAction.setOnClickListener { tree() }
    }

    private fun chips(
        parent: LinearLayout,
        labels: List<String>,
        selected: Int,
        click: (Int) -> Unit,
    ) {
        val unchanged = parent.childCount == labels.size && (0 until labels.size).all { index ->
            val chip = parent.getChildAt(index) as TextView
            chip.text == labels[index] && chip.isSelected == (index == selected)
        }
        if (unchanged) return

        parent.removeAllViews()
        labels.forEachIndexed { index, label ->
            val chip = TextView(this).apply {
                text = label
                gravity = Gravity.CENTER
                minHeight = dp(48)
                setPadding(dp(14), 0, dp(14), 0)
                setTextColor(ContextCompat.getColor(
                    this@MediaHubActivity,
                    if (index == selected) R.color.levix_cyan else R.color.levix_text_muted,
                ))
                setBackgroundResource(
                    if (index == selected) R.drawable.bg_card_raised else R.drawable.bg_card_panel,
                )
                isSelected = index == selected
                setOnClickListener { click(index) }
            }
            parent.addView(
                chip,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ).apply { marginEnd = dp(6) },
            )
        }
    }

    private fun selected(): List<MediaItem> {
        val ids = model.selection.selected
        return model.items.value.filter { it.id in ids }
    }

    private fun toggleSelection(id: String) {
        model.selection.toggle(id)
        adapter.notifySelectionChanged(id)
        renderSelectionBar()
    }

    private fun onItem(item: MediaItem) {
        if (model.selection.active) {
            toggleSelection(item.id)
        } else {
            viewer = StatusViewer(
                activity = this,
                items = shown,
                isFavorite = { id -> id in repo.favorites() },
                onSave = { saveItems(listOf(it)) },
                onShare = { shareItems(listOf(it)) },
                onOpen = ::openItem,
                onFavorite = { current ->
                    repo.toggleFavorite(current.id)
                    model.updateFavorites(repo.favorites())
                },
                onDelete = { confirmDelete(listOf(it)) },
                onDismiss = { viewer = null },
            )
            if (viewer?.show(item) != true) {
                viewer = null
                openItem(item)
            }
        }
    }

    private fun favoriteItems(items: List<MediaItem>) {
        if (items.isEmpty()) return
        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.media_favorite)
            .setMessage(getString(R.string.media_favorite_progress, 0, items.size))
            .setNegativeButton(R.string.media_cancel) { _, _ -> bulkJob?.cancel() }
            .create()
        dialog.show()
        progressDialog = dialog
        bulkJob = lifecycleScope.launch {
            for ((index, item) in items.withIndex()) {
                dialog.setMessage(getString(R.string.media_favorite_progress, index + 1, items.size))
                withContext(Dispatchers.IO) { repo.toggleFavorite(item.id) }
            }
            dialog.dismiss()
            progressDialog = null
            model.updateFavorites(repo.favorites())
            model.selection.clear()
            render()
        }
        dialog.setOnCancelListener { bulkJob?.cancel() }
    }

    private fun saveItems(items: List<MediaItem>) {
        if (items.isEmpty()) return
        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.media_save)
            .setMessage(getString(R.string.media_progress, 0, items.size))
            .setNegativeButton(R.string.media_cancel) { _, _ -> bulkJob?.cancel() }
            .create()
        dialog.show()
        progressDialog = dialog
        bulkJob = lifecycleScope.launch {
            var saved = 0
            var existing = 0
            var failed = 0
            for ((index, item) in items.withIndex()) {
                dialog.setMessage(getString(R.string.media_progress, index + 1, items.size))
                when (withContext(Dispatchers.IO) { repo.save(item, model.items.value) }) {
                    MediaRepository.SaveResult.SAVED -> saved++
                    MediaRepository.SaveResult.ALREADY_SAVED -> existing++
                    MediaRepository.SaveResult.FAILED -> failed++
                }
            }
            dialog.dismiss()
            progressDialog = null
            val feedback = if (items.size == 1) {
                getString(when {
                    saved == 1 -> R.string.media_saved_success
                    existing == 1 -> R.string.media_already_saved
                    else -> R.string.media_save_failed
                })
            } else {
                listOf(
                    resources.getQuantityString(R.plurals.media_saved_count, saved, saved),
                    resources.getQuantityString(R.plurals.media_already_saved_count, existing, existing),
                    resources.getQuantityString(R.plurals.media_failed_count, failed, failed),
                ).joinToString(" · ")
            }
            toast(feedback)
            model.selection.clear()
            model.refresh(repo, true)
        }
        dialog.setOnCancelListener { bulkJob?.cancel() }
    }

    private fun shareItems(items: List<MediaItem>) {
        if (items.isEmpty()) return
        try {
            val uris = ArrayList(items.map { it.uri.toUri() })
            val sameType = items.map { it.mimeType }.distinct().size == 1
            val intent = Intent(
                if (uris.size == 1) Intent.ACTION_SEND else Intent.ACTION_SEND_MULTIPLE,
            ).apply {
                type = if (sameType) items.first().mimeType.ifBlank { "*/*" } else "*/*"
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                clipData = ClipData.newUri(
                    contentResolver, items.first().displayName, uris.first(),
                ).also { clip ->
                    uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
                }
                if (uris.size == 1) {
                    putExtra(Intent.EXTRA_STREAM, uris.first())
                } else {
                    putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                }
            }
            startActivity(Intent.createChooser(intent, getString(R.string.media_share)))
        } catch (_: Exception) {
            toast(R.string.media_unavailable)
        }
    }

    private fun openItem(item: MediaItem) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(item.uri.toUri(), item.mimeType.ifBlank { "*/*" })
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            })
        } catch (_: ActivityNotFoundException) {
            toast(R.string.media_unsupported)
        } catch (_: Exception) {
            toast(R.string.media_unavailable)
        }
    }

    private fun confirmDelete(items: List<MediaItem>) {
        val saved = MediaLogic.deleteCandidates(items)
        if (saved.isEmpty()) {
            toast(R.string.media_delete_saved_only)
            return
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.media_delete)
            .setMessage(resources.getQuantityString(R.plurals.media_delete_confirm, saved.size, saved.size))
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.media_delete) { _, _ -> deleteItems(saved) }
            .show()
    }

    private fun deleteItems(saved: List<MediaItem>) {
        val progress = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.media_delete)
            .setMessage(getString(R.string.media_delete_progress, 0, saved.size))
            .setNegativeButton(R.string.media_cancel) { _, _ -> bulkJob?.cancel() }
            .create()
        progress.show()
        progressDialog = progress
        bulkJob = lifecycleScope.launch {
            var failed = false
            for ((index, item) in saved.withIndex()) {
                progress.setMessage(getString(R.string.media_delete_progress, index + 1, saved.size))
                val outcome = withContext(Dispatchers.IO) { repo.deleteSaved(listOf(item)) }
                if (outcome.needsConsent) {
                    try {
                        val pending = if (Build.VERSION.SDK_INT >= 30) {
                            val remaining = saved.drop(index).map { it.uri.toUri() }
                            MediaStore.createDeleteRequest(contentResolver, remaining)
                        } else {
                            outcome.consent
                        }
                        if (pending != null) {
                            deleteConsent.launch(IntentSenderRequest.Builder(pending.intentSender).build())
                        } else {
                            failed = true
                        }
                    } catch (_: Exception) {
                        failed = true
                    }
                    break
                }
                if (!outcome.success) failed = true
            }
            progress.dismiss()
            progressDialog = null
            if (failed) toast(R.string.media_delete_failed)
            model.selection.clear()
            model.refresh(repo, true)
        }
        progress.setOnCancelListener { bulkJob?.cancel() }
    }

    private fun showInsights() {
        val insight = MediaLogic.insights(model.items.value)
        val total = Formatter.formatShortFileSize(this, insight.totalBytes)
        val lines = buildString {
            append(resources.getQuantityString(
                R.plurals.media_insights_total, insight.count, insight.count, total,
            ))
            insight.byType.forEach { (type, bytes) ->
                append("\n${typeLabel(type)}: ${Formatter.formatShortFileSize(this@MediaHubActivity, bytes)}")
            }
            if (insight.largest.isNotEmpty()) {
                append("\n\n${getString(R.string.media_largest)}\n")
                append(insight.largest.joinToString("\n") { item ->
                    "${item.displayName} · ${Formatter.formatShortFileSize(this@MediaHubActivity, item.size)}"
                })
            }
            if (insight.recent.isNotEmpty()) {
                append("\n\n${getString(R.string.media_recent)}\n")
                append(insight.recent.joinToString("\n") { it.displayName })
            }
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.media_insights)
            .setMessage(lines)
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun sortTitle(value: MediaSort): String = getString(when (value) {
        MediaSort.NEWEST -> R.string.media_newest
        MediaSort.OLDEST -> R.string.media_oldest
        MediaSort.LARGEST -> R.string.media_largest_sort
        MediaSort.SMALLEST -> R.string.media_smallest
    })

    private fun typeLabel(value: MediaType): String = getString(when (value) {
        MediaType.IMAGE -> R.string.media_images
        MediaType.VIDEO -> R.string.media_videos
        MediaType.VOICE -> R.string.media_voice
        MediaType.AUDIO -> R.string.media_audio
        MediaType.DOCUMENT -> R.string.media_documents
        MediaType.STICKER -> R.string.media_stickers
    })

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun toast(id: Int) {
        toast(getString(id))
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }
}
