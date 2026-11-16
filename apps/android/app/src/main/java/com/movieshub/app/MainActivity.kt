package com.movieshub.app

import android.os.Bundle
import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.media3.common.MediaItem as PlayerMediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

private data class MoviePalette(
    val background: Color,
    val panel: Color,
    val accent: Color,
    val muted: Color,
    val text: Color
)
private val LocalMoviePalette = staticCompositionLocalOf {
    MoviePalette(Color(0xFF050608), Color(0xFF11151B), Color(0xFFFFC94A), Color(0xFF9AA1AC), Color.White)
}
private object UiColors {
    val background: Color @Composable get() = LocalMoviePalette.current.background
    val panel: Color @Composable get() = LocalMoviePalette.current.panel
    val accent: Color @Composable get() = LocalMoviePalette.current.accent
    val muted: Color @Composable get() = LocalMoviePalette.current.muted
    val text: Color @Composable get() = LocalMoviePalette.current.text
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MoviesHubApp() }
    }
}

private enum class Screen { HOME, CATEGORIES, SEARCH, DETAIL, PLAYER, DOWNLOADS, PROFILE, SETTINGS, AUTH, FAVORITES, HISTORY }

private data class SessionUser(val id: String, val email: String, val displayName: String)
private data class AuthSessionData(val user: SessionUser, val accessToken: String, val refreshToken: String, val expiresAtMillis: Long)
private data class HistoryEntry(val id: String, val content: MediaItem, val positionSeconds: Int, val completed: Boolean)

private object SecureSessionStore {
    private fun preferences(context: Context) = EncryptedSharedPreferences.create(
        context,
        "moviehub_secure_session",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    fun read(context: Context): AuthSessionData? = runCatching {
        val prefs = preferences(context)
        val id = prefs.getString("user_id", null) ?: return null
        val email = prefs.getString("email", null) ?: return null
        val name = prefs.getString("display_name", null) ?: return null
        val access = prefs.getString("access_token", null) ?: return null
        val refresh = prefs.getString("refresh_token", null) ?: return null
        val expiresAt = prefs.getLong("expires_at", 0L)
        AuthSessionData(SessionUser(id, email, name), access, refresh, expiresAt)
    }.getOrNull()

    fun save(context: Context, session: AuthSessionData) {
        preferences(context).edit()
            .putString("user_id", session.user.id)
            .putString("email", session.user.email)
            .putString("display_name", session.user.displayName)
            .putString("access_token", session.accessToken)
            .putString("refresh_token", session.refreshToken)
            .putLong("expires_at", session.expiresAtMillis)
            .apply()
    }

    fun clear(context: Context) { preferences(context).edit().clear().apply() }
}

private data class Genre(val slug: String, val name: String)

private data class MediaItem(
    val id: String,
    val title: String,
    val type: String = "Film",
    val year: String = "",
    val description: String = "",
    val poster: String? = null,
    val slug: String = id,
    val trailerUrl: String? = null
)

private object MoviesHubApi {
    private fun request(path: String, method: String, body: JSONObject? = null, bearer: String? = null): String {
        val base = BuildConfig.API_BASE_URL.trimEnd('/')
        val connection = (URL(base + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10000
            readTimeout = 15000
            setRequestProperty("Accept", "application/json")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
            bearer?.let { setRequestProperty("Authorization", "Bearer $it") }
        }
        return try {
            if (body != null) connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) {
                val message = runCatching { JSONObject(response).optString("message") }.getOrNull()
                error(message?.takeIf { it.isNotBlank() } ?: "Erreur API HTTP $code")
            }
            response
        } finally {
            connection.disconnect()
        }
    }

    private fun get(path: String): String = request(path, "GET")

    suspend fun authenticate(email: String, password: String, displayName: String?, register: Boolean): AuthSessionData =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("email", email.trim())
                .put("password", password)
                .put("platform", "ANDROID")
                .put("deviceName", "Android")
            if (register) body.put("displayName", displayName?.trim().orEmpty())
            val result = JSONObject(request(if (register) "/auth/register" else "/auth/login", "POST", body))
            val user = result.getJSONObject("user")
            AuthSessionData(
                SessionUser(user.getString("id"), user.getString("email"), user.getString("displayName")),
                result.getString("accessToken"),
                result.getString("refreshToken"),
                System.currentTimeMillis() + result.optLong("expiresIn", 900L) * 1000L
            )
        }

    suspend fun authorizedGet(path: String, session: AuthSessionData): Pair<AuthSessionData, String> = withContext(Dispatchers.IO) {
        val active = if (session.expiresAtMillis <= System.currentTimeMillis() + 60_000L) {
            val refreshed = JSONObject(request("/auth/refresh", "POST", JSONObject().put("refreshToken", session.refreshToken)))
            val user = refreshed.getJSONObject("user")
            AuthSessionData(
                SessionUser(user.getString("id"), user.getString("email"), user.getString("displayName")),
                refreshed.getString("accessToken"),
                refreshed.getString("refreshToken"),
                System.currentTimeMillis() + refreshed.optLong("expiresIn", 900L) * 1000L
            )
        } else session
        active to request(path, "GET", bearer = active.accessToken)
    }

    suspend fun deleteAuthorized(path: String, session: AuthSessionData): AuthSessionData = withContext(Dispatchers.IO) {
        val active = if (session.expiresAtMillis <= System.currentTimeMillis() + 60_000L) {
            val refreshed = JSONObject(request("/auth/refresh", "POST", JSONObject().put("refreshToken", session.refreshToken)))
            val user = refreshed.getJSONObject("user")
            AuthSessionData(
                SessionUser(user.getString("id"), user.getString("email"), user.getString("displayName")),
                refreshed.getString("accessToken"),
                refreshed.getString("refreshToken"),
                System.currentTimeMillis() + refreshed.optLong("expiresIn", 900L) * 1000L
            )
        } else session
        request(path, "DELETE", bearer = active.accessToken)
        active
    }

    suspend fun logout(refreshToken: String) = withContext(Dispatchers.IO) {
        request("/auth/logout", "POST", JSONObject().put("refreshToken", refreshToken))
    }

    suspend fun home(): List<MediaItem> = withContext(Dispatchers.IO) {
        parseMedia(get("/home"))
    }

    suspend fun contents(type: String? = null, genre: String? = null): List<MediaItem> = withContext(Dispatchers.IO) {
        val params = mutableListOf<String>()
        type?.let { params += "type=$it" }
        genre?.let { params += "genre=${java.net.URLEncoder.encode(it, "UTF-8")}" }
        params += "limit=30"
        parseMedia(get("/contents?${params.joinToString("&")}"))
    }

    suspend fun genres(): List<Genre> = withContext(Dispatchers.IO) {
        val root = JSONObject(get("/genres"))
        val array = root.optJSONArray("genres") ?: return@withContext emptyList()
        buildList {
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                val slug = item.optString("slug")
                val name = item.optString("name")
                if (slug.isNotBlank() && name.isNotBlank()) add(Genre(slug, name))
            }
        }
    }

    fun parseAccountItems(raw: String): List<MediaItem> = parseMedia(raw)

    fun parseHistory(raw: String): List<HistoryEntry> {
        val root = JSONObject(raw)
        val array = root.optJSONArray("items") ?: return emptyList()
        return buildList {
            for (i in 0 until array.length()) {
                val entry = array.optJSONObject(i) ?: continue
                val content = entry.optJSONObject("content") ?: continue
                add(HistoryEntry(entry.optString("id"), parseItem(content), entry.optInt("positionSeconds"), entry.optBoolean("completed")))
            }
        }
    }

    suspend fun search(query: String): List<MediaItem> = withContext(Dispatchers.IO) {
        parseMedia(get("/search?q=${java.net.URLEncoder.encode(query, "UTF-8")}"))
    }

    suspend fun detail(slug: String): MediaItem? = withContext(Dispatchers.IO) {
        runCatching { parseItem(JSONObject(get("/contents/${java.net.URLEncoder.encode(slug, "UTF-8")}"))) }.getOrNull()
    }

    private fun parseMedia(raw: String): List<MediaItem> {
        val root = JSONObject(raw)
        val result = mutableListOf<MediaItem>()
        val keys = listOf("newReleases", "trending", "newSeasons", "upcoming", "items", "contents", "results")
        keys.forEach { key ->
            val array = root.optJSONArray(key)
            if (array != null) {
                for (i in 0 until array.length()) {
                    array.optJSONObject(i)?.let { obj ->
                        val item = parseItem(obj)
                        if (result.none { it.id == item.id }) result += item
                    }
                }
            }
        }
        if (result.isEmpty()) {
            val data = root.optJSONObject("data")
            val array = data?.optJSONArray("items") ?: data?.optJSONArray("contents")
            if (array != null) for (i in 0 until array.length()) array.optJSONObject(i)?.let { result += parseItem(it) }
        }
        return result
    }

    private fun parseItem(obj: JSONObject): MediaItem {
        val source = obj.optJSONObject("content") ?: obj.optJSONObject("data") ?: obj
        val id = source.optString("id", source.optString("slug", source.optString("title", "item")))
        val posterObject = source.optJSONObject("primaryPoster") ?: source.optJSONObject("poster")
        val trailerObject = source.optJSONObject("primaryTrailer") ?: source.optJSONObject("trailer")
        val trailerUrl = source.optString("trailerUrl").takeIf { it.startsWith("https://") }
            ?: trailerObject?.optString("url")?.takeIf { it.startsWith("https://") }
        val poster = source.optString("posterUrl").takeIf { it.startsWith("http") }
            ?: source.optString("imageUrl").takeIf { it.startsWith("http") }
            ?: posterObject?.optString("url")?.takeIf { it.startsWith("http") }
        return MediaItem(
            id = id,
            slug = source.optString("slug", id),
            title = source.optString("title", "Sans titre"),
            type = source.optString("type", "Film"),
            year = source.optString("year", ""),
            description = source.optString("description", ""),
            poster = poster,
            trailerUrl = trailerUrl
        )
    }
}

@Composable
private fun MoviesHubApp() {
    var screen by remember { mutableStateOf(Screen.HOME) }
    val backStack = remember { mutableStateListOf<Screen>() }
    val navigate: (Screen) -> Unit = { destination ->
        if (destination != screen) { backStack.add(screen); screen = destination }
    }
    val goBack: () -> Unit = {
        screen = if (backStack.isNotEmpty()) backStack.removeAt(backStack.lastIndex) else Screen.HOME
    }
    val context = LocalContext.current
    var session by remember { mutableStateOf(SecureSessionStore.read(context)) }
    var themeMode by remember {
        mutableStateOf(context.getSharedPreferences("moviehub_preferences", 0).getString("theme", "Sombre") ?: "Sombre")
    }
    LaunchedEffect(themeMode) {
        context.getSharedPreferences("moviehub_preferences", 0).edit().putString("theme", themeMode).apply()
    }
    var splash by remember { mutableStateOf(true) }
    BackHandler(enabled = !splash && screen != Screen.HOME) { goBack() }
    var selected by remember { mutableStateOf<MediaItem?>(null) }
    var detailLoading by remember { mutableStateOf(false) }
    var searchText by remember { mutableStateOf("") }
    var activeFilter by remember { mutableStateOf("Tous") }
    var genres by remember { mutableStateOf<List<Genre>>(emptyList()) }
    var media by remember { mutableStateOf<List<MediaItem>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    var authError by remember { mutableStateOf<String?>(null) }
    var accountItems by remember { mutableStateOf<List<MediaItem>>(emptyList()) }
    var accountLoading by remember { mutableStateOf(false) }
    var accountError by remember { mutableStateOf<String?>(null) }
    var historyIds by remember { mutableStateOf<Map<String, String>>(emptyMap()) }

    LaunchedEffect(Unit) {
        delay(1400)
        splash = false
        loading = true
        runCatching { MoviesHubApi.home() }
            .onSuccess { media = it; error = null }
            .onFailure { error = "Connexion à l’API indisponible"; media = emptyList() }
        runCatching { MoviesHubApi.genres() }
            .onSuccess { genres = it }
        loading = false
    }

    val systemDark = isSystemInDarkTheme()
    val useDark = when (themeMode) { "Clair" -> false; "Système" -> systemDark; else -> true }
    val palette = if (useDark) {
        MoviePalette(Color(0xFF050608), Color(0xFF11151B), Color(0xFFFFC94A), Color(0xFF9AA1AC), Color.White)
    } else {
        MoviePalette(Color(0xFFF4F1E9), Color.White, Color(0xFF9A6500), Color(0xFF68645C), Color(0xFF191919))
    }
    CompositionLocalProvider(LocalMoviePalette provides palette) {
    MaterialTheme(colorScheme = if (useDark) darkColorScheme(
        primary = palette.accent, background = palette.background, surface = palette.panel,
        onPrimary = palette.background, onBackground = palette.text, onSurface = palette.text
    ) else lightColorScheme(
        primary = palette.accent, background = palette.background, surface = palette.panel,
        onPrimary = Color.White, onBackground = palette.text, onSurface = palette.text
    )) {
        if (splash) {
            SplashScreen()
        } else {
            Scaffold(
                containerColor = UiColors.background,
                bottomBar = {
                    if (screen in listOf(Screen.HOME, Screen.CATEGORIES, Screen.DOWNLOADS, Screen.PROFILE)) {
                        BottomNavigationBar(screen) { backStack.clear(); screen = it }
                    }
                }
            ) { padding ->
                Box(Modifier.fillMaxSize().padding(padding)) {
                    when (screen) {
                        Screen.HOME -> HomeScreen(
                            media, loading, error,
                            onFilterChange = { filter ->
                                val type = when (filter) {
                                    "Films" -> "MOVIE"
                                    "Séries" -> "SERIES"
                                    "Animes" -> "ANIME"
                                    else -> null
                                }
                                scope.launch {
                                    loading = true
                                    runCatching { if (type == null) MoviesHubApi.home() else MoviesHubApi.contents(type) }
                                        .onSuccess { media = it; error = null }
                                        .onFailure { error = "Impossible de charger cette catégorie" }
                                    loading = false
                                }
                            },
                            onCategories = { navigate(Screen.CATEGORIES) },
                            onSearch = { navigate(Screen.SEARCH) },
                            onSelect = { selected = it; navigate(Screen.DETAIL); detailLoading = true; scope.launch { MoviesHubApi.detail(it.slug)?.let { fresh -> selected = fresh }; detailLoading = false } }
                        )
                        Screen.CATEGORIES -> CategoriesScreen(
                            activeFilter, genres, media, loading,
                            onFilter = { category ->
                                activeFilter = category.slug
                                scope.launch {
                                    loading = true
                                    runCatching { MoviesHubApi.contents(genre = category.slug) }
                                        .onSuccess { media = it; error = null }
                                        .onFailure { error = "Impossible de charger cette catégorie" }
                                    loading = false
                                }
                            },
                            onClearFilter = {
                                activeFilter = "Tous"
                                scope.launch {
                                    loading = true
                                    runCatching { MoviesHubApi.contents() }
                                        .onSuccess { media = it; error = null }
                                        .onFailure { error = "Impossible de charger le catalogue" }
                                    loading = false
                                }
                            },
                            onBack = { goBack() },
                            onSelect = {
                                selected = it
                                navigate(Screen.DETAIL)
                                detailLoading = true
                                scope.launch {
                                    MoviesHubApi.detail(it.slug)?.let { fresh -> selected = fresh }
                                    detailLoading = false
                                }
                            }
                        )
                        Screen.SEARCH -> SearchScreen(
                            searchText, { searchText = it }, media,
                            onSearch = {
                                if (searchText.trim().length >= 2) {
                                    scope.launch {
                                        loading = true
                                        runCatching { MoviesHubApi.search(searchText.trim()) }
                                            .onSuccess { media = it; error = null }
                                            .onFailure { error = "Recherche indisponible pour le moment" }
                                        loading = false
                                    }
                                }
                            },
                            onSelect = {
                                selected = it
                                navigate(Screen.DETAIL)
                                detailLoading = true
                                scope.launch {
                                    MoviesHubApi.detail(it.slug)?.let { fresh -> selected = fresh }
                                    detailLoading = false
                                }
                            }
                        )
                        Screen.DETAIL -> DetailScreen(selected, detailLoading, onBack = { goBack() }, onPlay = { navigate(Screen.PLAYER) })
                        Screen.PLAYER -> PlayerScreen(selected, onBack = { goBack() })
                        Screen.DOWNLOADS -> DownloadsScreen()
                        Screen.PROFILE -> ProfileScreen(
                            session = session,
                            onLogin = { navigate(Screen.AUTH) },
                            onFavorites = {
                                if (session == null) navigate(Screen.AUTH) else {
                                    navigate(Screen.FAVORITES)
                                    accountLoading = true
                                    scope.launch {
                                        runCatching { MoviesHubApi.authorizedGet("/me/favorites", session!!) }
                                            .onSuccess { (updated, raw) ->
                                                session = updated
                                                SecureSessionStore.save(context, updated)
                                                accountItems = MoviesHubApi.parseAccountItems(raw)
                                                accountError = null
                                            }
                                            .onFailure { accountError = it.message ?: "Favoris indisponibles" }
                                        accountLoading = false
                                    }
                                }
                            },
                            onHistory = {
                                if (session == null) navigate(Screen.AUTH) else {
                                    navigate(Screen.HISTORY)
                                    accountLoading = true
                                    scope.launch {
                                        runCatching { MoviesHubApi.authorizedGet("/me/history", session!!) }
                                            .onSuccess { (updated, raw) ->
                                                session = updated
                                                SecureSessionStore.save(context, updated)
                                                val parsed = MoviesHubApi.parseHistory(raw)
                                                accountItems = parsed.map { it.content }
                                                historyIds = parsed.associate { it.content.id to it.id }
                                                accountError = null
                                            }
                                            .onFailure { accountError = it.message ?: "Historique indisponible" }
                                        accountLoading = false
                                    }
                                }
                            },
                            onLogout = {
                                val current = session
                                scope.launch {
                                    if (current != null) runCatching { MoviesHubApi.logout(current.refreshToken) }
                                    SecureSessionStore.clear(context)
                                    session = null
                                }
                            },
                            onSettings = { navigate(Screen.SETTINGS) }
                        )
                        Screen.FAVORITES -> AccountListScreen(
                            title = "Mes favoris", items = accountItems, loading = accountLoading, error = accountError,
                            onBack = { goBack() }, onSelect = { selected = it; navigate(Screen.DETAIL) },
                            onRemove = { item ->
                                val current = session
                                if (current != null) scope.launch {
                                    runCatching { MoviesHubApi.deleteAuthorized("/me/favorites/${item.id}", current) }
                                        .onSuccess { updated ->
                                            session = updated; SecureSessionStore.save(context, updated)
                                            accountItems = accountItems.filterNot { it.id == item.id }
                                        }
                                        .onFailure { accountError = it.message ?: "Suppression impossible" }
                                }
                            }
                        )
                        Screen.HISTORY -> AccountListScreen(
                            title = "Historique", items = accountItems, loading = accountLoading, error = accountError,
                            onBack = { goBack() }, onSelect = { selected = it; navigate(Screen.DETAIL) },
                            onRemove = { item ->
                                val historyId = historyIds[item.id]
                                val current = session
                                if (historyId != null && current != null) scope.launch {
                                    runCatching { MoviesHubApi.deleteAuthorized("/me/history/$historyId", current) }
                                        .onSuccess { updated ->
                                            session = updated; SecureSessionStore.save(context, updated)
                                            accountItems = accountItems.filterNot { it.id == item.id }
                                        }
                                        .onFailure { accountError = it.message ?: "Suppression impossible" }
                                }
                            }
                        )
                        Screen.AUTH -> AuthScreen(
                            error = authError,
                            onErrorConsumed = { authError = null },
                            onBack = { goBack() },
                            onSubmit = { email, password, displayName, register ->
                                scope.launch {
                                    runCatching { MoviesHubApi.authenticate(email, password, displayName, register) }
                                        .onSuccess {
                                            SecureSessionStore.save(context, it)
                                            session = it
                                            goBack()
                                        }
                                        .onFailure { authError = it.message ?: "Connexion impossible" }
                                }
                            }
                        )
                        Screen.SETTINGS -> SettingsScreen(themeMode = themeMode, onThemeChange = { themeMode = it }, onBack = { goBack() })
                    }
                }
            }
        }
    }
    }
}

@Composable
private fun SplashScreen() {
    Box(Modifier.fillMaxSize().background(
        Brush.verticalGradient(listOf(Color(0xFF08090D), UiColors.background, Color(0xFF090B12)))
    ), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Image(
                painter = painterResource(id = R.drawable.moviehub_logo),
                contentDescription = "Logo MovieHub",
                modifier = Modifier.size(132.dp),
                contentScale = ContentScale.Fit
            )
            Text("Tes films, séries et animés\nau même endroit", color = UiColors.text, fontSize = 14.sp, lineHeight = 21.sp)
            Spacer(Modifier.height(95.dp))
            LinearProgressIndicator(color = UiColors.accent, trackColor = Color(0xFF332B1B), modifier = Modifier.width(170.dp))
            Text("Chargement…", color = UiColors.muted, fontSize = 12.sp)
        }
    }
}

@Composable
private fun BottomNavigationBar(screen: Screen, onNavigate: (Screen) -> Unit) {
    NavigationBar(containerColor = Color(0xFF090B0F), contentColor = UiColors.accent) {
        val entries = listOf(
            Triple(Screen.HOME, "Accueil", Icons.Default.Home),
            Triple(Screen.CATEGORIES, "Catégories", Icons.Default.GridView),
            Triple(Screen.DOWNLOADS, "Téléchargements", Icons.Default.Download),
            Triple(Screen.PROFILE, "Profil", Icons.Default.Person)
        )
        entries.forEach { (destination, label, icon) ->
            NavigationBarItem(
                selected = screen == destination || (destination == Screen.HOME && screen in listOf(Screen.SEARCH, Screen.DETAIL, Screen.PLAYER)),
                onClick = { onNavigate(destination) },
                icon = { Icon(icon, contentDescription = label) },
                label = { Text(label, fontSize = 10.sp) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = UiColors.accent, selectedTextColor = UiColors.accent,
                    unselectedIconColor = UiColors.muted, unselectedTextColor = UiColors.muted,
                    indicatorColor = Color(0xFF30240E)
                )
            )
        }
    }
}

@Composable
private fun Header(title: String = "MoviesHub", onCategories: (() -> Unit)? = null, onSearch: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        if (title == "MoviesHub") {
            Image(painterResource(R.drawable.moviehub_logo), contentDescription = "Logo MovieHub", modifier = Modifier.size(38.dp), contentScale = ContentScale.Fit)
            Spacer(Modifier.width(10.dp))
        }
        Text(title, color = UiColors.accent, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        if (onSearch != null) IconButton(onClick = onSearch) { Icon(Icons.Default.Search, "Recherche", tint = UiColors.text) }
    }
}

@Composable
private fun FilterChips(active: String, onSelect: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("Tous", "Films", "Séries", "Animes").forEach { label ->
            FilterChip(
                selected = active == label, onClick = { onSelect(label) }, label = { Text(label) },
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = UiColors.accent, selectedLabelColor = UiColors.background,
                    containerColor = UiColors.panel, labelColor = UiColors.text
                ),
                border = null
            )
        }
    }
}

@Composable
private fun HomeScreen(
    media: List<MediaItem>, loading: Boolean, error: String?,
    onFilterChange: (String) -> Unit,
    onCategories: () -> Unit, onSearch: () -> Unit, onSelect: (MediaItem) -> Unit
) {
    var filter by remember { mutableStateOf("Tous") }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 20.dp)) {
        item { Header(onSearch = onSearch) }
        item { Text("Films, séries et animés à découvrir", color = UiColors.muted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
        item {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
                Box(Modifier.fillMaxWidth().height(220.dp).clip(RoundedCornerShape(20.dp)).background(
                    Brush.linearGradient(listOf(Color(0xFF292116), Color(0xFF11151B), Color(0xFF3B2A13)))
                )) {
                    media.firstOrNull()?.poster?.let { poster ->
                        AsyncImage(poster, contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop, alpha = 0.42f)
                    }
                    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xEE050608)))))
                    Column(Modifier.align(Alignment.BottomStart).padding(18.dp)) {
                        Text("L’UNIVERS MOVIEHUB", color = UiColors.accent, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp)
                        Text(media.firstOrNull()?.title ?: "Ton prochain film préféré", color = UiColors.text, fontSize = 23.sp, fontWeight = FontWeight.ExtraBold, maxLines = 2)
                        Text("Découvre ton prochain coup de cœur", color = UiColors.text.copy(alpha = .82f), fontSize = 12.sp)
                    }
                }
            }
        }
        item { SectionTitle("Tendances", "Voir tout") }
        if (loading) item { LinearProgressIndicator(color = UiColors.accent, modifier = Modifier.fillMaxWidth().padding(16.dp)) }
        if (error != null && media.isEmpty()) item { EmptyMessage(error) }
        if (!loading && media.isEmpty() && error == null) item { EmptyMessage("Le catalogue apparaîtra ici dès que des contenus seront publiés.") }
        item {
            androidx.compose.foundation.lazy.LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                items(media.take(12)) { item ->
                    Column(Modifier.width(132.dp).clickable { onSelect(item) }) {
                        if (item.poster != null) AsyncImage(item.poster, contentDescription = item.title, modifier = Modifier.fillMaxWidth().height(184.dp).clip(RoundedCornerShape(12.dp)), contentScale = ContentScale.Crop)
                        else Box(Modifier.fillMaxWidth().height(184.dp).clip(RoundedCornerShape(12.dp)).background(UiColors.panel), contentAlignment = Alignment.Center) { Icon(Icons.Default.Movie, null, tint = UiColors.accent, modifier = Modifier.size(38.dp)) }
                        Spacer(Modifier.height(7.dp))
                        Text(item.title, color = UiColors.text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 13.sp)
                        Text(item.type, color = UiColors.muted, fontSize = 11.sp)
                    }
                }
            }
        }
        item { SectionTitle("Animes populaires", "Explorer") }
        item { Text("Les catégories et les contenus publiés seront chargés depuis le catalogue MovieHub.", color = UiColors.muted, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontSize = 12.sp) }
    }
}

@Composable
private fun SectionTitle(title: String, action: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, color = UiColors.text, fontSize = 17.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        Text(action, color = UiColors.accent, fontSize = 12.sp)
    }
}

@Composable
private fun MediaPoster(item: MediaItem, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 5.dp).clip(RoundedCornerShape(12.dp)).background(UiColors.panel).clickable(onClick = onClick).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (item.poster != null) {
            AsyncImage(item.poster, contentDescription = item.title, modifier = Modifier.size(68.dp, 92.dp).clip(RoundedCornerShape(8.dp)), contentScale = ContentScale.Crop)
        } else {
            Box(Modifier.size(68.dp, 92.dp).clip(RoundedCornerShape(8.dp)).background(Color(0xFF242A33)), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.Movie, null, tint = UiColors.accent, modifier = Modifier.size(30.dp))
            }
        }
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            Text(item.title, color = UiColors.text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOf(item.type, item.year).filter { it.isNotBlank() }.joinToString(" • "), color = UiColors.muted, fontSize = 12.sp)
            if (item.description.isNotBlank()) Text(item.description, color = UiColors.muted, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Icon(Icons.Default.ChevronRight, null, tint = UiColors.accent)
    }
}

@Composable
private fun CategoriesScreen(
    active: String,
    genres: List<Genre>,
    media: List<MediaItem>,
    loading: Boolean,
    onFilter: (Genre) -> Unit,
    onClearFilter: () -> Unit,
    onBack: () -> Unit,
    onSelect: (MediaItem) -> Unit
) {
    val activeName = genres.firstOrNull { it.slug == active }?.name ?: active
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Explorer", color = UiColors.text, fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.weight(1f))
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Retour", tint = UiColors.text) }
        }
        if (active == "Tous") {
            Text("Choisis un univers", color = UiColors.muted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp))
            if (genres.isEmpty()) {
                EmptyMessage("Les catégories apparaîtront ici dès qu'elles seront disponibles dans le catalogue.")
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(2),
                    contentPadding = PaddingValues(14.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    items(genres.size) { index ->
                        val category = genres[index]
                        Column(
                            Modifier.fillMaxWidth().height(112.dp).clip(RoundedCornerShape(16.dp))
                                .background(Brush.linearGradient(listOf(Color(0xFF302719), UiColors.panel)))
                                .clickable { onFilter(category) }.padding(14.dp),
                            verticalArrangement = Arrangement.SpaceBetween
                        ) {
                            Icon(
                                when (category.name.lowercase()) {
                                    "action" -> Icons.Default.Bolt
                                    "aventure" -> Icons.Default.Explore
                                    "comédie", "comedie" -> Icons.Default.TheaterComedy
                                    "drame" -> Icons.Default.Theaters
                                    "horreur" -> Icons.Default.DarkMode
                                    "science-fiction", "science fiction" -> Icons.Default.RocketLaunch
                                    "fantastique" -> Icons.Default.AutoAwesome
                                    else -> Icons.Default.Movie
                                }, null, tint = UiColors.accent, modifier = Modifier.size(25.dp)
                            )
                            Text(category.name, color = UiColors.text, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                        }
                    }
                }
            }
        } else {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(activeName, color = UiColors.text, fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.weight(1f))
                TextButton(onClick = onClearFilter) { Text("Toutes", color = UiColors.accent) }
            }
            if (loading) LinearProgressIndicator(color = UiColors.accent, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp))
            if (!loading && media.isEmpty()) EmptyMessage("Aucun résultat pour cette catégorie pour le moment.")
            LazyColumn(contentPadding = PaddingValues(bottom = 20.dp)) {
                items(media) { item -> MediaPoster(item) { onSelect(item) } }
            }
        }
    }
}

@Composable
private fun SearchScreen(query: String, onQuery: (String) -> Unit, media: List<MediaItem>, onSearch: () -> Unit, onSelect: (MediaItem) -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Header("Recherche")
        OutlinedTextField(
            value = query, onValueChange = onQuery, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            placeholder = { Text("Film, série, anime…", color = UiColors.muted) }, singleLine = true,
            trailingIcon = { IconButton(onClick = onSearch) { Icon(Icons.Default.Search, null, tint = UiColors.accent) } },
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = UiColors.accent, unfocusedBorderColor = Color(0xFF343A44),
                focusedTextColor = UiColors.text, unfocusedTextColor = UiColors.text
            )
        )
        Text("Suggestions", color = UiColors.accent, modifier = Modifier.padding(16.dp), fontWeight = FontWeight.Bold)
        LazyColumn { items(media.take(8)) { MediaPoster(it) { onSelect(it) } } }
    }
}

@Composable
private fun DetailScreen(item: MediaItem?, loading: Boolean, onBack: () -> Unit, onPlay: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, null, tint = UiColors.text) }
            Text(item?.title ?: "Détails", color = UiColors.text, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        }
        if (item?.poster != null) AsyncImage(item.poster, null, modifier = Modifier.fillMaxWidth().height(250.dp), contentScale = ContentScale.Crop)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(18.dp)) {
            Text(item?.title ?: "Contenu", color = UiColors.text, fontSize = 25.sp, fontWeight = FontWeight.Bold)
            Text(listOf(item?.type ?: "Film", item?.year ?: "").filter { it.isNotBlank() }.joinToString(" • "), color = UiColors.accent)
            Spacer(Modifier.height(12.dp))
            if (loading) LinearProgressIndicator(color = UiColors.accent, modifier = Modifier.fillMaxWidth())
            Text(item?.description?.ifBlank { "La description sera affichée à partir des métadonnées du catalogue." } ?: "Les informations du contenu seront chargées depuis MovieHub.", color = UiColors.muted)
            Spacer(Modifier.height(22.dp))
            Button(onClick = onPlay, enabled = !item?.trailerUrl.isNullOrBlank(), modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = UiColors.accent, contentColor = UiColors.background, disabledContainerColor = Color(0xFF343434), disabledContentColor = UiColors.muted)) {
                Icon(Icons.Default.PlayArrow, null); Spacer(Modifier.width(6.dp)); Text(if (item?.trailerUrl.isNullOrBlank()) "Bande-annonce indisponible" else "Voir la bande-annonce")
            }
            OutlinedButton(onClick = {}, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.outlinedButtonColors(contentColor = UiColors.accent)) {
                Icon(Icons.Default.Download, null); Spacer(Modifier.width(6.dp)); Text("Télécharger — connexion requise")
            }
        }
    }
}

@Composable
private fun PlayerScreen(item: MediaItem?, onBack: () -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val videoUrl = item?.trailerUrl

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.Center) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, null, tint = UiColors.text) }
            Text(item?.title ?: "Lecteur vidéo", color = UiColors.text, fontWeight = FontWeight.Bold)
        }
        if (videoUrl.isNullOrBlank()) {
            Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(12.dp)).background(Color(0xFF171D26)), contentAlignment = Alignment.Center) {
                Text("Aucune bande-annonce publiée pour ce contenu.", color = UiColors.muted)
            }
        } else {
            val player = remember(videoUrl) {
                ExoPlayer.Builder(context).build().apply {
                    setMediaItem(PlayerMediaItem.fromUri(videoUrl))
                    prepare()
                    playWhenReady = true
                }
            }
            DisposableEffect(player, lifecycleOwner) {
                val observer = LifecycleEventObserver { _, event ->
                    when (event) {
                        Lifecycle.Event.ON_PAUSE -> player.pause()
                        Lifecycle.Event.ON_RESUME -> if (player.playbackState != androidx.media3.common.Player.STATE_ENDED) player.play()
                        else -> Unit
                    }
                }
                lifecycleOwner.lifecycle.addObserver(observer)
                onDispose {
                    lifecycleOwner.lifecycle.removeObserver(observer)
                    player.release()
                }
            }
            AndroidView(
                factory = { viewContext ->
                    PlayerView(viewContext).apply {
                        this.player = player
                        useController = true
                    }
                },
                update = { it.player = player },
                modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(12.dp))
            )
        }
        Text("Lecteur Media3 • Bande-annonce", color = UiColors.accent, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 16.dp))
        Text("Les films complets nécessitent une session connectée et un lien temporaire autorisé par l'API.", color = UiColors.muted, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
    }
}

@Composable
private fun DownloadsScreen() {
    var transferMode by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Header("Téléchargements")
        Text("Ta bibliothèque hors connexion", color = UiColors.muted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 2.dp, vertical = 6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            listOf("Partager", "Recevoir").forEach { action ->
                OutlinedButton(onClick = { transferMode = action }, modifier = Modifier.weight(1f), colors = ButtonDefaults.outlinedButtonColors(contentColor = UiColors.accent)) {
                    Icon(if (action == "Partager") Icons.Default.Share else Icons.Default.Download, null)
                    Spacer(Modifier.width(6.dp)); Text(action)
                }
            }
        }
        Spacer(Modifier.height(28.dp))
        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Default.DownloadForOffline, null, tint = UiColors.accent, modifier = Modifier.size(62.dp))
                Spacer(Modifier.height(14.dp))
                Text("Aucun téléchargement", color = UiColors.text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Text("Les vidéos enregistrées apparaîtront ici.", color = UiColors.muted, fontSize = 13.sp)
                Text("Elles resteront dans l’espace privé de MovieHub et ne seront pas visibles dans la galerie publique.", color = UiColors.muted, fontSize = 11.sp, modifier = Modifier.padding(top = 8.dp))
            }
        }
        if (transferMode != null) {
            Card(colors = CardDefaults.cardColors(containerColor = UiColors.panel), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text(if (transferMode == "Partager") "Envoyer un téléchargement" else "Recevoir un fichier", color = UiColors.text, fontWeight = FontWeight.Bold)
                    Text("Le transfert local sécurisé sera lancé depuis cette section. L’interface est prête, le moteur de transfert reste à connecter.", color = UiColors.muted, fontSize = 12.sp)
                    TextButton(onClick = { transferMode = null }) { Text("Fermer", color = UiColors.accent) }
                }
            }
        }
    }
}

@Composable
private fun ShareScreen() {
    var mode by remember { mutableStateOf("Envoyer") }
    Column(Modifier.fillMaxSize().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Header("Partage")
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            listOf("Envoyer", "Recevoir").forEach { option ->
                FilterChip(selected = mode == option, onClick = { mode = option }, label = { Text(option) },
                    colors = FilterChipDefaults.filterChipColors(selectedContainerColor = UiColors.accent, selectedLabelColor = UiColors.background, labelColor = UiColors.text),
                    border = null)
            }
        }
        Spacer(Modifier.height(35.dp))
        Icon(Icons.Default.Devices, null, tint = UiColors.accent, modifier = Modifier.size(72.dp))
        Spacer(Modifier.height(18.dp))
        Text(if (mode == "Envoyer") "Partager tes fichiers" else "Recevoir des fichiers", color = UiColors.text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text("Transfert local entre appareils, sans passer par le stockage cloud.", color = UiColors.muted, fontSize = 13.sp)
        Spacer(Modifier.height(24.dp))
        Button(onClick = {}, colors = ButtonDefaults.buttonColors(containerColor = UiColors.accent, contentColor = UiColors.background)) {
            Text(if (mode == "Envoyer") "Choisir un fichier" else "Rechercher un appareil")
        }
        Text("Le transfert Wi-Fi direct et l’appairage QR seront implémentés dans une étape dédiée.", color = UiColors.muted, fontSize = 11.sp, modifier = Modifier.padding(top = 22.dp))
    }
}

@Composable
private fun ProfileScreen(session: AuthSessionData?, onLogin: () -> Unit, onFavorites: () -> Unit, onHistory: () -> Unit, onLogout: () -> Unit, onSettings: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Header("Profil")
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Default.AccountCircle, null, tint = UiColors.accent, modifier = Modifier.size(76.dp))
                Text(session?.user?.displayName ?: "Bienvenue sur MovieHub", color = UiColors.text, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                Text(session?.user?.email ?: "Connecte-toi pour synchroniser tes favoris et ton historique.", color = UiColors.muted, fontSize = 12.sp)
                if (session == null) {
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = onLogin, colors = ButtonDefaults.buttonColors(containerColor = UiColors.accent, contentColor = UiColors.background)) {
                        Text("Se connecter / Créer un compte")
                    }
                } else {
                    Spacer(Modifier.height(8.dp))
                    Text("Compte connecté", color = UiColors.accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        Spacer(Modifier.height(24.dp))
        Card(colors = CardDefaults.cardColors(containerColor = UiColors.panel), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("Sécurité du compte", color = UiColors.text, fontWeight = FontWeight.SemiBold)
                Text(if (session == null) "Aucune session active" else "Session active • jetons protégés sur cet appareil", color = UiColors.muted, fontSize = 12.sp)
                Text("Les identifiants de session sont stockés de manière chiffrée et ne sont jamais affichés.", color = UiColors.muted, fontSize = 11.sp)
            }
        }
        if (session != null) {
            Spacer(Modifier.height(12.dp))
            OutlinedButton(onClick = onLogout, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.outlinedButtonColors(contentColor = UiColors.accent)) {
                Icon(Icons.Default.Logout, null); Spacer(Modifier.width(8.dp)); Text("Se déconnecter")
            }
        }
        Spacer(Modifier.height(12.dp))
        listOf("Mes favoris" to onFavorites, "Historique de visionnage" to onHistory).forEach { (label, action) ->
            Row(Modifier.fillMaxWidth().clickable(onClick = action).padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label, color = UiColors.text, modifier = Modifier.weight(1f))
                Icon(Icons.Default.ChevronRight, null, tint = UiColors.accent)
            }
            HorizontalDivider(color = Color(0xFF242932))
        }
        Row(Modifier.fillMaxWidth().clickable(onClick = onSettings).padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Settings, null, tint = UiColors.accent); Spacer(Modifier.width(12.dp))
            Text("Paramètres", color = UiColors.text, modifier = Modifier.weight(1f))
            Icon(Icons.Default.ChevronRight, null, tint = UiColors.accent)
        }
        HorizontalDivider(color = Color(0xFF242932))
        listOf("Aide & support", "À propos").forEach { label ->
            Row(Modifier.fillMaxWidth().clickable {}.padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label, color = UiColors.text, modifier = Modifier.weight(1f))
                Icon(Icons.Default.ChevronRight, null, tint = UiColors.accent)
            }
            HorizontalDivider(color = Color(0xFF242932))
        }
    }
}

@Composable
private fun AccountListScreen(
    title: String,
    items: List<MediaItem>,
    loading: Boolean,
    error: String?,
    onBack: () -> Unit,
    onSelect: (MediaItem) -> Unit,
    onRemove: (MediaItem) -> Unit
) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Retour", tint = UiColors.text) }
            Text(title, color = UiColors.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        }
        if (loading) LinearProgressIndicator(color = UiColors.accent, modifier = Modifier.fillMaxWidth())
        if (error != null) Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
        if (!loading && items.isEmpty()) EmptyMessage("Aucun contenu pour le moment.")
        LazyColumn(contentPadding = PaddingValues(bottom = 20.dp)) {
            items(items, key = { it.id }) { item ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) { MediaPoster(item) { onSelect(item) } }
                    IconButton(onClick = { onRemove(item) }) {
                        Icon(Icons.Default.DeleteOutline, "Retirer", tint = UiColors.accent)
                    }
                }
            }
        }
    }
}

@Composable
private fun AuthScreen(
    error: String?,
    onErrorConsumed: () -> Unit,
    onBack: () -> Unit,
    onSubmit: (String, String, String, Boolean) -> Unit
) {
    var register by remember { mutableStateOf(false) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var displayName by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    LaunchedEffect(error) { if (error != null) submitting = false }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
        IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Retour", tint = UiColors.text) }
        Spacer(Modifier.height(18.dp))
        Text(if (register) "Créer un compte" else "Bienvenue", color = UiColors.text, fontSize = 28.sp, fontWeight = FontWeight.ExtraBold)
        Text(if (register) "Rejoins MovieHub pour retrouver tes contenus." else "Connecte-toi pour synchroniser ton profil.", color = UiColors.muted, fontSize = 13.sp)
        Spacer(Modifier.height(24.dp))
        if (register) {
            OutlinedTextField(value = displayName, onValueChange = { displayName = it }, label = { Text("Nom affiché") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(10.dp))
        }
        OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text("Adresse e-mail") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("Mot de passe") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth())
        if (register) Text("8 caractères minimum.", color = UiColors.muted, fontSize = 11.sp, modifier = Modifier.padding(top = 5.dp))
        if (error != null) Text(error, color = MaterialTheme.colorScheme.error, fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp))
        Spacer(Modifier.height(18.dp))
        Button(
            onClick = {
                onErrorConsumed()
                submitting = true
                onSubmit(email, password, displayName, register)
            },
            enabled = !submitting && email.contains("@") && password.isNotBlank() && (!register || displayName.trim().length >= 2 && password.length >= 8),
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = UiColors.accent, contentColor = UiColors.background)
        ) {
            if (submitting) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            else Text(if (register) "Créer mon compte" else "Se connecter")
        }
        TextButton(onClick = { register = !register; onErrorConsumed() }, modifier = Modifier.fillMaxWidth()) {
            Text(if (register) "J’ai déjà un compte" else "Créer un compte", color = UiColors.accent)
        }
    }
}

@Composable
private fun EmptyMessage(message: String) {
    Text(message, color = UiColors.muted, fontSize = 13.sp, modifier = Modifier.fillMaxWidth().padding(22.dp))
}

@Composable
private fun SettingsScreen(themeMode: String, onThemeChange: (String) -> Unit, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, null, tint = UiColors.text) }
            Text("Paramètres", color = UiColors.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(20.dp))
        Text("APPARENCE", color = UiColors.accent, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.4.sp)
        Spacer(Modifier.height(8.dp))
        Text("Thème de l’application", color = UiColors.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        Text("Choisis l’apparence de MovieHub.", color = UiColors.muted, fontSize = 12.sp)
        Spacer(Modifier.height(12.dp))
        listOf("Sombre", "Clair", "Système").forEach { option ->
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                    .background(if (themeMode == option) Color(0xFF282113) else UiColors.panel)
                    .clickable { onThemeChange(option) }.padding(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    when (option) {
                        "Sombre" -> Icons.Default.DarkMode
                        "Clair" -> Icons.Default.LightMode
                        else -> Icons.Default.SettingsSuggest
                    }, null, tint = UiColors.accent
                )
                Spacer(Modifier.width(12.dp))
                Text(option, color = UiColors.text, modifier = Modifier.weight(1f))
                RadioButton(selected = themeMode == option, onClick = { onThemeChange(option) }, colors = RadioButtonDefaults.colors(selectedColor = UiColors.accent))
            }
            Spacer(Modifier.height(8.dp))
        }
        Spacer(Modifier.height(18.dp))
        Text("Les préférences sont enregistrées sur cet appareil.", color = UiColors.muted, fontSize = 11.sp)
    }
}
