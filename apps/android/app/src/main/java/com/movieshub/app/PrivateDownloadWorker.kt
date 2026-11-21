package com.movieshub.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Télécharge les vidéos dans filesDir : elles ne sont ni indexées par MediaStore,
 * ni visibles dans la galerie publique. Le .part et le downloadId sont conservés
 * pour reprendre un téléchargement mis en pause.
 */
class PrivateDownloadWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    companion object {
        const val TAG = "moviehub-downloads"
        private const val CHANNEL_ID = "moviehub_downloads"
        private const val NOTIFICATION_ID = 4107
    }

    private data class ApiResult(val code: Int, val body: String)
    private data class DownloadLink(val id: String, val url: String, val filename: String, val sizeBytes: Long)

    private fun securePrefs() = androidx.security.crypto.EncryptedSharedPreferences.create(
        applicationContext,
        "moviehub_secure_session",
        androidx.security.crypto.MasterKey.Builder(applicationContext)
            .setKeyScheme(androidx.security.crypto.MasterKey.KeyScheme.AES256_GCM).build(),
        androidx.security.crypto.EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        androidx.security.crypto.EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    private fun api(method: String, path: String, token: String? = null, body: JSONObject? = null): ApiResult {
        val base = BuildConfig.API_BASE_URL.trimEnd('/')
        val connection = (URL(base + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 30_000
            setRequestProperty("Accept", "application/json")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
            token?.let { setRequestProperty("Authorization", "Bearer $it") }
        }
        return try {
            if (body != null) connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            ApiResult(code, stream?.bufferedReader()?.use { it.readText() }.orEmpty())
        } finally {
            connection.disconnect()
        }
    }

    private fun activeAccessToken(): String {
        val prefs = securePrefs()
        val refresh = prefs.getString("refresh_token", null) ?: error("Connecte-toi pour télécharger un film.")
        var access = prefs.getString("access_token", null) ?: error("Session introuvable.")
        val expiry = prefs.getLong("expires_at", 0L)
        if (expiry <= System.currentTimeMillis() + 60_000L) {
            val response = api("POST", "/auth/refresh", body = JSONObject().put("refreshToken", refresh))
            if (response.code !in 200..299) error("Session expirée. Reconnecte-toi.")
            val json = JSONObject(response.body)
            access = json.getString("accessToken")
            prefs.edit()
                .putString("access_token", access)
                .putString("refresh_token", json.getString("refreshToken"))
                .putLong("expires_at", System.currentTimeMillis() + json.optLong("expiresIn", 900L) * 1000L)
                .apply()
        }
        return access
    }

    private fun apiWithAuth(method: String, path: String, body: JSONObject? = null): JSONObject {
        var token = activeAccessToken()
        var response = api(method, path, token, body)
        if (response.code == 401) {
            val prefs = securePrefs()
            val refresh = prefs.getString("refresh_token", null) ?: error("Session expirée.")
            val renewed = api("POST", "/auth/refresh", body = JSONObject().put("refreshToken", refresh))
            if (renewed.code !in 200..299) error("Session expirée. Reconnecte-toi.")
            val json = JSONObject(renewed.body)
            token = json.getString("accessToken")
            prefs.edit().putString("access_token", token)
                .putString("refresh_token", json.getString("refreshToken"))
                .putLong("expires_at", System.currentTimeMillis() + json.optLong("expiresIn", 900L) * 1000L).apply()
            response = api(method, path, token, body)
        }
        if (response.code !in 200..299) {
            val message = runCatching { JSONObject(response.body).optString("message") }.getOrNull()
            error(message?.takeIf { it.isNotBlank() } ?: "Erreur API HTTP ${response.code}")
        }
        return if (response.body.isBlank()) JSONObject() else JSONObject(response.body)
    }

    private fun downloadDirectory(): File = File(applicationContext.filesDir, "downloads").apply { mkdirs() }

    private fun notification(percent: Int): ForegroundInfo {
        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val language = applicationContext.getSharedPreferences("moviehub_preferences", Context.MODE_PRIVATE)
            .getString("language", "fr") ?: "fr"
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    translateMovieHubText("Téléchargements MovieHub", language),
                    NotificationManager.IMPORTANCE_LOW
                )
            )
        }
        val title = inputData.getString("title") ?: "Téléchargement MovieHub"
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(translateMovieHubText("Téléchargement : $percent %", language))
            .setProgress(100, percent, false)
            .setOngoing(true)
            .build()
        return ForegroundInfo(NOTIFICATION_ID, notification)
    }

    private fun finishOnServer(downloadId: String, status: String, reason: String? = null) {
        runCatching {
            apiWithAuth("POST", "/downloads/$downloadId/status", JSONObject()
                .put("status", status)
                .apply { if (reason != null) put("failureReason", reason.take(200)) })
        }
    }

    override suspend fun doWork(): Result {
        val versionId = inputData.getString("versionId") ?: return Result.failure()
        val title = inputData.getString("title") ?: "Film MovieHub"
        val label = inputData.getString("versionLabel") ?: "Vidéo"
        val seriesFolder = inputData.getString("seriesFolder")?.takeIf { it.isNotBlank() }
        val seasonNumber = inputData.getInt("seasonNumber", 0)
        val episodeNumber = inputData.getInt("episodeNumber", 0)
        val episodeTitle = inputData.getString("episodeTitle")?.takeIf { it.isNotBlank() }
        val dir = downloadDirectory()
        val partial = File(dir, "$versionId.part")
        val metadata = File(dir, "$versionId.json")
        var downloadId: String? = null

        return try {
            setProgress(Data.Builder()
                .putString("title", title)
                .putString("versionLabel", label)
                .putString("versionId", versionId)
                .putString("seriesFolder", seriesFolder)
                .putInt("seasonNumber", seasonNumber)
                .putInt("episodeNumber", episodeNumber)
                .putString("episodeTitle", episodeTitle)
                .putInt("progressPercent", 0)
                .build())
            setForeground(notification(0))
            activeAccessToken()
            var link: DownloadLink? = null

            if (metadata.exists()) {
                val old = runCatching { JSONObject(metadata.readText()) }.getOrNull()
                val oldId = old?.optString("downloadId")?.takeIf { it.isNotBlank() }
                if (oldId != null) {
                    val refreshed = runCatching { apiWithAuth("POST", "/downloads/$oldId/refresh-url") }.getOrNull()
                    if (refreshed != null) {
                        link = DownloadLink(oldId, refreshed.getString("url"), refreshed.getString("filename"), refreshed.optLong("sizeBytes"))
                    }
                }
            }

            if (link == null) {
                val started = apiWithAuth("POST", "/versions/$versionId/download")
                link = DownloadLink(
                    started.getString("downloadId"),
                    started.getString("url"),
                    started.getString("filename"),
                    started.optLong("sizeBytes")
                )
            }
            val activeLink = link ?: error("Lien de téléchargement indisponible.")
            downloadId = activeLink.id
            metadata.writeText(JSONObject().put("downloadId", activeLink.id).put("filename", activeLink.filename).toString())

            val safeName = activeLink.filename.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[^A-Za-z0-9._ -]"), "_").take(150)
            val outputDirectory = if (seriesFolder != null && seasonNumber > 0) {
                val safeSeries = seriesFolder.replace(Regex("[^A-Za-z0-9._ -]"), "_").trim().take(80).ifBlank { "Série MovieHub" }
                val seasonFolderName = "Saison " + seasonNumber.toString().padStart(2, '0')
                File(File(dir, safeSeries), seasonFolderName).apply { mkdirs() }
            } else dir
            val episodePrefix = if (seriesFolder != null && seasonNumber > 0 && episodeNumber > 0) {
                "S" + seasonNumber.toString().padStart(2, '0') + "E" + episodeNumber.toString().padStart(2, '0') +
                    " - " + (episodeTitle ?: title).replace(Regex("[^A-Za-z0-9._ -]"), "_").trim().take(90) + " - "
            } else ""
            val output = File(outputDirectory, episodePrefix + safeName.ifBlank { "$versionId.video" })
            val offset = if (partial.exists()) partial.length() else 0L
            var connection = (URL(activeLink.url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 20_000
                readTimeout = 60_000
                if (offset > 0L) setRequestProperty("Range", "bytes=$offset-")
            }
            var code = connection.responseCode
            if (code == 401 || code == 403) {
                connection.disconnect()
                val refreshed = apiWithAuth("POST", "/downloads/${activeLink.id}/refresh-url")
                connection = (URL(refreshed.getString("url")).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 20_000
                    readTimeout = 60_000
                    if (offset > 0L) setRequestProperty("Range", "bytes=$offset-")
                }
                code = connection.responseCode
            }
            if (code !in listOf(200, 206)) {
                connection.disconnect()
                error("Le serveur de fichiers a répondu HTTP $code.")
            }

            val append = offset > 0L && code == 206
            if (offset > 0L && code == 200) partial.delete()
            val startingBytes = if (append) offset else 0L
            val totalBytes = activeLink.sizeBytes.takeIf { it > 0L } ?: connection.getHeaderFieldLong("Content-Length", -1L).let { if (it > 0) it + startingBytes else -1L }
            connection.inputStream.use { input ->
                FileOutputStream(partial, append).use { outputStream ->
                        val buffer = ByteArray(256 * 1024)
                        var downloaded = startingBytes
                        var lastPercent = -1
                        while (true) {
                            if (isStopped) throw CancellationException("Téléchargement mis en pause")
                            val count = input.read(buffer)
                            if (count < 0) break
                            outputStream.write(buffer, 0, count)
                            downloaded += count
                            val percent = if (totalBytes > 0) ((downloaded * 100) / totalBytes).toInt().coerceIn(0, 100) else 0
                            if (percent != lastPercent) {
                                setProgress(Data.Builder()
                                    .putString("title", title)
                                    .putString("versionLabel", label)
                                    .putString("versionId", versionId)
                                    .putInt("progressPercent", percent)
                                    .putLong("downloadedBytes", downloaded)
                                    .putLong("totalBytes", totalBytes)
                                    .build())
                                if (percent % 5 == 0) setForeground(notification(percent))
                                lastPercent = percent
                            }
                        }
                    }
            }
            connection.disconnect()

            if (activeLink.sizeBytes > 0 && partial.length() != activeLink.sizeBytes) error("Fichier incomplet : ${partial.length()} / ${activeLink.sizeBytes} octets.")
            if (output.exists()) output.delete()
            if (!partial.renameTo(output)) error("Impossible d’enregistrer le fichier dans l’espace privé.")
            finishOnServer(activeLink.id, "COMPLETED")
            metadata.delete()
            Result.success(Data.Builder().putString("title", title).putString("versionLabel", label).putString("filePath", output.absolutePath).putLong("sizeBytes", output.length()).build())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            downloadId?.let { finishOnServer(it, "FAILED", error.message ?: "Erreur inconnue") }
            metadata.delete()
            Result.failure(Data.Builder()
                .putString("error", error.message ?: "Téléchargement impossible")
                .putString("title", title)
                .putString("versionLabel", label)
                .putString("versionId", versionId)
                .build())
        }
    }
}
