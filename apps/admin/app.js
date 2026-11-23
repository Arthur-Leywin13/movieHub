(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { api: "", session: null, page: 1, total: 0, catalogItems: [], currentContent: null, uploadBusy: false };
  const STATUS_LABELS = {
    DRAFT: "Brouillon", IN_PREPARATION: "En préparation", SCHEDULED: "Programmé",
    PUBLISHED: "Publié", UNPUBLISHED: "Dépublié", WITHDRAWN: "Retiré", ARCHIVED: "Archivé"
  };
  const TYPE_LABELS = { MOVIE: "Film", SERIES: "Série", ANIME: "Animé" };
  const TRANSITIONS = {
    DRAFT: ["IN_PREPARATION", "PUBLISHED", "ARCHIVED"],
    IN_PREPARATION: ["DRAFT", "PUBLISHED", "ARCHIVED"],
    SCHEDULED: ["DRAFT", "IN_PREPARATION", "PUBLISHED", "ARCHIVED"],
    PUBLISHED: ["UNPUBLISHED", "ARCHIVED"],
    UNPUBLISHED: ["IN_PREPARATION", "PUBLISHED", "ARCHIVED"],
    ARCHIVED: ["DRAFT"],
    WITHDRAWN: []
  };

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const splitValues = (value) => value.split(",").map((part) => part.trim()).filter(Boolean);
  const formatDate = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  };
  const dateInputToIso = (value) => value ? new Date(value).toISOString() : "";
  const toast = (message, error = false) => {
    const node = document.createElement("div");
    node.className = "toast" + (error ? " error" : "");
    node.textContent = message;
    $("#toastRegion").append(node);
    window.setTimeout(() => node.remove(), 4800);
  };
  const showNotice = (message, error = false) => {
    const node = $("#globalNotice");
    node.textContent = message;
    node.className = "notice " + (error ? "error" : "subtle");
    node.classList.remove("hidden");
  };
  const hideNotice = () => $("#globalNotice").classList.add("hidden");
  const sessionSave = () => {
    if (state.session) sessionStorage.setItem("moviehub-admin-session", JSON.stringify(state.session));
    else sessionStorage.removeItem("moviehub-admin-session");
  };
  const responseMessage = (payload, fallback) =>
    payload?.error?.message || payload?.message || fallback || "Une erreur est survenue.";

  async function rawRequest(path, options = {}, token = true) {
    const headers = new Headers(options.headers || {});
    if (token && state.session?.accessToken) headers.set("Authorization", "Bearer " + state.session.accessToken);
    if (options.body && !(options.body instanceof FormData) && typeof options.body !== "string") {
      headers.set("Content-Type", "application/json");
      options = { ...options, body: JSON.stringify(options.body) };
    }
    const response = await fetch(state.api.replace(/\/$/, "") + path, { ...options, headers });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { message: text }; }
    }
    return { response, payload };
  }

  async function refreshSession() {
    if (!state.session?.refreshToken) return false;
    const { response, payload } = await rawRequest("/auth/refresh", {
      method: "POST", body: { refreshToken: state.session.refreshToken }
    }, false);
    if (!response.ok || !payload?.accessToken || !payload?.refreshToken) {
      state.session = null; sessionSave(); return false;
    }
    state.session = { ...state.session, accessToken: payload.accessToken, refreshToken: payload.refreshToken, expiresAt: Date.now() + (payload.expiresIn || 900) * 1000 };
    sessionSave();
    return true;
  }

  async function api(path, options = {}, retry = true) {
    let result = await rawRequest(path, options, true);
    if (result.response.status === 401 && retry && await refreshSession()) {
      result = await rawRequest(path, options, true);
    }
    if (!result.response.ok) {
      if (result.response.status === 401) {
        state.session = null; sessionSave(); showLogin();
      }
      throw new Error(responseMessage(result.payload, "Erreur API HTTP " + result.response.status));
    }
    return result.payload;
  }

  function showLogin(message = "") {
    $("#appView").classList.add("hidden");
    $("#loginView").classList.remove("hidden");
    $("#loginError").textContent = message;
    $("#loginError").classList.toggle("hidden", !message);
  }
  function showApp() {
    $("#loginView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    $("#adminName").textContent = state.session?.user?.displayName || "Administrateur";
    $("#adminEmail").textContent = state.session?.user?.email || "";
    $("#welcomeName").textContent = state.session?.user?.displayName || "administrateur";
  }

  async function login(event) {
    event.preventDefault();
    const button = $("#loginForm button[type=submit]");
    button.disabled = true; button.textContent = "Connexion…";
    state.api = $("#apiUrl").value.trim().replace(/\/$/, "");
    if (!/^https?:\/\//i.test(state.api)) {
      showLogin("Adresse de l’API invalide. Exemple : https://api.ton-domaine.com");
      button.disabled = false; button.textContent = "Se connecter →"; return;
    }
    try {
      const { response, payload } = await rawRequest("/auth/login", {
        method: "POST",
        body: {
          email: $("#loginEmail").value.trim(),
          password: $("#loginPassword").value,
          deviceName: "Movie X Admin Web",
          platform: "WEB"
        }
      }, false);
      if (!response.ok) throw new Error(responseMessage(payload, "Connexion impossible."));
      state.session = {
        user: payload.user,
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        expiresAt: Date.now() + (payload.expiresIn || 900) * 1000
      };
      sessionSave();
      // Le rôle administrateur est vérifié côté serveur, pas à partir d'un rôle fourni par le navigateur.
      await api("/admin/contents?page=1&limit=1");
      sessionStorage.setItem("moviehub-admin-api", state.api);
      showApp();
      await navigate("overview");
      $("#loginPassword").value = "";
    } catch (error) {
      state.session = null; sessionSave();
      showLogin(error.message + (error.message.includes("Droits") || error.message.includes("administrateur") ? "" : " Vérifie aussi que ton compte possède un rôle administrateur."));
    } finally {
      button.disabled = false; button.innerHTML = 'Se connecter <span>→</span>';
    }
  }

  function logout() {
    const refreshToken = state.session?.refreshToken;
    if (refreshToken) rawRequest("/auth/logout", { method: "POST", body: { refreshToken } }, false).catch(() => {});
    state.session = null; sessionSave(); showLogin();
  }

  async function loadCatalog(page = 1) {
    const q = $("#catalogSearch").value.trim();
    const type = $("#catalogType").value;
    const status = $("#catalogStatus").value;
    const params = new URLSearchParams({ page: String(page), limit: "20" });
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    if (status) params.set("status", status);
    $("#catalogRows").innerHTML = '<tr><td colspan="5" class="empty-cell">Chargement…</td></tr>';
    const data = await api("/admin/contents?" + params.toString());
    state.page = data.page || page;
    state.total = Number(data.total || 0);
    state.catalogItems = data.items || data.contents || [];
    renderCatalog();
  }

  function renderCatalog() {
    const items = state.catalogItems;
    $("#catalogCount").textContent = state.total + " résultat(s)";
    $("#pageInfo").textContent = "Page " + state.page;
    $("#prevPage").disabled = state.page <= 1;
    $("#nextPage").disabled = items.length < 20 || state.page * 20 >= state.total;
    if (!items.length) {
      $("#catalogRows").innerHTML = '<tr><td colspan="5" class="empty-cell">Aucun contenu trouvé.</td></tr>';
      return;
    }
    $("#catalogRows").innerHTML = items.map((item) => `
      <tr>
        <td><span class="content-name">${escapeHtml(item.title)}</span><span class="content-sub">${escapeHtml(item.slug || item.id)}</span></td>
        <td><span class="type-tag">${escapeHtml(TYPE_LABELS[item.type] || item.type)}</span></td>
        <td>${escapeHtml(item.year || "—")}</td>
        <td><span class="status-tag ${String(item.status || "").toLowerCase()}">${escapeHtml(STATUS_LABELS[item.status] || item.status)}</span></td>
        <td><button class="row-action" data-open-content="${escapeHtml(item.id)}">Gérer →</button></td>
      </tr>`).join("");
  }

  async function loadOverview() {
    const data = await api("/admin/contents?page=1&limit=50");
    const items = data.items || data.contents || [];
    $("#statTotal").textContent = data.total ?? items.length;
    $("#statPublished").textContent = items.filter((x) => x.status === "PUBLISHED").length;
    $("#statDraft").textContent = items.filter((x) => ["DRAFT", "IN_PREPARATION"].includes(x.status)).length;
    $("#recentContent").innerHTML = items.slice(0, 6).map((item) => `
      <div class="recent-row"><div class="recent-poster">✦</div><div class="recent-info"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(TYPE_LABELS[item.type] || item.type)} · ${escapeHtml(STATUS_LABELS[item.status] || item.status)}</small></div><button class="row-action" data-open-content="${escapeHtml(item.id)}">Ouvrir</button></div>`).join("") || '<div class="empty-state">Le catalogue est encore vide.</div>';
    try {
      const schedule = await api("/admin/scheduled-publications?page=1&limit=100");
      const jobs = schedule.items || schedule.scheduledPublications || [];
      $("#statScheduled").textContent = jobs.filter((job) => job.status === "PENDING").length;
    } catch { $("#statScheduled").textContent = "—"; }
  }

  function statusActions(item) {
    const transitions = TRANSITIONS[item.status] || [];
    if (!transitions.length) return '<span class="muted">Aucune transition directe disponible.</span>';
    return transitions.map((status) => `<button class="btn secondary" data-set-status="${status}" data-status-id="${escapeHtml(item.id)}">${escapeHtml(STATUS_LABELS[status])}</button>`).join("");
  }

  async function openContent(id) {
    const data = await api("/admin/contents/" + encodeURIComponent(id));
    state.currentContent = data;
    const content = data.content;
    $("#detailTitle").textContent = content.title || "Détails du contenu";
    const seasons = (data.seasons || []).map((entry) => {
      const season = entry.season;
      const episodes = entry.episodes || [];
      return `<div class="detail-section"><div class="panel-heading"><div><p class="eyebrow">SAISON ${escapeHtml(season.number)}</p><h3>${escapeHtml(season.title || "Saison " + season.number)}</h3></div><div><span class="status-tag ${String(season.status).toLowerCase()}">${escapeHtml(STATUS_LABELS[season.status] || season.status)}</span><div class="detail-actions">${(TRANSITIONS[season.status] || []).map((status) => `<button class="row-action" data-set-season-status="${status}" data-season-id="${escapeHtml(season.id)}">${escapeHtml(STATUS_LABELS[status] || status)}</button>`).join("")}</div></div></div>
        <div class="simple-list">${episodes.map((entry) => `<div class="episode-card"><div class="simple-row"><div><strong>${escapeHtml(entry.episode.title || "Épisode " + entry.episode.number)}</strong><small>${escapeHtml(STATUS_LABELS[entry.episode.status] || entry.episode.status)} · ${(entry.versions || []).length} version(s) · ${escapeHtml(entry.episode.id)}</small><div class="detail-actions">${(TRANSITIONS[entry.episode.status] || []).map((status) => `<button class="row-action" data-set-episode-status="${status}" data-episode-id="${escapeHtml(entry.episode.id)}">${escapeHtml(STATUS_LABELS[status] || status)}</button>`).join("")}</div></div><span class="muted">#${escapeHtml(entry.episode.number)}</span></div><div class="simple-list">${(entry.versions || []).map(renderVersion).join("")}</div><form class="detail-form episode-version-form" data-episode-id="${escapeHtml(entry.episode.id)}"><div class="form-grid"><label class="span-two">ID du fichier vidéo<input name="mediaFileId" required placeholder="ID du média envoyé"></label><label>Libellé<input name="label" placeholder="720p"></label><label>Hauteur<input name="height" type="number" min="1" max="20000"></label><label>Largeur<input name="width" type="number" min="1" max="20000"></label><label>Durée (secondes)<input name="durationSeconds" type="number" min="1" max="86400"></label><label class="span-two">Langues audio<input name="audioLanguages" required placeholder="fr, en"></label></div><button class="btn secondary" type="submit">＋ Ajouter une version à cet épisode</button></form></div>`).join("") || '<div class="empty-state">Aucun épisode dans cette saison.</div>'}</div>
        <form class="detail-form episode-form" data-season-id="${escapeHtml(season.id)}"><div class="form-grid"><label>Numéro d’épisode<input name="number" type="number" min="1" max="9999" required></label><label>Titre<input name="title" maxlength="200" placeholder="Titre de l’épisode"></label><label class="span-two">Description<textarea name="description" rows="2"></textarea></label><label class="span-two">Note de sortie<input name="releaseNote" maxlength="2000"></label></div><button class="btn secondary" type="submit">＋ Ajouter un épisode</button></form>
      </div>`;
    }).join("");
    const renderVersion = (v) => `<div class="simple-row"><div><strong>${escapeHtml(v.label || (v.height ? v.height + "p" : "Version vidéo"))}</strong><small>${escapeHtml((v.audioTracks || []).map((x) => x.languageCode).join(", ") || "Pistes audio non précisées")} · ${escapeHtml(STATUS_LABELS[v.status] || v.status)} · ${escapeHtml(v.id)}</small><div class="detail-actions">${(TRANSITIONS[v.status] || []).map((status) => `<button class="row-action" data-set-version-status="${status}" data-version-id="${escapeHtml(v.id)}">${escapeHtml(STATUS_LABELS[status] || status)}</button>`).join("")}</div></div></div>`;
    const versions = (data.versions || []).map(renderVersion).join("");
    const posters = (data.posters || []).map((p) => `<div class="simple-row"><div><strong>${escapeHtml(p.kind || "Affiche")} ${content.primaryPosterId === p.id ? "· Principale" : ""}</strong><small>${escapeHtml(p.id)} · ${p.archivedAt ? "Archivée" : "Active"}</small><div class="detail-actions">${p.archivedAt ? `<button class="row-action" data-restore-poster="${escapeHtml(p.id)}">Restaurer</button>` : `${content.primaryPosterId !== p.id ? `<button class="row-action" data-primary-poster="${escapeHtml(p.id)}">Définir principale</button>` : ""}<button class="row-action" data-archive-poster="${escapeHtml(p.id)}">Archiver</button>`}</div></div></div>`).join("");
    const trailers = (data.trailers || []).map((t) => `<div class="simple-row"><div><strong>${escapeHtml(t.title || "Bande-annonce")} ${content.primaryTrailerId === t.id ? "· Principale" : ""}</strong><small>${escapeHtml(t.id)} · ${t.externalUrl ? "Lien externe" : "Fichier média"} · ${t.archivedAt ? "Archivée" : "Active"}</small><div class="detail-actions">${t.archivedAt ? `<button class="row-action" data-restore-trailer="${escapeHtml(t.id)}">Restaurer</button>` : `${content.primaryTrailerId !== t.id ? `<button class="row-action" data-primary-trailer="${escapeHtml(t.id)}">Définir principale</button>` : ""}<button class="row-action" data-archive-trailer="${escapeHtml(t.id)}">Archiver</button>`}</div></div></div>`).join("");
    $("#detailBody").innerHTML = `
      <div class="detail-summary"><div><h3>${escapeHtml(content.title)}</h3><small class="muted">${escapeHtml(TYPE_LABELS[content.type] || content.type)} · ${escapeHtml(content.year || "Année inconnue")} · ${escapeHtml(content.slug || "")}</small></div><span class="status-tag ${String(content.status).toLowerCase()}">${escapeHtml(STATUS_LABELS[content.status] || content.status)}</span></div>
      <div class="detail-section"><h3>Informations de la fiche</h3><div class="detail-fields"><div class="detail-field">Année<strong>${escapeHtml(content.year || "—")}</strong></div><div class="detail-field">Date de sortie<strong>${escapeHtml(content.releaseDate || "—")}</strong></div><div class="detail-field">Genres<strong>${escapeHtml((content.genres || []).map((g) => g.name || g).join(", ") || "—")}</strong></div><div class="detail-field">Langues audio<strong>${escapeHtml((content.audioLanguages || []).join(", ") || "—")}</strong></div><div class="detail-field">Sous-titres<strong>${escapeHtml((content.subtitleLanguages || []).join(", ") || "—")}</strong></div></div><p class="muted" style="font-size:11px;line-height:1.6;margin:14px 0 0">${escapeHtml(content.description || "Aucune description.")}</p></div>
      <div class="detail-section"><h3>Modifier la fiche</h3><form id="editContentForm" class="detail-form"><div class="form-grid"><label>Titre<input name="title" maxlength="200" value="${escapeHtml(content.title || "")}" required></label><label>Année<input name="year" type="number" min="1888" max="2100" value="${escapeHtml(content.year || "")}"></label><label>Date de sortie<input name="releaseDate" type="date" value="${escapeHtml(content.releaseDate || "")}"></label><label class="span-two">Description<textarea name="description" rows="3" maxlength="5000">${escapeHtml(content.description || "")}</textarea></label></div><button class="btn secondary" type="submit">Prévisualiser les modifications</button></form></div>
      <div class="detail-section"><h3>Publication</h3><p class="muted" style="font-size:10px">Chaque changement de statut est vérifié par le serveur et enregistré dans le journal d’audit.</p><div class="detail-actions">${statusActions(content)}</div></div>
      ${content.type !== "MOVIE" ? `<div class="detail-section"><h3>Saisons et épisodes</h3>${seasons}<form id="seasonForm" class="detail-form"><div class="form-grid"><label>Numéro de saison<input name="number" type="number" min="0" max="200" required></label><label>Titre<input name="title" maxlength="200" placeholder="Saison 1"></label><label>Date de sortie<input name="releaseDate" type="date" required></label><label class="check-label"><input name="featuredAsNewSeason" type="checkbox"> Mettre en avant comme nouvelle saison</label></div><button class="btn primary" type="submit">＋ Créer une saison</button></form></div>` : ""}
      ${content.type === "MOVIE" ? `<div class="detail-section"><h3>Versions vidéo</h3><div class="simple-list">${versions || '<div class="empty-state">Aucune version vidéo associée.</div>'}</div><form id="versionForm" class="detail-form"><div class="form-grid"><label class="span-two">ID du fichier vidéo<input name="mediaFileId" required placeholder="ID obtenu après un envoi média"></label><label>Libellé<input name="label" placeholder="720p"></label><label>Hauteur (px)<input name="height" type="number" min="1" max="20000" placeholder="720"></label><label>Largeur (px)<input name="width" type="number" min="1" max="20000" placeholder="1280"></label><label>Durée (secondes)<input name="durationSeconds" type="number" min="1" max="86400"></label><label class="span-two">Langues audio (codes séparés par virgules)<input name="audioLanguages" required placeholder="fr, en"></label></div><button class="btn secondary" type="submit">＋ Ajouter une version</button></form></div>` : ""}
      <div class="detail-section"><h3>Affiches</h3><div class="simple-list">${posters || '<div class="empty-state">Aucune affiche associée.</div>'}</div><form id="posterForm" class="detail-form"><div class="form-grid"><label class="span-two">ID du fichier image<input name="mediaFileId" required placeholder="ID du fichier IMAGE"></label><label>Type<select name="kind"><option>POSTER</option><option>PROMOTIONAL</option></select></label><label class="check-label"><input name="makePrimary" type="checkbox" checked> Définir comme affiche principale</label></div><button class="btn secondary" type="submit">＋ Ajouter une affiche</button></form></div>
      <div class="detail-section"><h3>Bandes-annonces</h3><div class="simple-list">${trailers || '<div class="empty-state">Aucune bande-annonce associée.</div>'}</div><form id="trailerForm" class="detail-form"><div class="form-grid"><label>Titre<input name="title" maxlength="200" placeholder="Bande-annonce officielle"></label><label>ID du média<input name="mediaFileId" placeholder="ID fichier TRAILER_VIDEO"></label><label class="span-two">Ou URL HTTPS externe<input name="externalUrl" type="url" placeholder="https://…"></label><label class="check-label"><input name="makePrimary" type="checkbox"> Définir comme principale</label></div><button class="btn secondary" type="submit">＋ Ajouter une bande-annonce</button></form></div>
    `;
    $("#detailDialog").showModal();
  }

  function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
  async function editContent(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = formObject(form);
    const changes = {
      title: values.title.trim(),
      description: values.description || null,
      year: values.year ? Number(values.year) : null,
      releaseDate: values.releaseDate || null
    };
    const preview = await api("/admin/contents/" + state.currentContent.content.id, { method: "PATCH", body: changes });
    const lines = preview.summary || [];
    if (!lines.length) { toast("Aucune modification détectée."); return; }
    const summary = lines.map((line) => line.field + " : " + JSON.stringify(line.from) + " → " + JSON.stringify(line.to)).join("\n");
    if (!window.confirm("Confirmer ces modifications ?\n\n" + summary)) return;
    await api("/admin/contents/" + state.currentContent.content.id, { method: "PATCH", body: { ...changes, confirm: true } });
    toast("Fiche mise à jour.");
    await openContent(state.currentContent.content.id);
    await loadCatalog(state.page);
  }

  async function createContent(event) {
    event.preventDefault();
    const year = $("#contentYear").value;
    const payload = {
      type: $("#contentType").value,
      title: $("#contentTitle").value.trim(),
      description: $("#contentDescription").value.trim() || null,
      ...(year ? { year: Number(year) } : {}),
      ...( $("#contentReleaseDate").value ? { releaseDate: $("#contentReleaseDate").value } : {}),
      genres: splitValues($("#contentGenres").value),
      altTitles: splitValues($("#contentAltTitles").value),
      audioLanguages: splitValues($("#contentAudio").value).map((x) => x.toLowerCase()),
      subtitleLanguages: splitValues($("#contentSubs").value).map((x) => x.toLowerCase())
    };
    const result = await api("/admin/contents", { method: "POST", body: payload });
    $("#contentDialog").close();
    $("#contentForm").reset();
    toast("Fiche créée en brouillon.");
    await loadCatalog(1);
    await openContent(result.content.id);
  }

  async function setContentStatus(id, status) {
    if (!window.confirm("Confirmer le changement de statut : " + (STATUS_LABELS[status] || status) + " ?")) return;
    await api("/admin/contents/" + id + "/status", { method: "POST", body: { status } });
    toast("Statut mis à jour.");
    await openContent(id);
    await loadCatalog(state.page);
    await loadOverview();
  }

  async function createSeason(event) {
    event.preventDefault();
    const form = event.currentTarget, values = formObject(form);
    await api("/admin/contents/" + state.currentContent.content.id + "/seasons", {
      method: "POST", body: {
        number: Number(values.number), title: values.title || null, releaseDate: values.releaseDate,
        featuredAsNewSeason: form.elements.featuredAsNewSeason.checked
      }
    });
    toast("Saison créée.");
    await openContent(state.currentContent.content.id);
  }

  async function createEpisode(event) {
    event.preventDefault();
    const form = event.currentTarget, values = formObject(form);
    await api("/admin/seasons/" + form.dataset.seasonId + "/episodes", {
      method: "POST", body: {
        number: Number(values.number), title: values.title || null,
        description: values.description || null, releaseNote: values.releaseNote || null
      }
    });
    toast("Épisode créé.");
    await openContent(state.currentContent.content.id);
  }

  async function createVersion(event) {
    event.preventDefault();
    const values = formObject(event.currentTarget);
    const payload = {
      mediaFileId: values.mediaFileId.trim(),
      audioLanguages: splitValues(values.audioLanguages).map((x) => x.toLowerCase()),
      ...(values.label ? { label: values.label } : {}),
      ...(values.height ? { height: Number(values.height) } : {}),
      ...(values.width ? { width: Number(values.width) } : {}),
      ...(values.durationSeconds ? { durationSeconds: Number(values.durationSeconds) } : {})
    };
    const result = await api("/admin/contents/" + state.currentContent.content.id + "/versions", { method: "POST", body: payload });
    toast("Version ajoutée en brouillon. Publie-la séparément après vérification.");
    await openContent(state.currentContent.content.id);
  }

  async function createEpisodeVersion(event) {
    event.preventDefault();
    const form = event.currentTarget, values = formObject(form);
    const payload = {
      mediaFileId: values.mediaFileId.trim(),
      audioLanguages: splitValues(values.audioLanguages).map((x) => x.toLowerCase()),
      ...(values.label ? { label: values.label } : {}),
      ...(values.height ? { height: Number(values.height) } : {}),
      ...(values.width ? { width: Number(values.width) } : {}),
      ...(values.durationSeconds ? { durationSeconds: Number(values.durationSeconds) } : {})
    };
    await api("/admin/episodes/" + form.dataset.episodeId + "/versions", { method: "POST", body: payload });
    toast("Version ajoutée à l’épisode en brouillon.");
    await openContent(state.currentContent.content.id);
  }

  async function setVersionStatus(id, status) {
    if (!confirm("Confirmer le statut de cette version : " + (STATUS_LABELS[status] || status) + " ?")) return;
    await api("/admin/versions/" + id + "/status", { method: "POST", body: { status } });
    toast("Statut de la version mis à jour.");
    await openContent(state.currentContent.content.id);
  }

  async function setEpisodeStatus(id, status) {
    if (!confirm("Confirmer le statut de cet épisode : " + (STATUS_LABELS[status] || status) + " ?")) return;
    await api("/admin/episodes/" + id + "/status", { method: "POST", body: { status } });
    toast("Statut de l’épisode mis à jour.");
    await openContent(state.currentContent.content.id);
  }

  async function setSeasonStatus(id, status) {
    if (!confirm("Confirmer le statut de cette saison : " + (STATUS_LABELS[status] || status) + " ?")) return;
    await api("/admin/seasons/" + id + "/status", { method: "POST", body: { status } });
    toast("Statut de la saison mis à jour.");
    await openContent(state.currentContent.content.id);
  }

  async function mediaAction(kind, id, action) {
    if (action === "archive" && !confirm("Archiver ce média ? Il ne sera plus proposé comme média actif.")) return;
    const route = kind === "poster" ? "/admin/posters/" : "/admin/trailers/";
    await api(route + id + "/" + action, { method: "POST", body: {} });
    toast(action === "primary" ? "Média principal mis à jour." : action === "restore" ? "Média restauré." : "Média archivé.");
    await openContent(state.currentContent.content.id);
  }

  async function createPoster(event) {
    event.preventDefault();
    const values = formObject(event.currentTarget);
    await api("/admin/contents/" + state.currentContent.content.id + "/posters", {
      method: "POST", body: { mediaFileId: values.mediaFileId.trim(), kind: values.kind, makePrimary: event.currentTarget.elements.makePrimary.checked }
    });
    toast("Affiche associée.");
    await openContent(state.currentContent.content.id);
  }

  async function createTrailer(event) {
    event.preventDefault();
    const values = formObject(event.currentTarget);
    const payload = {
      ...(values.title ? { title: values.title } : {}),
      ...(values.mediaFileId ? { mediaFileId: values.mediaFileId.trim() } : {}),
      ...(values.externalUrl ? { externalUrl: values.externalUrl.trim() } : {}),
      makePrimary: event.currentTarget.elements.makePrimary.checked
    };
    await api("/admin/contents/" + state.currentContent.content.id + "/trailers", { method: "POST", body: payload });
    toast("Bande-annonce associée.");
    await openContent(state.currentContent.content.id);
  }

  async function uploadMedia(event) {
    event.preventDefault();
    if (state.uploadBusy) return;
    const file = $("#mediaFile").files[0];
    if (!file) { toast("Choisis un fichier.", true); return; }
    state.uploadBusy = true;
    const submit = $("#uploadForm button[type=submit]");
    submit.disabled = true;
    $("#uploadProgress").classList.remove("hidden");
    $("#uploadedMedia").textContent = "Envoi en cours…";
    const progress = (percent, label) => {
      $("#uploadBar").style.width = Math.max(0, Math.min(100, percent)) + "%";
      $("#uploadPercent").textContent = Math.round(percent) + "%";
      $("#uploadStatus").textContent = label;
    };
    try {
      const init = await api("/admin/uploads", { method: "POST", body: { kind: $("#uploadKind").value, filename: file.name, sizeBytes: file.size } });
      if (init.multipart) {
        const partSize = init.partSize;
        const parts = init.parts || [];
        for (let index = 0; index < parts.length; index++) {
          const part = parts[index];
          const start = (part.partNumber - 1) * partSize;
          const blob = file.slice(start, Math.min(file.size, start + partSize));
          let sent = false, lastError;
          for (let attempt = 0; attempt < 3 && !sent; attempt++) {
            try {
              const response = await fetch(part.url, { method: "PUT", body: blob });
              if (!response.ok) throw new Error("Échec du morceau " + part.partNumber + " (" + response.status + ")");
              sent = true;
            } catch (error) { lastError = error; }
          }
          if (!sent) throw lastError || new Error("Échec de l’envoi.");
          progress(((index + 1) / parts.length) * 92, "Envoi du morceau " + (index + 1) + " / " + parts.length);
        }
      } else {
        const response = await fetch(init.url, { method: "PUT", body: file });
        if (!response.ok) throw new Error("Le stockage a refusé le fichier (" + response.status + "). Vérifie la configuration CORS de R2.");
        progress(92, "Vérification du fichier…");
      }
      progress(96, "Vérification par le serveur…");
      const completed = await api("/admin/uploads/" + init.mediaFileId + "/complete", { method: "POST" });
      progress(100, "Envoi terminé");
      $("#uploadedMedia").className = "media-id";
      $("#uploadedMedia").innerHTML = "Fichier vérifié :<br><br><strong>" + escapeHtml(completed.mediaFileId) + "</strong><br><br><button class=\"btn secondary\" id=\"copyMediaId\" type=\"button\">Copier l’identifiant</button>";
      $("#copyMediaId").addEventListener("click", () => navigator.clipboard.writeText(completed.mediaFileId).then(() => toast("Identifiant copié.")));
      toast("Fichier envoyé et vérifié par Movie X.");
    } catch (error) {
      progress(0, "Échec de l’envoi");
      $("#uploadedMedia").className = "media-id empty-state";
      $("#uploadedMedia").textContent = error.message;
      toast(error.message, true);
    } finally {
      state.uploadBusy = false; submit.disabled = false;
    }
  }

  async function loadSchedules() {
    const data = await api("/admin/scheduled-publications?page=1&limit=100");
    const items = data.items || data.scheduledPublications || [];
    $("#scheduleList").innerHTML = items.map((job) => `
      <div class="simple-row"><div><strong>${escapeHtml(job.action)} · ${escapeHtml(job.targetType)}</strong><small>${escapeHtml(job.targetId)} · ${escapeHtml(formatDate(job.scheduledFor || job.scheduledAt))} · ${escapeHtml(job.status)}</small></div>${job.status === "PENDING" ? `<button class="row-action" data-cancel-schedule="${escapeHtml(job.id)}">Annuler</button>` : ""}</div>`).join("") || '<div class="empty-state">Aucune action programmée.</div>';
  }

  async function createSchedule(event) {
    event.preventDefault();
    const payload = {
      targetType: $("#scheduleTargetType").value,
      targetId: $("#scheduleTargetId").value.trim(),
      action: $("#scheduleAction").value,
      scheduledFor: dateInputToIso($("#scheduleDate").value),
      adminNote: $("#scheduleNote").value.trim() || null,
      notifyFollowers: $("#notifyFollowers").checked
    };
    await api("/admin/scheduled-publications", { method: "POST", body: payload });
    event.currentTarget.reset();
    toast("Action programmée.");
    await loadSchedules();
    await loadOverview();
  }

  async function loadWithdrawals() {
    const data = await api("/admin/content-withdrawals?page=1&limit=100");
    const items = data.items || data.withdrawals || [];
    $("#withdrawalList").innerHTML = items.map((item) => {
      const status = item.canceledAt ? "Annulé" : item.executedAt ? "Exécuté" : "En attente";
      const title = item.content?.title || item.contentId;
      const active = !item.canceledAt && !item.executedAt;
      return `<div class="simple-row"><div><strong>Retrait · ${escapeHtml(title)} · ${status}</strong><small>Préavis : ${escapeHtml(formatDate(item.noticeStartsAt))} · Retrait : ${escapeHtml(formatDate(item.effectiveAt))}</small></div>${active ? `<button class="row-action" data-cancel-withdrawal="${escapeHtml(item.id)}">Annuler</button>` : ""}</div>`;
    }).join("") || '<div class="empty-state">Aucun retrait programmé.</div>';
  }

  async function createWithdrawal(event) {
    event.preventDefault();
    const payload = {
      contentId: $("#withdrawContentId").value.trim(),
      noticeStartsAt: dateInputToIso($("#noticeStartsAt").value),
      effectiveAt: dateInputToIso($("#effectiveAt").value),
      message: $("#withdrawMessage").value.trim() || undefined
    };
    if (new Date(payload.effectiveAt) <= new Date(payload.noticeStartsAt)) {
      toast("La date de retrait doit être postérieure au début du préavis.", true); return;
    }
    await api("/admin/content-withdrawals", { method: "POST", body: payload });
    event.currentTarget.reset();
    toast("Retrait programmé.");
    await loadWithdrawals();
  }

  function updateAudienceFields() {
    const audience = $("#notificationAudience").value;
    $("#notificationContentField").classList.toggle("hidden", audience !== "FOLLOWERS" && !["NEW_EPISODE", "NEW_SEASON", "NEW_LANGUAGE_VERSION"].includes($("#notificationType").value));
    $("#notificationUserField").classList.toggle("hidden", audience !== "USER");
  }
  async function createNotification(event) {
    event.preventDefault();
    const audience = $("#notificationAudience").value;
    const type = $("#notificationType").value;
    const contentId = $("#notificationContentId").value.trim();
    const targetUserId = $("#notificationUserId").value.trim();
    const payload = {
      type, audience,
      title: $("#notificationTitle").value.trim(),
      body: $("#notificationBody").value.trim(),
      ...((audience === "FOLLOWERS" || ["NEW_EPISODE", "NEW_SEASON", "NEW_LANGUAGE_VERSION"].includes(type)) ? { contentId } : {}),
      ...(audience === "USER" ? { targetUserId } : {})
    };
    const audienceLabel = audience === "ALL" ? "tous les utilisateurs" : audience === "FOLLOWERS" ? "les abonnés ciblés" : "l’utilisateur indiqué";
    if (!confirm("Envoyer immédiatement cette notification à " + audienceLabel + " ?\\n\\n" + payload.title)) return;
    const result = await api("/admin/notifications", { method: "POST", body: payload });
    event.currentTarget.reset(); updateAudienceFields();
    toast("Notification envoyée à " + (result.recipientCount ?? "—") + " utilisateur(s).");
  }

  async function navigate(view) {
    const titles = { overview: "Vue générale", catalog: "Catalogue", uploads: "Fichiers média", planning: "Programmation", notifications: "Notifications", withdrawals: "Retraits" };
    $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    $$(".view").forEach((section) => section.classList.toggle("active", section.id === "view-" + view));
    $("#pageTitle").textContent = titles[view] || "Administration";
    hideNotice();
    try {
      if (view === "overview") await loadOverview();
      if (view === "catalog") await loadCatalog(1);
      if (view === "planning") await loadSchedules();
      if (view === "withdrawals") await loadWithdrawals();
    } catch (error) { showNotice(error.message, true); }
  }

  function bind() {
    $("#loginForm").addEventListener("submit", (event) => login(event).catch((error) => showLogin(error.message)));
    $("#logoutButton").addEventListener("click", logout);
    $("#refreshButton").addEventListener("click", () => {
      const active = $(".view.active")?.id.replace("view-", "") || "overview";
      navigate(active).then(() => toast("Données actualisées.")).catch((error) => showNotice(error.message, true));
    });
    $$(".nav-item").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
    document.addEventListener("click", (event) => {
      const target = event.target.closest("[data-view],[data-action],[data-close-dialog],[data-open-content],[data-set-status],[data-set-version-status],[data-set-episode-status],[data-set-season-status],[data-primary-poster],[data-archive-poster],[data-restore-poster],[data-primary-trailer],[data-archive-trailer],[data-restore-trailer],[data-cancel-schedule],[data-cancel-withdrawal]");
      if (!target) return;
      if (target.dataset.view) navigate(target.dataset.view);
      if (target.dataset.action === "new-content") $("#contentDialog").showModal();
      if (target.hasAttribute("data-close-dialog")) target.closest("dialog")?.close();
      if (target.dataset.openContent) openContent(target.dataset.openContent).catch((error) => toast(error.message, true));
      if (target.dataset.setStatus) setContentStatus(target.dataset.statusId, target.dataset.setStatus).catch((error) => toast(error.message, true));
      if (target.dataset.setVersionStatus) setVersionStatus(target.dataset.versionId, target.dataset.setVersionStatus).catch((error) => toast(error.message, true));
      if (target.dataset.setEpisodeStatus) setEpisodeStatus(target.dataset.episodeId, target.dataset.setEpisodeStatus).catch((error) => toast(error.message, true));
      if (target.dataset.setSeasonStatus) setSeasonStatus(target.dataset.seasonId, target.dataset.setSeasonStatus).catch((error) => toast(error.message, true));
      if (target.dataset.primaryPoster) mediaAction("poster", target.dataset.primaryPoster, "primary").catch((error) => toast(error.message, true));
      if (target.dataset.archivePoster) mediaAction("poster", target.dataset.archivePoster, "archive").catch((error) => toast(error.message, true));
      if (target.dataset.restorePoster) mediaAction("poster", target.dataset.restorePoster, "restore").catch((error) => toast(error.message, true));
      if (target.dataset.primaryTrailer) mediaAction("trailer", target.dataset.primaryTrailer, "primary").catch((error) => toast(error.message, true));
      if (target.dataset.archiveTrailer) mediaAction("trailer", target.dataset.archiveTrailer, "archive").catch((error) => toast(error.message, true));
      if (target.dataset.restoreTrailer) mediaAction("trailer", target.dataset.restoreTrailer, "restore").catch((error) => toast(error.message, true));
      if (target.dataset.cancelSchedule) {
        if (confirm("Annuler cette action programmée ?")) api("/admin/scheduled-publications/" + target.dataset.cancelSchedule, { method: "DELETE" }).then(loadSchedules).then(() => toast("Programmation annulée.")).catch((error) => toast(error.message, true));
      }
      if (target.dataset.cancelWithdrawal) {
        if (confirm("Annuler ce retrait ?")) api("/admin/content-withdrawals/" + target.dataset.cancelWithdrawal, { method: "DELETE" }).then(loadWithdrawals).then(() => toast("Retrait annulé.")).catch((error) => toast(error.message, true));
      }
    });
    $("#contentForm").addEventListener("submit", (event) => createContent(event).catch((error) => toast(error.message, true)));
    $("#searchCatalogButton").addEventListener("click", () => loadCatalog(1).catch((error) => showNotice(error.message, true)));
    $("#catalogSearch").addEventListener("keydown", (event) => { if (event.key === "Enter") loadCatalog(1).catch((error) => showNotice(error.message, true)); });
    $("#prevPage").addEventListener("click", () => loadCatalog(Math.max(1, state.page - 1)).catch((error) => toast(error.message, true)));
    $("#nextPage").addEventListener("click", () => loadCatalog(state.page + 1).catch((error) => toast(error.message, true)));
    $("#detailBody").addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.target;
      const handlers = { editContent: editContent, seasonForm: createSeason, versionForm: createVersion, posterForm: createPoster, trailerForm: createTrailer };
      if (form.id === "editContentForm") handlers.editContent(event).catch((error) => toast(error.message, true));
      else if (form.id && handlers[form.id]) handlers[form.id](event).catch((error) => toast(error.message, true));
      else if (form.classList.contains("episode-form")) createEpisode(event).catch((error) => toast(error.message, true));
      else if (form.classList.contains("episode-version-form")) createEpisodeVersion(event).catch((error) => toast(error.message, true));
    });
    $("#uploadForm").addEventListener("submit", (event) => uploadMedia(event).catch((error) => toast(error.message, true)));
    $("#mediaFile").addEventListener("change", (event) => {
      const file = event.target.files[0];
      $("#selectedFile").textContent = file ? file.name + " · " + (file.size / (1024 * 1024)).toFixed(1) + " Mio" : "Aucun fichier sélectionné";
    });
    $("#scheduleForm").addEventListener("submit", (event) => createSchedule(event).catch((error) => toast(error.message, true)));
    $("#loadSchedules").addEventListener("click", () => loadSchedules().catch((error) => toast(error.message, true)));
    $("#notificationForm").addEventListener("submit", (event) => createNotification(event).catch((error) => toast(error.message, true)));
    $("#notificationAudience").addEventListener("change", updateAudienceFields);
    $("#notificationType").addEventListener("change", updateAudienceFields);
    $("#withdrawalForm").addEventListener("submit", (event) => createWithdrawal(event).catch((error) => toast(error.message, true)));
    $("#loadWithdrawals").addEventListener("click", () => loadWithdrawals().catch((error) => toast(error.message, true)));
  }

  async function init() {
    bind();
    const savedApi = sessionStorage.getItem("moviehub-admin-api");
    const savedSession = sessionStorage.getItem("moviehub-admin-session");
    if (savedApi) $("#apiUrl").value = savedApi;
    if (savedSession) {
      try {
        state.session = JSON.parse(savedSession);
        state.api = savedApi || "http://localhost:3000";
        await api("/admin/contents?page=1&limit=1");
        showApp();
        await navigate("overview");
      } catch (error) {
        state.session = null; sessionSave(); showLogin(error.message);
      }
    }
    updateAudienceFields();
  }

  document.addEventListener("DOMContentLoaded", init);
})();