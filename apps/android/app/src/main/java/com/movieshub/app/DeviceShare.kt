package com.movieshub.app

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

data class SharedVideo(val file: File, val title: String)

fun listSharedVideos(context: Context): List<SharedVideo> {
    val directory = File(context.filesDir, "downloads/shared")
    return directory.listFiles()
        ?.filter { it.isFile && it.length() > 0L && it.extension.lowercase() in setOf("mp4", "mkv", "webm", "mov", "m4v", "avi") }
        ?.sortedByDescending { it.lastModified() }
        ?.map { SharedVideo(it, it.nameWithoutExtension.replace('_', ' ')) }
        .orEmpty()
}

suspend fun importSharedVideo(context: Context, uri: Uri): SharedVideo = withContext(Dispatchers.IO) {
    val resolver = context.contentResolver
    val mime = resolver.getType(uri)
    require(mime == null || mime.startsWith("video/") || mime == "application/octet-stream") {
        "Seules les vidéos peuvent être reçues."
    }
    val originalName = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    } ?: "video.mp4"
    val extension = originalName.substringAfterLast('.', "mp4").lowercase()
        .filter { it.isLetterOrDigit() }.take(8).ifBlank { "mp4" }
    val safeTitle = originalName.substringBeforeLast('.', originalName)
        .replace(Regex("[^A-Za-z0-9 _-]"), "_").trim().take(70).ifBlank { "Video MovieHub" }
    val directory = File(context.filesDir, "downloads/shared").apply { mkdirs() }
    val destination = File(directory, "${safeTitle}_${UUID.randomUUID().toString().take(8)}.$extension")
    try {
        resolver.openInputStream(uri)?.use { input ->
            destination.outputStream().buffered().use { output -> input.copyTo(output) }
        } ?: error("Impossible d’ouvrir le fichier reçu.")
        require(destination.length() > 0L) { "Le fichier reçu est vide." }
        SharedVideo(destination, safeTitle)
    } catch (error: Throwable) {
        destination.delete()
        throw error
    }
}

fun sharePrivateVideo(context: Context, file: File, title: String) {
    require(file.isFile && file.canRead()) { "Le fichier vidéo est introuvable." }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "video/*"
        putExtra(Intent.EXTRA_STREAM, uri)
        clipData = ClipData.newUri(context.contentResolver, title, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(send, "Partager avec un autre appareil"))
}
