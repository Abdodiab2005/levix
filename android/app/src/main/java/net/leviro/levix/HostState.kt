package net.leviro.levix

import android.content.Context
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * In-process host snapshot. The Activity reads this; the service writes it.
 */
object HostState {
    data class Snapshot(
        val running: Boolean = false,
        val lastHeartbeatMs: Long = 0L,
        val heartbeatCount: Long = 0L,
        val startedAtMs: Long = 0L,
        val nodeAlive: Boolean = false,
        val nodeVersion: String? = null,
        val nodePlatform: String? = null,
        val nodeArch: String? = null,
        val nodeLine: String? = null,
        val nodeError: String? = null,
        val sqliteOk: Boolean = false,
        val tlsOk: Boolean = false,
        val databaseReady: Boolean = false,
        val commandsLoaded: Int? = null,
        val panelUrl: String? = null,
        val levixReady: Boolean = false,
        val whatsAppState: String? = null,
        val whatsAppCode: Int? = null,
        val whatsAppReason: String? = null,
    )

    @Volatile
    var snapshot: Snapshot = Snapshot()
        private set

    private val listeners = CopyOnWriteArrayList<(Snapshot) -> Unit>()

    /** Mutable Levix data (`levix.db`, logs, memory). Code lives in filesDir/app. */
    fun dataDir(context: Context): File = LevixAppBundle.dataDir(context)

    fun listen(listener: (Snapshot) -> Unit): () -> Unit {
        listeners.add(listener)
        listener(snapshot)
        return { listeners.remove(listener) }
    }

    @Synchronized
    fun markStarted() {
        val now = System.currentTimeMillis()
        publish(
            Snapshot(
                running = true,
                lastHeartbeatMs = 0L,
                heartbeatCount = 0L,
                startedAtMs = now,
            ),
        )
    }

    @Synchronized
    fun heartbeat() {
        val current = snapshot
        if (!current.running) return
        publish(
            current.copy(
                lastHeartbeatMs = System.currentTimeMillis(),
                heartbeatCount = current.heartbeatCount + 1L,
            ),
        )
    }

    @Synchronized
    fun markStopped() {
        publish(Snapshot())
    }

    @Synchronized
    fun markNodeStarting() {
        publish(snapshot.copy(nodeAlive = false, nodeError = null, nodeLine = "starting"))
    }

    @Synchronized
    fun markNodeAlive() {
        publish(snapshot.copy(nodeAlive = true, nodeError = null))
    }

    @Synchronized
    fun markNodeStopped() {
        publish(
            snapshot.copy(
                nodeAlive = false,
                nodeLine = null,
                nodeError = null,
            ),
        )
    }

    @Synchronized
    fun markNodeError(message: String) {
        publish(snapshot.copy(nodeAlive = false, nodeError = message))
    }

    @Synchronized
    fun setNodeVersion(version: String) {
        publish(snapshot.copy(nodeVersion = version, nodeAlive = true, nodeError = null))
    }

    @Synchronized
    fun setNodePlatform(platform: String) {
        publish(snapshot.copy(nodePlatform = platform))
    }

    @Synchronized
    fun setNodeArch(arch: String) {
        publish(snapshot.copy(nodeArch = arch))
    }

    @Synchronized
    fun setNodeLine(line: String) {
        publish(snapshot.copy(nodeLine = line.take(200)))
    }

    @Synchronized
    fun markSqliteOk() {
        publish(snapshot.copy(sqliteOk = true, nodeAlive = true, nodeError = null))
    }

    @Synchronized
    fun markTlsOk() {
        publish(snapshot.copy(tlsOk = true, nodeAlive = true))
    }

    @Synchronized
    fun markDatabaseReady() {
        publish(snapshot.copy(databaseReady = true, nodeAlive = true))
    }

    @Synchronized
    fun markCommandsLoaded(count: Int?) {
        publish(snapshot.copy(commandsLoaded = count, nodeAlive = true))
    }

    @Synchronized
    fun markPanelListening(url: String) {
        publish(snapshot.copy(panelUrl = url, nodeAlive = true))
    }

    @Synchronized
    fun markLevixReady() {
        publish(snapshot.copy(levixReady = true, nodeAlive = true, nodeError = null))
    }

    @Synchronized
    fun setWhatsAppStatus(state: String?, code: Int?, reason: String?) {
        val current = snapshot
        if (!current.running) return
        publish(current.copy(whatsAppState = state, whatsAppCode = code, whatsAppReason = reason))
    }

    private fun publish(next: Snapshot) {
        snapshot = next
        listeners.forEach { listener -> listener(next) }
    }
}
