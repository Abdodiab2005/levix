package net.leviro.levix.media

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MediaHubViewModel : ViewModel() {
    private val mutableItems = MutableStateFlow<List<MediaItem>>(emptyList())
    val items: StateFlow<List<MediaItem>> = mutableItems

    private val mutableLoading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = mutableLoading

    val selection = SelectionState()
    var lastScan = 0L
        private set

    private var job: Job? = null

    fun refresh(repo: MediaRepository, force: Boolean = false) {
        if (!force && System.currentTimeMillis() - lastScan < 30_000L) return
        if (job?.isActive == true) return

        job = viewModelScope.launch {
            mutableLoading.value = true
            try {
                val loaded = withContext(Dispatchers.IO) { repo.scan() }
                mutableItems.value = loaded
                selection.prune(loaded)
                lastScan = System.currentTimeMillis()
            } finally {
                mutableLoading.value = false
            }
        }
    }

    fun updateFavorites(favorites: Set<String>) {
        mutableItems.value = mutableItems.value.map { item ->
            item.copy(isFavorite = item.id in favorites)
        }
    }
}
