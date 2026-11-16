package com.movieshub.app

import android.os.Bundle
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
    MoviePalette(Color(0xFF050608), Color(0xFF11151B), Color(0xFFFFC94A), Color(0xFF9AA1AC), UiColors.text)
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

private enum class Screen { HOME, CATEGORIES, SEARCH, DETAIL, PLAYER, DOWNLOADS, PROFILE, SETTINGS }

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
    private fun get(path: String): String {
        val base = BuildConfig.API_BASE_URL.trimEnd('/')
        val connection = (URL(base + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 7000
            readTimeout = 7000
            setRequestProperty("Accept", "application/json")
        }
        return try {
            if (connection.responseCode !in 200..299) error("API HTTP ${connection.responseCode}")
            connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    suspend fun home(): List<MediaItem> = withContext(Dispatchers.IO) {
        parseMedia(get("/home"))
    }

    suspend fun contents(type: String? = null): List<MediaItem> = withContext(Dispatchers.IO) {
        val query = type?.let { "?type=$it&limit=30" } ?: "?limit=30"
        parseMedia(get("/contents$query"))
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
    var media by remember { mutableStateOf<List<MediaItem>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        delay(1400)
        splash = false
        loading = true
        runCatching { MoviesHubApi.home() }
            .onSuccess { media = it; error = null }
            .onFailure { error = "Connexion à l’API indisponible"; media = emptyList() }
        loading = false
    }

    val systemDark = isSystemInDarkTheme()
    val useDark = when (themeMode) { "Clair" -> false; "Système" -> systemDark; else -> true }
    val palette = if (useDark) {
        MoviePalette(Color(0xFF050608), Color(0xFF11151B), Color(0xFFFFC94A), Color(0xFF9AA1AC), UiColors.text)
    } else {
        MoviePalette(Color(0xFFF4F1E9), UiColors.text, Color(0xFF9A6500), Color(0xFF68645C), Color(0xFF191919))
    }
    CompositionLocalProvider(LocalMoviePalette provides palette) {
    MaterialTheme(colorScheme = if (useDark) darkColorScheme(
        primary = palette.accent, background = palette.background, surface = palette.panel,
        onPrimary = palette.background, onBackground = palette.text, onSurface = palette.text
    ) else lightColorScheme(
        primary = palette.accent, background = palette.background, surface = palette.panel,
        onPrimary = UiColors.text, onBackground = palette.text, onSurface = palette.text
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
                            activeFilter, onFilter = { activeFilter = it },
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
                        Screen.PROFILE -> ProfileScreen(onSettings = { navigate(Screen.SETTINGS) })
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
            Triple(Screen.CATEGORIES, "Catégories", Icons.Default.Category),
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
private fun CategoriesScreen(active: String, onFilter: (String) -> Unit, onBack: () -> Unit, onSelect: (MediaItem) -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Header("Catégories", onCategories = onBack)
        FilterChips(active, onFilter)
        val categories = listOf("Action", "Aventure", "Comédie", "Drame", "Horreur", "Science-fiction", "Fantastique", "Animation")
        LazyColumn(contentPadding = PaddingValues(14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            items(categories) { category ->
                Row(Modifier.fillMaxWidth().height(62.dp).clip(RoundedCornerShape(12.dp)).background(
                    Brush.horizontalGradient(listOf(Color(0xFF202B38), Color(0xFF17191E)))
                ).clickable { onFilter(category) }.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(category, color = UiColors.text, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    Icon(Icons.Default.ChevronRight, null, tint = UiColors.accent)
                }
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
private fun ProfileScreen(onSettings: () -> Unit) {
    var showToken by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Header("Profil")
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Default.AccountCircle, null, tint = UiColors.accent, modifier = Modifier.size(76.dp))
                Text("Utilisateur", color = UiColors.text, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                Text("Connecte-toi pour synchroniser tes favoris et ton historique.", color = UiColors.muted, fontSize = 12.sp)
            }
        }
        Spacer(Modifier.height(24.dp))
        Card(colors = CardDefaults.cardColors(containerColor = UiColors.panel), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Jeton de session", color = UiColors.text, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    IconButton(onClick = { showToken = !showToken }) { Icon(if (showToken) Icons.Default.VisibilityOff else Icons.Default.Visibility, "Afficher ou masquer le jeton", tint = UiColors.accent) }
                }
                Text(if (showToken) "Aucun jeton de session enregistré" else "••••••••••••••••", color = UiColors.muted, fontSize = 13.sp)
                Text("Le jeton réel apparaîtra ici après la connexion sécurisée au compte.", color = UiColors.muted, fontSize = 11.sp)
            }
        }
        Spacer(Modifier.height(12.dp))
        listOf("Mes favoris", "Historique de visionnage").forEach { label ->
            Row(Modifier.fillMaxWidth().clickable {}.padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
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
