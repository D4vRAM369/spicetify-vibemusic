// ==============================================================================
// 🎵 PROYECTO: Vibemusic (extensión de Spicetify)
// 📌 DESCRIPCIÓN: Describe en lenguaje natural lo que quieres escuchar y crea la
//                playlist con canciones reales del catálogo de Spotify.
// ponytail: las claves de localStorage siguen siendo mood_ai_* (nombre antiguo) para no
//           perder la configuración de quien ya la usa; no renombrarlas sin migración.
// 👨‍🏫 METODOLOGÍA: PBL (Project-Based Learning)
// ==============================================================================

(function VibemusicExtension() {
  // --------------------------------------------------------------------------
  // PASO 0: Funciones puras de validación y matching (sin Spicetify).
  // Se exportan en Node para probarlas: `node --test`.
  // --------------------------------------------------------------------------
  const MAX_TRACKS = 50;

  const Match = {
    normalize(s) {
      return String(s || "")
        .toLowerCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/\(.*?\)|\[.*?\]/g, " ")
        .replace(/\s-\s.*$/, " ")              // "Tema - Remastered 2004"
        .replace(/\b(feat|ft)\b\.?.*$/, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    },

    tokens(s) {
      return Match.normalize(s).split(" ").filter(Boolean);
    },

    // Fracción de palabras buscadas que aparecen en el candidato (0..1).
    recall(wanted, candidate) {
      const w = Match.tokens(wanted);
      if (w.length === 0) return 0;
      const c = new Set(Match.tokens(candidate));
      return w.filter(t => c.has(t)).length / w.length;
    },

    // Álbumes que suelen ser producciones instrumentales originales.
    // ponytail: lista corta de palabras; un álbum instrumental sin ellas ("Donuts") no recibe bonus.
    INST_WORK: /instrumental|strumentals|beat\s?tape|\bbeats\b|original score/i,

    // ponytail: heurística por palabras; sustituir por distancia de edición si da falsos negativos.
    pickBest(wanted, candidates, minTitle = 0.6, minArtist = 0.5) {
      const INST = /instrumental|\binst\b/i;
      const needsInstVersion = INST.test(wanted.title);
      let best = null;
      for (const c of candidates) {
        if (!c || !c.uri) continue;
        // Si se pidió la versión instrumental, la versión con voz no vale (y al revés).
        if (needsInstVersion && !INST.test(c.name)) continue;
        if (wanted.instrumental === false && INST.test(c.name)) continue;
        const title = Match.recall(wanted.title, c.name);
        const artist = wanted.artist ? Match.recall(wanted.artist, c.artists.join(" ")) : 1;
        if (title < (wanted.artist ? minTitle : 0.8) || artist < minArtist) continue;
        const bonus = wanted.instrumental && INST.test(c.name) ? 0.2 : 0;
        // Si se piden instrumentales, el nombre del álbum puede delatar una obra sin voz ("Instrumentals", "Original Score").
        // Solo si la búsqueda trajo el nombre del álbum; si no, no se inventa nada.
        const workBonus = wanted.instrumental && Match.INST_WORK.test(c.album || "") ? 0.1 : 0;
        // "Iris" pedido → preferir "Iris" a "Iris - Acoustic" aunque ambos coincidan en palabras.
        const altPenalty = Match.isAltVersion(c.name) && !Match.isAltVersion(wanted.title) ? 0.3 : 0;
        const score = title + artist + bonus + workBonus - altPenalty;
        if (!best || score > best.score) best = { ...c, score };
      }
      return best;
    },

    // "2000 a 2010", "2000-2010", "años 90", "90s", "1990s", "noventeros" → {from, to}
    parseYearRange(text) {
      const t = String(text || "").toLowerCase();
      const span = t.match(/\b((?:19|20)\d{2})\s*(?:-|–|a|al|hasta|to|y)\s*((?:19|20)\d{2})\b/);
      if (span) {
        const a = +span[1], b = +span[2];
        return { from: Math.min(a, b), to: Math.max(a, b) };
      }
      const full = t.match(/\b((?:19|20)\d)0s\b/);
      if (full) return { from: +full[1] * 10, to: +full[1] * 10 + 9 };
      const short = t.match(/\baños\s+'?(\d)0\b/) || t.match(/\b'?(\d)0s\b/);
      if (short) {
        const base = +short[1] <= 2 ? 2000 + +short[1] * 10 : 1900 + +short[1] * 10;
        return { from: base, to: base + 9 };
      }
      const words = { sesent: 1960, setent: 1970, ochent: 1980, novent: 1990 };
      for (const [w, base] of Object.entries(words)) {
        if (t.includes(w)) return { from: base, to: base + 9 };
      }
      return null;
    },

    // "los 10 mejores", "top 15", "20 canciones" → número (1..MAX_TRACKS) o null
    parseRequestedCount(text) {
      const t = String(text || "").toLowerCase();
      const m = t.match(/\btop\s*(\d{1,2})\b/) ||
        t.match(/\b(\d{1,2})\s+(?:mejores|best|canciones|temas|tracks|songs|pistas|beats|instrumentales|cortes|temazos)\b/);
      if (!m) return null;
      const n = +m[1];
      return n >= 1 ? Math.min(n, MAX_TRACKS) : null;
    },

    // ¿El texto del usuario menciona explícitamente un idioma o gentilicio? Evita que la IA deduzca
    // un idioma falso por el nombre o apellido de un artista cuando el usuario no pidió ningún idioma.
    MENTIONS_LANGUAGE: /\b(espa[ñn]ol\w*|castellano|ingl[eé]s|english|portugu[eé]s\w*|portuguese|franc[eé]s\w*|french|italiano\w*|italian|alem[aá]n\w*|german|japon[eé]s\w*|coreano\w*|catal[aá]n\w*|galego|gallego\w*|euskera|vasco|latino\w*|hispano\w*|anglo\w*|en\s+(?:espa[ñn]ol|ingl[eé]s|portugu[eé]s|franc[eé]s|italiano|alem[aá]n|catal[aá]n|gallego))\b/i,

    // Limpia coletillas técnicas ("con voz", "idioma ...") si la IA las cuela en el summary.
    cleanSummary(s) {
      return String(s || "")
        .replace(/[,·]?\s*\b(con voz|sin voz|idioma\s+[a-záéíóúñ]+)\b/gi, "")
        .replace(/\s+/g, " ")
        .replace(/[,·\s]+$/, "")
        .trim();
    },

    // Une lo que entendió la IA (intent) con los filtros del modal.
    // Prioridad: filtro explícito del modal > lo dicho en el texto > valor por defecto.
    resolveRequest(text, intent, ui) {
      const i = intent || {};
      const n = parseInt(i.count, 10);
      const count = (n >= 1 ? Math.min(n, MAX_TRACKS) : null) || Match.parseRequestedCount(text) || ui.count || 10;
      const era = i.era && +i.era.from && +i.era.to
        ? { from: Math.min(+i.era.from, +i.era.to), to: Math.max(+i.era.from, +i.era.to) }
        : null;
      const instrumental = ui.trackType === "instrumental" ? true
        : ui.trackType === "vocal" ? false
        : typeof i.instrumental === "boolean" ? i.instrumental : null;
      const list = v => (Array.isArray(v) ? v.filter(x => typeof x === "string" && x.trim()) : []);
      const hasLang = Match.MENTIONS_LANGUAGE.test(String(text || ""));
      return {
        count,
        askFor: Match.askFor(count),
        range: era || Match.parseYearRange(text),
        instrumental,
        language: instrumental || !hasLang || typeof i.language !== "string" ? null : i.language.toLowerCase().slice(0, 2),
        genre: typeof i.genre === "string" ? i.genre : "",
        mood: typeof i.mood === "string" ? i.mood : "",
        purpose: typeof i.purpose === "string" ? i.purpose : "",
        includeArtists: list(i.include_artists),
        excludeArtists: list(i.exclude_artists),
        searchQueries: list(i.search_queries).slice(0, 6),
        onlyArtists: i.only_artists === true && list(i.include_artists).length > 0,
        // Versiones alternativas (demo, acústica, directo, remix...) solo si el texto las pide.
        allowVersions: Match.ALT_VERSION.test(String(text || "")),
        summary: typeof i.summary === "string" ? Match.cleanSummary(i.summary) : ""
      };
    },

    // Versiones alternativas de una canción. Probado en vivo: con "canciones tristes de los 90"
    // salían "Iris - Acoustic" o "Sad Song - Demo" en lugar de las originales.
    ALT_VERSION: /\b(demo|acoustic|ac[uú]stic[oa]|live|en directo|en vivo|unplugged|remix|re-?mix|karaoke|cover|tribute|rehearsal|sped up|slowed|nightcore|8-?bit|lullaby)(e?s)?\b/i, // (e?s)? = plurales: acústicas, remixes, demos

    isAltVersion(name) {
      // Solo miramos lo que va tras " - " o entre paréntesis/corchetes: "Live Forever" no es un directo.
      const tail = (String(name || "").match(/\s-\s(.*)$|\(([^)]*)\)|\[([^\]]*)\]/g) || []).join(" ");
      return Match.ALT_VERSION.test(tail);
    },

    // Nombre de la playlist: "Vibemusic · <resumen de la IA>" (≤ 60 caracteres). Antes era el prompt
    // cortado a 25 ("Vibemusic: 15 temas de indie rock es..."), poco legible.
    playlistName(source) {
      let t = String(source || "").replace(/\s+/g, " ").trim().replace(/[.。]+$/, "");
      t = t.charAt(0).toUpperCase() + t.slice(1);
      const max = 60 - "Vibemusic · ".length;
      if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…"; // corta en palabra entera
      return `Vibemusic · ${t || "Mi selección"}`;
    },

    // Prompts de ejemplo del modal (variados a propósito: la extensión es genérica).
    // label corto para que quepan en 1-2 filas sin scroll; prompt = lo que se escribe al pulsar.
    EXAMPLES: [
      { label: "🎤 Temazos de rap 2000s", prompt: "los 10 mejores temazos de rap de 2000 a 2010" },
      { label: "🎸 Indie español 2000s", prompt: "15 temas de indie rock español de los 2000 para un viaje en coche" },
      { label: "🎹 Instrumentales para concentrarme", prompt: "instrumentales sin voz para concentrarme mientras trabajo" },
      { label: "🌅 Electrónica de domingo", prompt: "electrónica melódica tipo Bonobo para una tarde de domingo" },
      { label: "🌧️ Tristes de los 90", prompt: "canciones tristes en inglés de los 90" },
      { label: "💪 Para entrenar", prompt: "música con mucha energía para entrenar en el gimnasio" }
    ],

    // Tapa cualquier cosa con forma de clave (Gemini, Groq, OpenRouter, OpenAI, "Bearer ...") en un
    // texto. Se aplica a los mensajes de error de los proveedores ANTES de mostrarlos o registrarlos:
    // algunos servicios repiten parte de la clave en el error ("Incorrect API key provided: sk-...").
    redactSecrets(text) {
      return String(text ?? "").replace(
        /(Bearer\s+)?\b(gsk_|AIza|sk-or-v1-|sk-|key-)[A-Za-z0-9_\-*.]{6,}/g,
        (m, bearer = "", prefix) => `${bearer}${prefix}…[clave oculta]`);
    },

    // ¿Mandaría la clave sin cifrar por la red? http:// solo es aceptable hacia el propio equipo.
    insecureUrl(url) {
      const u = String(url || "").trim();
      return /^http:\/\//i.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(u);
    },

    // Descripción que se guarda en la playlist: el prompt completo + lo entendido, ≤ 300 caracteres
    // (límite de Spotify). Si no cabe, se recorta lo entendido antes que el prompt.
    playlistDescription(prompt, understood) {
      const base = `Vibemusic · «${String(prompt || "").trim()}»`;
      const full = understood ? `${base} · ${understood}` : base;
      if (full.length <= 300) return full;
      return base.length <= 300 ? base : base.slice(0, 298) + "…";
    },

    // Extrae { prompt, understood } de la descripción de una playlist de Spotify si fue creada por Vibemusic.
    // Sirve de respaldo cuando la playlist no está en localStorage (otro PC o caché borrada).
    parsePlaylistDescription(desc) {
      const m = /^Vibemusic\s*·\s*«([\s\S]+?)»(?:\s*·\s*([\s\S]+))?$/.exec(String(desc || "").trim());
      if (!m || !m[1].trim()) return null;
      return { prompt: m[1].trim(), understood: (m[2] || "").trim() };
    },

    // Etiqueta corta para un chip de historial reciente (corta en palabra entera si supera max).
    shortChipLabel(text, max = 28) {
      const t = String(text || "").replace(/\s+/g, " ").trim();
      if (t.length <= max) return t;
      return t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
    },

    // Últimos prompts únicos del historial (ordenados del más reciente al más antiguo).
    recentPrompts(historyObj, limit = 5) {
      if (!historyObj || typeof historyObj !== "object") return [];
      const entries = Object.entries(historyObj)
        .filter(([, v]) => v && typeof v.prompt === "string" && v.prompt.trim())
        .sort((a, b) => (b[1].date || 0) - (a[1].date || 0));
      const seen = new Set(), out = [];
      for (const [uri, v] of entries) {
        const key = Match.normalize(v.prompt);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const prompt = v.prompt.trim();
        out.push({ uri, prompt, label: Match.shortChipLabel(prompt), date: v.date || 0 });
        if (out.length >= limit) break;
      }
      return out;
    },

    // Variedad: máximo de canciones por artista (sin límite si pidió solo ciertos artistas).
    // ponytail: 2 hasta 20 canciones, 3 si piden más; ajustar si se queda corto en géneros pequeños.
    artistCap(req) {
      return req.onlyArtists ? Infinity : (req.count > 20 ? 3 : 2);
    },

    // Artista principal normalizado (el primero de "A, B").
    mainArtist(artists) {
      return Match.normalize(String(artists || "").split(",")[0]);
    },

    // Cuántas pedir a la IA para cubrir `need` huecos con margen (×1,5) tras los descartes.
    askFor(need) {
      return Math.min(MAX_TRACKS, Math.max(3, Math.ceil(need * 1.5)));
    },

    // ---- Grounding: la IA elige entre pistas REALES del catálogo ----

    // Consultas para el buscador de Spotify: género primero, luego las de la IA, luego artistas.
    buildSearchQueries(req, max = 6) {
      const out = [], seen = new Set();
      const add = q => {
        const s = String(q || "").replace(/\s+/g, " ").trim();
        if (s && !seen.has(s.toLowerCase()) && out.length < max) { seen.add(s.toLowerCase()); out.push(s); }
      };
      const inst = req.instrumental === true;
      // Primero artistas/álbumes concretos y después el género: las búsquedas solo por género
      // atraen pistas de relleno con títulos de palabras clave (verificado en vivo 2026-11-14).
      (req.searchQueries || []).forEach(add);
      for (const a of req.includeArtists || []) add(inst ? `${a} instrumental` : a);
      if (req.genre) add(inst ? `${req.genre} instrumental` : req.genre);
      // Época pedida → filtro del buscador de Spotify (verificado en vivo: "year:2000-2009" funciona
      // en la búsqueda interna). Garantiza la época en el pool sin depender de que la IA sepa años.
      // ponytail: filtra por año del ÁLBUM; un tema de 2004 en un recopilatorio de 2015 no entra,
      // pero el original sí. Las rondas por título (findTrack) no usan el filtro.
      return req.range ? out.map(q => `${q} year:${req.range.from}-${req.range.to}`) : out;
    },

    // Quita repetidos por URI y también la misma canción publicada en single y álbum.
    dedupeCandidates(candidates) {
      const uris = new Set(), byKey = new Map(), out = [];
      for (const c of candidates) {
        if (!c || !c.uri || uris.has(c.uri)) continue;
        const key = `${Match.normalize(c.name)}|${Match.normalize(c.artists[0])}|${/instrumental/i.test(c.name)}`;
        uris.add(c.uri);
        if (byKey.has(key)) {
          // Misma canción: si la guardada era una versión alternativa (acústica, demo...) y esta es
          // la original, nos quedamos con la original en el mismo puesto (bug real del banco variado).
          const idx = byKey.get(key);
          if (Match.isAltVersion(out[idx].name) && !Match.isAltVersion(c.name)) out[idx] = c;
          continue;
        }
        byKey.set(key, out.length);
        out.push(c);
      }
      return out;
    },

    // Aplica al pool las restricciones que SÍ se pueden comprobar con los datos de la búsqueda.
    // ponytail: tope de 100 candidatas para no inflar el prompt; subir si la IA elige bien con más.
    // Pistas "de relleno" (cualquier género): catálogo genérico con títulos hechos de palabras
    // clave para salir en búsquedas ("Relaxing Piano Music for Study", "Workout Mix 2024",
    // "Boom Bap Type Beat") o artistas-etiqueta ("X Beats", "Study Music Academy").
    // ponytail: heurística por patrones; si aparecen falsos positivos, añadir excepciones aquí.
    isFiller(c) {
      const FILLER_NAME = new RegExp([
        "type beat", "free beat", "base de rap", "beat (prod|instrumental)",
        "instrumental (mix|beats?)", "\\b(rap|hip ?hop|trap|lo-?fi) beats?\\b",
        "music (for|to) (study|studying|sleep|sleeping|relax|relaxing|focus|work|meditation|yoga)",
        "(study|sleep|relaxing|focus|meditation|workout|gym|spa) music\\b",
        "\\b(workout|gym|party|running) mix\\b", "\\bmix 20\\d\\d\\b"
      ].join("|"), "i");
      const FILLER_ARTIST = /\b(beats|produkcja|instrumentals|music academy|music therapy|lounge collective|study music|sleep music|relaxing music)\s*$/i;
      return FILLER_NAME.test(c.name || "") || FILLER_NAME.test(c.album || "") ||
        (c.artists || []).some(a => FILLER_ARTIST.test(a));
    },

    // ponytail: 60 candidatas (~1 000 tokens) caben en el límite gratuito de Groq (8 000 tokens/min);
    // con 100 solo cabían ~2 peticiones por minuto (medido en vivo).
    filterPool(pool, req, max = 60) {
      const INST = /instrumental|\binst\b/i;
      const excluded = (req.excludeArtists || []).map(a => Match.normalize(a)).filter(Boolean);
      const ok = Match.dedupeCandidates(pool).filter(c =>
        !(req.instrumental === false && INST.test(c.name)) &&
        !excluded.some(a => Match.normalize(c.artists.join(" ")).includes(a))
      );
      // El relleno solo entra si sin él no hay ni el doble de lo pedido, y siempre al final.
      const weak = c => Match.isFiller(c) || (!req.allowVersions && Match.isAltVersion(c.name));
      const real = ok.filter(c => !weak(c));
      const filler = ok.filter(c => weak(c));
      return (real.length >= (req.count || 10) * 2 ? real : [...real, ...filler]).slice(0, max);
    },

    // Lista compacta y numerada para el prompt: "3. Título — Artista [álbum: X]".
    compactCandidateList(pool) {
      return pool.map((c, i) =>
        `${i}. ${c.name} — ${c.artists.join(", ")}${c.album ? ` [álbum: ${c.album}]` : ""}`
      ).join("\n");
    },

    // Respuesta de la IA → [{i, instrumental}] con índices válidos y sin repetir.
    // Acepta {"picks":[3,7]}, [3,7], ["3"] o [{"i":3,"instrumental":true}].
    parsePicks(content, poolLength) {
      let parsed;
      try { parsed = parseJSON(content); } catch (e) { return []; }
      const arr = Array.isArray(parsed) ? parsed
        : (parsed && typeof parsed === "object" && Object.values(parsed).find(Array.isArray)) || [];
      const seen = new Set(), out = [];
      for (const p of arr) {
        const raw = p && typeof p === "object" ? (p.i ?? p.index ?? p.n) : p;
        const i = typeof raw === "number" ? raw : /^\s*\d+\s*$/.test(String(raw)) ? parseInt(raw, 10) : NaN;
        if (!Number.isInteger(i) || i < 0 || i >= poolLength || seen.has(i)) continue;
        seen.add(i);
        const year = parseInt(p?.year, 10);
        out.push({ i, instrumental: typeof p?.instrumental === "boolean" ? p.instrumental : null,
                   year: year >= 1900 && year <= 2100 ? year : null });
      }
      return out;
    },

    // ---- Relleno: no volver a pedir lo ya probado ----

    trackKey(title, artist) {
      // Igual que en validateRecommendations: la versión instrumental es otra canción.
      return `${Match.normalize(title)}|${Match.normalize(String(artist || "").split(",")[0])}|${/instrumental/i.test(title)}`;
    },

    dropTried(items, tried) {
      const kept = [], rejected = [];
      for (const it of items) {
        if (tried.has(Match.trackKey(it.title, it.artist))) rejected.push({ ...it, reason: "ya probada" });
        else kept.push(it);
      }
      return { kept, rejected };
    },

    // ---- Menú contextual y ajuste conversacional ----

    // "spotify:track:abc" → "track"; solo los tipos que sabemos sembrar.
    uriKind(uri) {
      const m = /^spotify:(track|playlist):[A-Za-z0-9]+$/.exec(String(uri || ""));
      return m ? m[1] : null;
    },

    // Datos de una canción/playlist → texto inicial del modal ("" si no hay datos útiles).
    seedPrompt(info) {
      if (!info || !info.name) return "";
      if (info.kind === "track") {
        const by = info.artists && info.artists.length ? ` de ${info.artists.join(", ")}` : "";
        return `Canciones como «${info.name}»${by}`;
      }
      const samples = (info.samples || []).slice(0, 5);
      return `Música en la línea de mi playlist «${info.name}»${samples.length ? ` (por ejemplo: ${samples.join("; ")})` : ""}`;
    },

    // Ajuste sobre la última playlist: texto para interpretar + contexto para la IA.
    refineRequest(prevText, prevTracks, adjustment, max = 30) {
      const list = (prevTracks || []).slice(0, max).map(t => `${t.name} — ${t.artist}`).join("; ");
      return {
        text: `${prevText}. Ajuste: ${adjustment}`,
        context: list
          ? `Versión anterior: ${list}.\nAplica el ajuste "${adjustment}": conserva solo las que sigan encajando y sustituye el resto.`
          : ""
      };
    },

    // Etiqueta corta para mostrar al usuario qué se entendió.
    describe(req) {
      return [
        `${req.count} canciones`,
        req.genre,
        req.instrumental === true ? "instrumental" : req.instrumental === false ? "con voz" : "",
        req.range ? `${req.range.from}–${req.range.to}` : "",
        req.language ? `idioma: ${req.language}` : "",
        req.mood
      ].filter(Boolean).join(" · ");
    },

    // Quita duplicados y lo que incumple las restricciones según lo que declara la IA.
    validateRecommendations(items, req) {
      const kept = [], rejected = [], seen = new Set();
      const excluded = (req.excludeArtists || []).map(a => Match.normalize(a)).filter(Boolean);
      for (const it of items) {
        // normalize() borra "(Instrumental)": lo añadimos a la clave para no confundir versiones.
        const key = `${Match.normalize(it.title)}|${Match.normalize(it.artist)}|${/instrumental/i.test(it.title)}`;
        const reject = reason => rejected.push({ ...it, reason });
        if (seen.has(key)) { reject("duplicada"); continue; }
        seen.add(key);
        // ponytail: confiamos en el año que declara la IA; el año del álbum en Spotify
        // falla con remasters y recopilatorios.
        if (req.range && it.year && (it.year < req.range.from || it.year > req.range.to)) {
          reject(`fuera de época (${it.year})`); continue;
        }
        if (req.instrumental === true && it.instrumental === false) { reject("tiene voz"); continue; }
        if (req.instrumental === false && it.instrumental === true) { reject("es instrumental"); continue; }
        if (req.language && it.language && it.language !== req.language) {
          reject(`idioma ${it.language}`); continue;
        }
        if (excluded.some(a => Match.normalize(it.artist).includes(a))) { reject("artista excluido"); continue; }
        kept.push(it);
      }
      return { kept, rejected };
    }
  };

  // Proveedores con API compatible con OpenAI (/chat/completions y /models).
  // ponytail: añadir uno nuevo = una entrada aquí; el proveedor "custom" cubre el resto.
  const PROVIDERS = {
    gemini: {
      label: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai",
      defaultModel: "gemini-3.5-flash", keyHint: "AIza...", jsonMode: true,
      // Prueba en vivo 2026-11-14: gemini-2.5-* ya no está disponible para cuentas nuevas (404);
      // 3.5-flash con razonamiento "low" dio la mejor selección en ~5 s (3.7/3.8 tardaban >25 s).
      extraBody: { reasoning_effort: "low" },
      // Tareas sencillas (interpretar la petición): sin razonamiento, ~1-2 s en vez de ~5 s.
      fastBody: { reasoning_effort: "none" },
      note: "Gratis en aistudio.google.com/apikey. El que más sabe de música de nicho. 🛡️ Crea la clave en un proyecto SIN facturación: así nunca puede generar cargos."
    },
    groq: {
      label: "Groq", base: "https://api.groq.com/openai/v1",
      defaultModel: "openai/gpt-oss-120b", keyHint: "gsk_...", jsonMode: true,
      // gpt-oss "razona" antes de responder; "low" gasta menos tokens del límite por minuto.
      extraBody: { reasoning_effort: "low" },
      note: "Gratis en console.groq.com. Muy rápido. 🛡️ No añadas tarjeta (plan gratuito): una clave filtrada no puede costarte dinero."
    },
    openrouter: {
      label: "OpenRouter", base: "https://openrouter.ai/api/v1",
      // Gratuito (🆓): el anterior por defecto era de pago y gastó el saldo en las pruebas (Error #12).
      defaultModel: "baidu/ernie-5.5-flash-preview:free", keyHint: "sk-or-v1-...", jsonMode: false,
      headers: { "X-Title": "Vibemusic" }, // sin HTTP-Referer de spicetify.app: no somos una app oficial
      note: "Modelos 🆓 gratuitos con límite diario. 🛡️ Al crear la clave pon un límite de crédito (p. ej. 1 $) y usa modelos 🆓."
    },
    custom: {
      label: "Personalizado (compatible con OpenAI)", base: "",
      defaultModel: "", keyHint: "opcional (Ollama no usa clave)", jsonMode: false,
      note: "Mistral, Cerebras, NVIDIA, Ollama, LM Studio... El servidor debe permitir CORS. 🛡️ Usa una clave dedicada a Vibemusic, con límite de gasto."
    }
  };

  // Orden de intento: el principal primero, luego el resto en el orden de PROVIDERS.
  function providerChain(primary, isConfigured) {
    const ids = Object.keys(PROVIDERS);
    const ordered = ids.includes(primary) ? [primary, ...ids.filter(id => id !== primary)] : ids;
    return ordered.filter(isConfigured);
  }

  // Respuesta de /models (formato OpenAI) → [{id, label}] solo con modelos de chat.
  // Gratis primero (OpenRouter), luego alfabético.
  function parseModelList(json) {
    const NOT_CHAT = /whisper|tts|guard|orpheus|embed|moderation|image|vision-only|veo|aqa|-live|audio/i;
    const items = (Array.isArray(json?.data) ? json.data : [])
      .filter(m => m && typeof m.id === "string" && m.active !== false && !NOT_CHAT.test(m.id))
      .map(m => ({ ...m, id: m.id.replace(/^models\//, "") })) // Gemini devuelve "models/gemini-..."
      .filter(m => !m.architecture?.output_modalities || m.architecture.output_modalities.includes("text"))
      .map(m => {
        const free = m.id.endsWith(":free") || (m.pricing && +m.pricing.prompt === 0 && +m.pricing.completion === 0);
        return { id: m.id, free, label: `${free ? "🆓 " : ""}${m.id}` };
      });
    return items.sort((a, b) => (b.free - a.free) || a.id.localeCompare(b.id));
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { Match, parseLLMResponse, parseModelList, providerChain, PROVIDERS, parseJSON, cooldownSeconds };
    return;
  }

  // --------------------------------------------------------------------------
  // PASO 1: Esperar a que las APIs de Spicetify estén listas
  // --------------------------------------------------------------------------
  const checkDependencies = () => {
    return (
      window.Spicetify &&
      Spicetify.Topbar &&
      Spicetify.PopupModal &&
      Spicetify.Player &&
      Spicetify.Platform
    );
  };

  if (!checkDependencies()) {
    setTimeout(VibemusicExtension, 200);
    return;
  }

  // --------------------------------------------------------------------------
  // PASO 2: Definición GraphQL de búsqueda de Spotify
  // Verificado en vivo (2026-11-14, Spotify 1.2.95, Spicetify 2.46.7): este hash funciona
  // con limit 20 y devuelve nombre de álbum (no la fecha). searchDesktop se retiró: su hash
  // guardado daba HttpResponseError.
  // --------------------------------------------------------------------------
  const PERSISTED_SEARCH_TRACKS = {
    name: "searchTracks",
    operation: "query",
    sha256Hash: "59ee4a659c32e9ad894a71308207594a65ba67bb6b632b183abe97303a51fa55",
    value: null
  };
  // ponytail: si Spotify ya cargó su propia definición (al visitar Buscar) usamos esa, que trae
  // el hash vigente; si no, la guardada. Cuando Spotify cambie el hash, actualizar la constante.
  const searchTracksDef = () => Spicetify.GraphQL?.Definitions?.searchTracks || PERSISTED_SEARCH_TRACKS;

  // --------------------------------------------------------------------------
  // PASO 3: Gestión de Configuración Local
  // --------------------------------------------------------------------------
  const STORAGE_KEYS = {
    PRIMARY_PROVIDER: "mood_ai_primary_provider",
    CUSTOM_BASE_URL: "mood_ai_custom_base_url",
    CURATION_MODE: "mood_ai_curation_mode",
    TRACK_TYPE: "mood_ai_track_type",
    TRACK_COUNT: "mood_ai_track_count",
    EXCLUDE_LIBRARY: "mood_ai_exclude_library"
  };

  // Historial de playlists creadas: uri → { prompt, understood, count, date }. Sirve para
  // "Mostrar prompt de la lista" con el texto completo (el nombre de la playlist va recortado).
  // ponytail: últimas 100 en localStorage de este equipo; la descripción de la playlist es la copia que viaja.
  const History = {
    KEY: "vibemusic_history",
    all() { try { return JSON.parse(localStorage.getItem(this.KEY)) || {}; } catch { return {}; } },
    get(uri) { return this.all()[uri] || null; },
    save(uri, entry) {
      const all = this.all();
      all[uri] = entry;
      const uris = Object.keys(all).sort((a, b) => (all[b].date || 0) - (all[a].date || 0)).slice(0, 100);
      localStorage.setItem(this.KEY, JSON.stringify(Object.fromEntries(uris.map(u => [u, all[u]]))));
    }
  };

  const Config = {
    // Claves por proveedor: mood_ai_<id>_api_key / mood_ai_<id>_model (compatibles con las antiguas de Groq y OpenRouter).
    getKey: (id) => localStorage.getItem(`mood_ai_${id}_api_key`) || "",
    setKey: (id, val) => localStorage.setItem(`mood_ai_${id}_api_key`, String(val).trim()),
    getModel: (id) => localStorage.getItem(`mood_ai_${id}_model`) || PROVIDERS[id].defaultModel,
    setModel: (id, val) => localStorage.setItem(`mood_ai_${id}_model`, String(val).trim()),
    getBaseUrl: (id) => id === "custom"
      ? (localStorage.getItem(STORAGE_KEYS.CUSTOM_BASE_URL) || "").trim().replace(/\/+$/, "")
      : PROVIDERS[id].base,
    setCustomBaseUrl: (val) => localStorage.setItem(STORAGE_KEYS.CUSTOM_BASE_URL, String(val).trim()),
    getLastPrompt: () => localStorage.getItem("vibemusic_last_prompt") || "",
    setLastPrompt: (val) => localStorage.setItem("vibemusic_last_prompt", String(val).slice(0, 500)),
    // Principal por defecto: Gemini (mejor conocimiento musical). Respaldo en el orden de PROVIDERS:
    // Gemini → Groq → OpenRouter → Personalizado.
    getPrimary: () => localStorage.getItem(STORAGE_KEYS.PRIMARY_PROVIDER) || "gemini",
    setPrimary: (val) => localStorage.setItem(STORAGE_KEYS.PRIMARY_PROVIDER, val),
    // "custom" basta con URL (Ollama local no usa clave); el resto necesita clave.
    isConfigured: (id) => id === "custom" ? !!Config.getBaseUrl("custom") && !!Config.getModel("custom") : !!Config.getKey(id),
    anyConfigured: () => Object.keys(PROVIDERS).some(id => Config.isConfigured(id)),

    getCurationMode: () => localStorage.getItem(STORAGE_KEYS.CURATION_MODE) || "deep_cuts",
    setCurationMode: (val) => localStorage.setItem(STORAGE_KEYS.CURATION_MODE, val),

    getTrackType: () => localStorage.getItem(STORAGE_KEYS.TRACK_TYPE) || "auto",
    setTrackType: (val) => localStorage.setItem(STORAGE_KEYS.TRACK_TYPE, val),

    getTrackCount: () => {
      const n = parseInt(localStorage.getItem(STORAGE_KEYS.TRACK_COUNT), 10);
      return n >= 1 && n <= MAX_TRACKS ? n : 10;
    },
    setTrackCount: (val) => localStorage.setItem(STORAGE_KEYS.TRACK_COUNT, String(val)),

    getExcludeLibrary: () => localStorage.getItem(STORAGE_KEYS.EXCLUDE_LIBRARY) === "1",
    setExcludeLibrary: (on) => localStorage.setItem(STORAGE_KEYS.EXCLUDE_LIBRARY, on ? "1" : "0"),

    // Última ejecución ("¿Retocar tu última playlist?") persistida para que no se pierda al recargar Spotify.
    getLastRun: () => {
      try {
        const obj = JSON.parse(localStorage.getItem("vibemusic_last_run"));
        if (!obj || typeof obj.text !== "string" || !Array.isArray(obj.tracks) || obj.tracks.length === 0) return null;
        return obj;
      } catch { return null; }
    },
    setLastRun: (run) => {
      if (!run || !run.text || !Array.isArray(run.tracks)) return;
      const clean = {
        text: String(run.text).slice(0, 500),
        name: String(run.name || "").slice(0, 100),
        tracks: run.tracks.slice(0, 30).map(t => ({ name: String(t.name || ""), artist: String(t.artist || "") }))
      };
      localStorage.setItem("vibemusic_last_run", JSON.stringify(clean));
    },
  };

  // --------------------------------------------------------------------------
  // PARSER ROBUSTO: Normalizador universal de respuestas JSON de la IA
  // --------------------------------------------------------------------------
  function parseJSON(content) {
    let text = typeof content === "string" ? content.trim() : JSON.stringify(content);
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(); // modelos que "piensan en voz alta"
    if (text.startsWith("```")) {
      text = text.replace(/^```(json)?\n?/, "").replace(/\n?```$/, "").trim();
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      // Algunos modelos envuelven el JSON en texto ("Aquí tienes: {...}"): probamos con el bloque
      // que va del primer { o [ al último } o ] (caso real: OpenRouter/ernie devolvía 0 elecciones).
      const start = text.search(/[\[{]/);
      const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
      if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
      throw err;
    }
  }

  // Segundos que hay que dejar descansar a un proveedor tras un error, o 0 si no es de límite.
  // Groq dice "Please try again in 12.495s"; Gemini solo da HTTP 429.
  function cooldownSeconds(err) {
    const msg = String(err?.message || "");
    if (err?.status !== 429 && !/rate limit|too many requests|\b429\b|resource.?exhausted/i.test(msg)) return 0;
    const m = msg.match(/(?:try again|retry) in ([\d.]+)\s*s/i);
    return m ? Math.ceil(parseFloat(m[1])) + 1 : 60;
  }

  function parseLLMResponse(content) {
    let parsed;
    try {
      parsed = parseJSON(content);
    } catch (e) {
      console.error("[Vibemusic] Error al parsear JSON de la IA:", content, e);
      throw new Error("La IA no devolvió un JSON legible. Intenta de nuevo.");
    }

    let items = [];
    if (Array.isArray(parsed)) {
      items = parsed;
    } else if (typeof parsed === "object" && parsed !== null) {
      const arrayKey = Object.keys(parsed).find(k => Array.isArray(parsed[k]));
      if (arrayKey) {
        items = parsed[arrayKey];
      } else {
        items = [parsed];
      }
    }

    return items.map(item => {
      if (typeof item === "string") {
        const parts = item.split(" - ");
        return {
          title: parts.length > 1 ? parts[1].trim() : item.trim(),
          artist: parts.length > 1 ? parts[0].trim() : "",
          vibe_match: "Recomendación curada"
        };
      }
      return {
        title: item.title || item.song || item.track || item.name || "",
        artist: item.artist || item.singer || item.band || item.author || "",
        vibe_match: item.vibe_match || item.vibe || item.reason || item.description || "Recomendada para ti",
        year: parseInt(item.year || item.release_year, 10) || null,
        instrumental: typeof item.instrumental === "boolean" ? item.instrumental : null,
        language: typeof item.language === "string" ? item.language.toLowerCase().slice(0, 2) : null
      };
    }).filter(t => t.title && t.title.trim().length > 0);
  }

  // --------------------------------------------------------------------------
  // PASO 4: Cerebro IA Avanzado (Curaduría fina, Deep Cuts y temperatura alta)
  // --------------------------------------------------------------------------
  const INTENT_PROMPT = `Analiza la petición musical del usuario y extrae lo que quiere. Responde SOLO con este JSON:
{
  "count": número de canciones pedido o null si no lo dice (acepta números escritos: "diez" = 10),
  "genre": "género y subgénero en pocas palabras, p. ej. 'jazz modal', 'synthwave', 'hip hop boom bap'",
  "instrumental": true si quiere pistas sin voz (instrumentales, beats, música de fondo para concentrarse o estudiar sin letra), false si quiere canciones con voz, null si no queda claro,
  "language": código ISO de 2 letras del idioma de las letras SOLO si el usuario pide explícitamente un idioma o gentilicio en su texto (p. ej. "es" para "rap en español" o "indie español"), o null si no menciona idioma. NUNCA deduzcas el idioma por el nombre o apellido del artista,
  "era": {"from": año, "to": año} si menciona época o década, o null,
  "mood": "energía/ambiente en pocas palabras, p. ej. 'agresivo, con pegada'",
  "purpose": "para qué la quiere, o null",
  "include_artists": ["artistas o productores que pide como referencia"],
  "only_artists": true SOLO si quiere canciones exclusivamente de los artistas citados ("10 de Bonobo", "solo Radiohead"); false si los cita como referencia de estilo ("tipo Bonobo", "como Tycho"),
  "exclude_artists": ["artistas que rechaza"],
  "search_queries": ["4-6 búsquedas cortas (2-4 palabras) para el buscador de Spotify que devuelvan canciones que encajen: subgénero + palabra clave, artistas o productores de referencia, nombres de álbumes. NUNCA añadas un idioma o país que el usuario no haya escrito. Si quiere instrumentales, prioriza álbumes instrumentales y artistas conocidos por música sin voz del género (p. ej. 'post rock instrumental', 'Nujabes', 'jazz piano trio') en vez de canciones con voz"],
  "summary": "título corto y natural para la playlist (3-8 palabras en español, sin coletillas técnicas como 'con voz' o 'idioma X'), p. ej. 'Clásicos de rock de los 90' o 'Indie rock español 2000s'"
}
No inventes restricciones que el usuario no haya expresado.`;

  // Restricciones duras comunes a los dos modos (elegir del pool o proponer títulos).
  function constraintRules(req) {
    const rules = [];
    if (req.genre) rules.push(`- Género: ${req.genre}. Nada de otros géneros.`);
    if (req.range) rules.push(`- Época: publicadas originalmente entre ${req.range.from} y ${req.range.to}.`);
    if (req.instrumental === true) rules.push(
      "- SOLO pistas SIN VOZ. Prioriza obras instrumentales originales (álbumes instrumentales, bandas sonoras, artistas instrumentales del género) frente a versiones instrumentales de canciones con voz.",
      "- PROHIBIDO cualquier canción con rap o voz cantada. Marca \"instrumental\": true solo si lo es de verdad."
    );
    if (req.instrumental === false) rules.push("- Solo canciones con voz.");
    if (req.language) rules.push(`- Idioma de las letras: ${req.language}.`);
    if (req.mood) rules.push(`- Energía/ambiente: ${req.mood}.`);
    if (req.purpose) rules.push(`- Uso: ${req.purpose}.`);
    if (req.includeArtists.length) rules.push(`- Referencias: ${req.includeArtists.join(", ")}.`);
    if (req.excludeArtists.length) rules.push(`- Excluir: ${req.excludeArtists.join(", ")}.`);
    return rules;
  }

  function curationInstruction() {
    return {
      deep_cuts: "- Curaduría: evita los 3-4 clichés más trillados del estilo; prioriza temas de culto y de alta reputación para oyentes exigentes.",
      balanced: "- Curaduría: mezcla un par de clásicos consagrados con joyas menos conocidas de gran calidad.",
      classics: "- Curaduría: selecciona los temas más icónicos e influyentes del estilo."
    }[Config.getCurationMode()] || "";
  }

  const AIService = {
    // Paso 1: entender la petición en lenguaje natural (temperatura 0 = determinista).
    async parseIntent(moodText, signal) {
      try {
        return parseJSON(await this.chat(INTENT_PROMPT, moodText, 0, 2048, true, signal)); // true = modo rápido
      } catch (err) {
        if (err?.name === "AbortError" && signal?.aborted) throw err;
        console.warn("[Vibemusic] No se pudo interpretar la petición; uso detección local.", err);
        return null;
      }
    },

    // Grounding: la IA elige índices de una lista de pistas que existen en Spotify.
    async pickFromPool(moodText, req, pool, context = "", signal) {
      const rules = constraintRules(req);
      if (req.instrumental === true) rules.push(
        "- Pista instrumental probable: el título dice \"Instrumental\" o el álbum es una obra instrumental. Descarta las que sepas que llevan voz."
      );
      const systemPrompt = `Eres un selector musical de élite. Te doy una lista NUMERADA de pistas que existen en Spotify.
Elige hasta ${Match.askFor(req.count)} que cumplan TODAS las restricciones, ORDENADAS de mejor a peor (usaremos las ${req.count} primeras válidas; el resto son reservas por si alguna se descarta). Si no hay suficientes que cumplan, devuelve menos: nunca rellenes con pistas que las incumplan.
Prefiere artistas y lanzamientos reconocidos del estilo. Evita pistas genéricas de catálogo cuyo título es una lista de palabras clave ("Type Beat", "Instrumental Mix", "Base de Rap...").
${req.allowVersions ? "" : "Prefiere las versiones originales de estudio: evita demo, acústica, directo, remix o covers.\n"}${req.onlyArtists ? "" : `Variedad: como mucho ${Match.artistCap(req)} canciones del mismo artista.`}

RESTRICCIONES OBLIGATORIAS:
${rules.join("\n") || "- Respeta lo que pide el usuario."}

${curationInstruction()}

Responde ÚNICAMENTE con este JSON (i = número de la lista):
{"picks": [{"i": 0, "year": 2004, "instrumental": true}]}
("year" = año de publicación ORIGINAL de la canción, no del recopilatorio o remaster).`;
      const userPrompt = `Petición original: "${moodText}"\n${context ? context + "\n" : ""}\nLista:\n${Match.compactCandidateList(pool)}`;
      return Match.parsePicks(await this.chat(systemPrompt, userPrompt, 0.3, 2048, false, signal), pool.length);
    },

    // Respaldo y relleno: pedir títulos con las restricciones ya resueltas.
    // `exclude` = "título — artista" ya probados; `context` = versión anterior al ajustar.
    async getRecommendations(moodText, req, askFor, exclude = [], context = "", signal) {
      const rules = constraintRules(req);
      if (req.instrumental === true) rules.push(
        "- Evita las versiones \"(Instrumental)\" de canciones con voz: muchas no existen en Spotify. Úsalas solo si sabes que están publicadas, y entonces el título DEBE incluir \"(Instrumental)\" tal como aparece en Spotify."
      );
      if (exclude.length) rules.push(`- NO repitas ninguna de estas (ya probadas): ${exclude.slice(-60).join("; ")}.`);

      const systemPrompt = `Eres un selector musical de élite con conocimiento profundo de todos los géneros.
Arma una lista de ${askFor} canciones reales que existan en Spotify.

RESTRICCIONES OBLIGATORIAS (por encima de todo; mejor devolver menos que incumplirlas):
${rules.join("\n") || "- Respeta lo que pide el usuario."}
- Usa el título y el artista principal exactos tal como aparecen en Spotify.

${curationInstruction()}

Responde ÚNICAMENTE con este JSON:
{
  "recommendations": [
    {
      "title": "Nombre exacto",
      "artist": "Artista o productor principal",
      "year": 1996,
      "instrumental": true,
      "language": "en",
      "vibe_match": "Breve frase en español de por qué encaja"
    }
  ]
}`;

      const userPrompt = `Petición original: "${moodText}"\n${context ? context + "\n" : ""}Recomiéndame ${askFor} canciones.`;
      // ~80 tokens por canción + margen para razonar; menos tokens reservados = menos 429 por minuto.
      return parseLLMResponse(await this.chat(systemPrompt, userPrompt, 0.7, Math.min(4096, 800 + askFor * 80), false, signal));
    },

    // Prueba el proveedor principal y, si falla, los demás configurados. Devuelve el texto.
    // maxTokens: tope de la respuesta. Sin él, OpenRouter reserva el máximo del modelo (32 768)
    // contra el saldo y rechaza la petición aunque la respuesta real sea corta (prueba E2E 2026-11-14).
    // ponytail: 2048-4096 deja margen a modelos que "razonan" (gpt-oss) y cabe en saldos pequeños.
    async chat(systemPrompt, userPrompt, temperature, maxTokens = 2048, fast = false, signal) {
      const chain = providerChain(Config.getPrimary(), Config.isConfigured);
      if (chain.length === 0) {
        throw new Error("No has configurado ningún proveedor de IA. Ve a '⚙️ Ajustes de API'.");
      }
      // Disyuntor (circuit breaker): un proveedor que acaba de dar 429 se salta hasta que pase su
      // descanso, en vez de perder tiempo fallando en cada llamada. Si todos descansan, se prueban igual.
      const resting = id => (this.cooldownUntil[id] || 0) > Date.now();
      const usable = chain.filter(id => !resting(id));
      const errors = [];
      for (const id of (usable.length ? usable : chain)) {
        if (signal?.aborted) throw new DOMException("Cancelado", "AbortError");
        const p = PROVIDERS[id];
        const call = jsonMode => this.callProvider(
          `${Config.getBaseUrl(id)}/chat/completions`, Config.getKey(id), Config.getModel(id),
          systemPrompt, userPrompt, temperature, p.headers || {}, jsonMode, maxTokens,
          (fast && p.fastBody) || p.extraBody, signal);
        try {
          try {
            const t0 = performance.now();
            const out = await call(p.jsonMode);
            console.log(`[Vibemusic] ✓ ${p.label} respondió en ${((performance.now() - t0) / 1000).toFixed(1)} s`);
            return out;
          } catch (err) {
            if (err?.name === "AbortError" && signal?.aborted) throw err;
            // Groq con gpt-oss a veces rechaza su propia salida en modo JSON: 1 reintento sin ese modo.
            if (p.jsonMode && /failed to validate json|json_validate_failed/i.test(err.message)) return await call(false);
            throw err;
          }
        } catch (err) {
          if (err?.name === "AbortError" && signal?.aborted) throw err;
          const rest = cooldownSeconds(err);
          if (rest) this.cooldownUntil[id] = Date.now() + rest * 1000;
          console.warn(`[Vibemusic] Falló ${p.label}${rest ? ` (descansa ${rest} s)` : ""}:`, err);
          // Los proveedores retiran modelos (p. ej. Groq retiró llama-3.3-70b-versatile): decirlo claro.
          const gone = /does not exist|not found|decommission|no longer|model_not_found/i.test(err.message);
          const broke = /credits|quota|insufficient|billing|exceeded/i.test(err.message);
          errors.push(gone
            ? `${p.label}: el modelo «${Config.getModel(id)}» ya no existe o no tienes acceso; elige otro en ⚙️ Ajustes`
            : broke
              ? `${p.label}: sin saldo o cuota para «${Config.getModel(id)}»; elige un modelo gratuito (🆓) o espera a que se renueve la cuota`
              : `${p.label}: ${err.message}`);
        }
      }
      throw new Error(errors.join(" · "));
    },

    cooldownUntil: {}, // id de proveedor → instante (ms) hasta el que no se usa tras un 429

    // Lista de modelos de un proveedor (endpoint /models de la API compatible con OpenAI).
    async fetchModels(baseUrl, apiKey) {
      const headers = apiKey ? { "Authorization": `Bearer ${apiKey}` } : {};
      // 15 s como máximo: una URL mal escrita no debe dejar el desplegable "Cargando..." para siempre.
      const response = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseModelList(await response.json());   // (solo devuelve ids de modelos; nunca la clave)
    },

    async callProvider(url, apiKey, model, systemPrompt, userPrompt, temperature, extraHeaders, jsonMode, maxTokens = 2048, extraBody = {}, signal) {
      const body = {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature,
        max_tokens: maxTokens,
        ...extraBody // parámetros propios de un proveedor (p. ej. reasoning_effort en Gemini)
      };
      if (jsonMode) body.response_format = { type: "json_object" };

      // 45 s como máximo (en vivo, gemini-3.8-flash se quedaba "pensando" más de 25 s sin responder).
      // Si el usuario pulsa "⏹ Cancelar", signal aborta al instante.
      const timeoutSig = AbortSignal.timeout(45000);
      const combinedSig = signal && AbortSignal.any ? AbortSignal.any([timeoutSig, signal]) : (signal || timeoutSig);
      let response;
      try {
        response = await fetch(url, {
        signal: combinedSig,
        method: "POST",
        headers: {
          ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
          "Content-Type": "application/json",
          ...extraHeaders
        },
        body: JSON.stringify(body)
        });
      } catch (err) {
        if (signal?.aborted) throw new DOMException("Cancelado", "AbortError");
        if (err?.name === "TimeoutError") throw new Error("no respondió en 45 s (prueba otro modelo más rápido)");
        throw new Error(`sin conexión con el proveedor (${Match.redactSecrets(err?.message || err)})`);
      }
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const info = Array.isArray(errorData) ? errorData[0] : errorData; // Gemini responde [ { error } ]
        const err = new Error(Match.redactSecrets(info?.error?.message || `Error HTTP ${response.status}`));
        err.status = response.status; // el disyuntor necesita saber si fue un 429
        throw err;
      }
      const data = await response.json();
      return data.choices[0].message.content;
    }
  };

  // --------------------------------------------------------------------------
  // PASO 5: Búsqueda Nativa Robusta con GraphQL + Creación y Redirección
  // --------------------------------------------------------------------------
  const SpotifyService = {
    cleanSearchTerm(term) {
      if (!term) return "";
      return term
        .replace(/\(.*?\)/g, "")
        .replace(/\[.*?\]/g, "")
        .replace(/["'’]/g, "")
        .replace(/\bfeat\b\.?.*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
    },

    // Convierte la respuesta GraphQL en candidatos {uri, name, artists[], album, coverUrl}
    extractCandidates(gqlRes) {
      const items =
        gqlRes?.data?.searchV2?.tracksV2?.items ||
        gqlRes?.data?.searchV2?.topResultsV2?.items ||
        [];
      return items.map(it => {
        const d = it?.item?.data || it?.data || it;
        return {
          uri: d?.uri,
          name: d?.name || "",
          artists: d?.artists?.items?.map(a => a.profile?.name || a.name).filter(Boolean) || [],
          album: d?.albumOfTrack?.name || d?.album?.name || "",
          coverUrl: d?.albumOfTrack?.coverArt?.sources?.[0]?.url || d?.album?.images?.[0]?.url || ""
        };
      }).filter(c => c.uri && c.uri.startsWith("spotify:track:"));
    },

    // Busca varias opciones y elige la que mejor coincide en título y artista.
    // Devuelve null si ninguna es compatible (nunca toma el primer resultado a ciegas).
    async findTrack(title, artist, instrumental = null) {
      if (!Spicetify.GraphQL?.Request) return null;
      const wanted = { title, artist, instrumental };
      // cleanSearchTerm borra "(Instrumental)"; lo devolvemos a la consulta para no traer la versión con voz.
      const instTag = /instrumental/i.test(title) ? " instrumental" : "";
      const cleanTitle = this.cleanSearchTerm(title) + instTag;
      const query = `${this.cleanSearchTerm(title)} ${this.cleanSearchTerm(artist)}${instTag}`.trim();

      const attempts = [
        [searchTracksDef(), { searchTerm: query, offset: 0, limit: 10, numberOfTopResults: 5, includePreReleases: false, includeAlbumPreReleases: false }],
        [searchTracksDef(), { searchTerm: cleanTitle, offset: 0, limit: 10, numberOfTopResults: 5, includePreReleases: false, includeAlbumPreReleases: false }]
      ];

      for (const [def, vars] of attempts) {
        try {
          const best = Match.pickBest(wanted, this.extractCandidates(await Spicetify.GraphQL.Request(def, vars)));
          if (best) {
            console.log(`[Vibemusic] ✅ ${best.name} — ${best.artists.join(", ")} (score ${best.score.toFixed(2)})`);
            return { uri: best.uri, name: best.name, artist: best.artists.join(", "), coverUrl: best.coverUrl };
          }
        } catch (err) {
          console.warn(`[Vibemusic] Error en ${def.name}:`, err);
        }
      }
      console.log(`[Vibemusic] ❌ Sin coincidencia fiable para "${title}" — ${artist}`);
      return null;
    },

    // Grounding: lanza varias búsquedas y junta las candidatas reales (sin repetir).
    async searchPool(queries) {
      if (!Spicetify.GraphQL?.Request) return [];
      // Todas las búsquedas a la vez (antes, una tras otra: 4,2 s → ~1 s medido en vivo).
      // ponytail: 6 consultas simultáneas como máximo; si Spotify limita, hacer lotes de 3.
      const results = await Promise.all(queries.map(async q => {
        try {
          // 20 por consulta (6 consultas ≈ 120 candidatas); el tope real lo pone Match.filterPool.
          const res = await Spicetify.GraphQL.Request(searchTracksDef(),
            { searchTerm: q, offset: 0, limit: 20, numberOfTopResults: 5, includePreReleases: false, includeAlbumPreReleases: false });
          return this.extractCandidates(res);
        } catch (err) {
          console.warn(`[Vibemusic] Error buscando "${q}":`, err);
          return [];
        }
      }));
      // flat() mantiene el orden de las consultas: las primeras (más concretas) siguen delante.
      return Match.dedupeCandidates(results.flat());
    },

    // URIs que ya están en la biblioteca del usuario (Me gusta / guardadas).
    // API interna verificada en vivo (2026-11-14): LibraryAPI.contains(...uris) → Promise<boolean[]>, uno por URI.
    // Si falta o falla, se trata todo como "no está en la biblioteca" (no se excluye nada).
    async inLibrary(uris) {
      const api = Spicetify.Platform?.LibraryAPI;
      const owned = new Set();
      if (!api?.contains || uris.length === 0) return owned;
      // ponytail: lotes de 50 por si la API tiene límite; sin medir.
      for (let k = 0; k < uris.length; k += 50) {
        const batch = uris.slice(k, k + 50);
        try {
          const flags = await api.contains(...batch);
          batch.forEach((u, j) => { if (Array.isArray(flags) && flags[j] === true) owned.add(u); });
        } catch (err) {
          console.warn("[Vibemusic] LibraryAPI.contains falló; no se excluye nada.", err);
          return owned;
        }
      }
      return owned;
    },

    // Nombre y artistas de una canción o playlist para "Más como esto".
    // Verificado en vivo (2026-11-14): GraphQL getTrack y PlaylistAPI.getMetadata/getContents funcionan.
    // Cada intento va protegido y se pasa al siguiente.
    async describeUri(uri) {
      const kind = Match.uriKind(uri);
      const names = items => (items || []).map(a => a?.profile?.name || a?.name).filter(Boolean);
      if (kind === "track") {
        // 1. GraphQL getTrack (definición que trae Spicetify; puede no existir).
        try {
          const def = Spicetify.GraphQL?.Definitions?.getTrack;
          const t = def && (await Spicetify.GraphQL.Request(def, { uri }))?.data?.trackUnion;
          if (t?.name) return { kind, name: t.name, artists: [...names(t.firstArtist?.items), ...names(t.otherArtists?.items)] };
        } catch (err) { console.warn("[Vibemusic] getTrack falló:", err); }
        // 2. La canción que está sonando, si es la misma.
        const cur = Spicetify.Player?.data?.item;
        if (cur?.uri === uri && cur.name) return { kind, name: cur.name, artists: names(cur.artists) };
        // (La Web API /v1/tracks vía CosmosAsync se retiró: en vivo devolvía {} vacío.)
        return null;
      }
      if (kind === "playlist") {
        const api = Spicetify.Platform?.PlaylistAPI;
        let name = "", samples = [];
        try { name = (await api?.getMetadata?.(uri))?.name || ""; } catch (err) { console.warn("[Vibemusic] getMetadata falló:", err); }
        try {
          // limit 5: solo necesitamos una muestra, no descargar la playlist entera.
          const items = (await api?.getContents?.(uri, { limit: 5 }))?.items || [];
          samples = items.slice(0, 5).map(i => `${i.name} — ${names(i.artists).join(", ")}`).filter(x => !x.startsWith("undefined"));
        } catch (err) { console.warn("[Vibemusic] getContents falló:", err); }
        return name ? { kind, name, samples } : null;
      }
      return null;
    },

    // Crear la playlist real, iniciar reproducción y redirigir
    async produceAndNavigatePlaylist(promptText, trackObjects) {
      if (!trackObjects || trackObjects.length === 0) {
        throw new Error("No hay canciones para crear la playlist.");
      }

      const trackUris = trackObjects.map(t => t.uri);
      const playlistName = Match.playlistName(promptText);

      console.log(`[Vibemusic] 🛠️ Creando playlist "${playlistName}" con ${trackUris.length} canciones...`);

      const P = Spicetify.Platform;
      let createdUri = null;

      // 1. Crear (verificado en vivo 2026-11-14). Se retiraron los respaldos por Web API/CosmosAsync:
      //    desde el cliente no funcionaban y podían dejar playlists duplicadas.
      try {
        createdUri = await P?.RootlistAPI?.createPlaylist?.(playlistName, { before: "start" });
      } catch (err) {
        console.warn("[Vibemusic] Falló la creación de la playlist:", err);
      }

      if (createdUri) {
        // 2. PRIVADA antes de añadir nada: por defecto Spotify las publicaba en el perfil y el nombre y
        //    la descripción llevan el prompt del usuario. Verificado en vivo: publishedState=false
        //    + basePermission "BLOCKED" → isPrivate: true.
        let isPrivate = false;
        try {
          await P.RootlistAPI.setPublishedState(createdUri, false);
          await P.PlaylistPermissionsAPI.setBasePermission(createdUri, "BLOCKED");
          isPrivate = true;
        } catch (err) {
          console.warn("[Vibemusic] No se pudo hacer privada la playlist:", err);
        }

        // 3. Añadir y CONTAR lo que hay de verdad (antes se suponía: "Añadidas" = enviadas).
        let addError = null, added = 0;
        try { await P.PlaylistAPI.add(createdUri, trackUris, { before: "start" }); }
        catch (err) { addError = err; console.warn("[Vibemusic] Falló añadir canciones:", err); }
        try { added = (await P.PlaylistAPI.getContents(createdUri, { limit: 1 }))?.totalLength ?? 0; }
        catch (err) { added = addError ? 0 : trackUris.length; } // si no se puede contar, lo más probable

        if (added === 0) {
          throw new Error(`Spotify creó la playlist «${playlistName}» pero no aceptó las canciones` +
            `${addError ? ` (${addError.message || addError})` : ""}. Puedes borrarla desde tu biblioteca.`);
        }
        console.log(`[Vibemusic] 🚀 Playlist ${createdUri}: ${added}/${trackUris.length} añadidas · privada: ${isPrivate}`);

        // 4. Ir a la playlist y reproducirla
        const playlistId = createdUri.replace("spotify:playlist:", "");
        if (P?.History?.push) P.History.push(`/playlist/${playlistId}`);
        else window.location.hash = `/playlist/${playlistId}`;
        try {
          await Spicetify.Player.playUri(createdUri);
        } catch (playErr) {
          try { await Spicetify.Player.playUri(trackUris[0]); } catch {}
        }
        return { mode: "playlist", name: playlistName, uri: createdUri, added, isPrivate };
      }

      // Si no se pudo crear el recurso, reproducir y encolar inmediatamente
      await Spicetify.Player.playUri(trackUris[0]);
      for (let i = 1; i < trackUris.length; i++) {
        if (Spicetify.addToQueue) {
          await Spicetify.addToQueue([{ uri: trackUris[i] }]);
        }
      }

      if (Spicetify.Platform?.History?.push) {
        Spicetify.Platform.History.push("/queue");
      }

      return { mode: "queue", name: "la cola", added: trackUris.length, isPrivate: null };
    }
  };

  // --------------------------------------------------------------------------
  // PASO 5b: De la petición a la lista de pistas
  //   1. Grounding: buscar candidatas reales en Spotify y que la IA elija entre ellas.
  //   2. Respaldo: si el pool es pequeño, la IA propone títulos y se buscan uno a uno.
  //   3. Relleno: si faltan, hasta 2 rondas más excluyendo todo lo ya probado.
  // --------------------------------------------------------------------------
  const REFILL_ROUNDS = 2;

  async function buildTrackList(text, ui, status, context = "", signal) {
    const checkAbort = () => { if (signal?.aborted) throw new DOMException("Cancelado", "AbortError"); };
    // Cronómetro por fases: cada lap() imprime cuánto tardó la fase anterior y el total.
    const tStart = performance.now(); let tLast = tStart;
    const lap = label => {
      const now = performance.now();
      console.log(`[Vibemusic] ⏱️ ${label}: ${((now - tLast) / 1000).toFixed(1)} s (total ${((now - tStart) / 1000).toFixed(1)} s)`);
      tLast = now;
    };
    const intent = await AIService.parseIntent(text, signal);
    checkAbort();
    lap("interpretar petición (IA)");
    const req = Match.resolveRequest(text, intent, ui);
    const understood = `Entendido: ${Match.describe(req)}`;
    console.log("[Vibemusic] Intención:", intent, "→", req);

    const found = [], rejected = [];
    const usedUris = new Set();                 // encontradas o descartadas: no se vuelven a ofrecer
    const tried = new Set(), triedLabels = [];  // títulos ya pedidos, para el prompt de relleno
    const markTried = (title, artist) => {
      tried.add(Match.trackKey(title, artist));
      triedLabels.push(`${title} — ${artist}`);
    };
    const owned = async uris => ui.excludeLibrary ? SpotifyService.inLibrary(uris) : new Set();
    const perArtist = new Map(), cap = Match.artistCap(req);
    // Misma canción por otro intérprete ("Desafinado" de Jobim y de Getz) solo si se piden versiones.
    const titles = new Set();
    const repeatedSong = name => !req.allowVersions && titles.has(Match.normalize(name));
    // true si ese artista ya llegó al máximo (y entonces no se añade)
    const overCap = artist => (perArtist.get(Match.mainArtist(artist)) || 0) >= cap;
    const countArtist = artist => perArtist.set(Match.mainArtist(artist), (perArtist.get(Match.mainArtist(artist)) || 0) + 1);

    // 1. Grounding
    status(`🎧 ${understood}\n🗂️ Buscando candidatas reales en el catálogo de Spotify...`);
    let pool = Match.filterPool(await SpotifyService.searchPool(Match.buildSearchQueries(req)), req);
    checkAbort();
    const inLib = await owned(pool.map(c => c.uri));
    checkAbort();
    pool = pool.filter(c => !inLib.has(c.uri));
    lap(`buscar candidatas en Spotify (${pool.length})`);
    let grounded = false;
    // ponytail: umbral = cantidad pedida; con menos, la IA no tiene de dónde elegir y usamos títulos.
    if (pool.length >= req.count) {
      status(`🎧 ${understood}\n🎯 La IA elige entre ${pool.length} pistas reales...`);
      try {
        const picks = await AIService.pickFromPool(text, req, pool, context, signal);
        checkAbort();
        lap("elegir del pool (IA)");
        grounded = picks.length > 0;
        console.log(`[Vibemusic] La IA eligió ${picks.length} índices del pool de ${pool.length}`);
        for (const p of picks) {
          if (found.length >= req.count) break;
          const c = pool[p.i];
          const artist = c.artists.join(", ");
          markTried(c.name, artist);
          usedUris.add(c.uri);
          if (req.instrumental === true && p.instrumental === false) {
            rejected.push({ title: c.name, artist, reason: "tiene voz (según la IA)" }); continue;
          }
          if (req.instrumental === false && p.instrumental === true) {
            rejected.push({ title: c.name, artist, reason: "es instrumental (según la IA)" }); continue;
          }
          // Caso real (Groq): pedido 2000-2009 y eligió Arde Bogotá (2023). El pool no trae año, así que
          // la IA lo declara y aquí se comprueba, igual que con los títulos de las rondas de relleno.
          if (req.range && p.year && (p.year < req.range.from || p.year > req.range.to)) {
            rejected.push({ title: c.name, artist, reason: `fuera de época (${p.year})` }); continue;
          }
          if (overCap(artist)) { rejected.push({ title: c.name, artist, reason: "demasiadas del mismo artista" }); continue; }
          if (repeatedSong(c.name)) { rejected.push({ title: c.name, artist, reason: "canción repetida (otra versión)" }); continue; }
          countArtist(artist);
          titles.add(Match.normalize(c.name));
          found.push({ uri: c.uri, name: c.name, artist, coverUrl: c.coverUrl });
        }
      } catch (err) {
        if (err?.name === "AbortError" && signal?.aborted) throw err;
        console.warn("[Vibemusic] Grounding falló; uso la búsqueda por títulos.", err);
      }
    }
    console.log(`[Vibemusic] Grounding: pool ${pool.length}, elegidas ${found.length}/${req.count}`);

    // 2 y 3. Títulos propuestos por la IA (respaldo) + rondas de relleno.
    const maxRounds = grounded ? REFILL_ROUNDS : 1 + REFILL_ROUNDS;
    for (let round = 0; found.length < req.count && round < maxRounds; round++) {
      checkAbort();
      const need = req.count - found.length;
      const isRefill = grounded || round > 0;
      const refillNo = grounded ? round + 1 : round;
      status(isRefill
        ? `🎧 ${understood}\n🔁 Faltan ${need}. Pidiendo reemplazos (ronda ${refillNo}/${REFILL_ROUNDS})...`
        : `🎧 ${understood}\n🧠 Pidiendo títulos a la IA...`);

      let raw;
      try {
        raw = await AIService.getRecommendations(text, req, Match.askFor(need), triedLabels, context, signal);
        checkAbort();
        lap(`ronda ${round + 1}: pedir títulos (IA)`);
      } catch (err) {
        if (err?.name === "AbortError" && signal?.aborted) throw err;
        if (found.length === 0 && !isRefill) throw err;
        console.warn("[Vibemusic] Ronda de relleno fallida:", err);
        break;
      }
      if (!raw || raw.length === 0) {
        if (found.length === 0 && !isRefill) throw new Error("La IA no devolvió canciones. Revisa tu prompt o claves de API.");
        break;
      }

      const valid = Match.validateRecommendations(raw, req);
      const fresh = Match.dropTried(valid.kept, tried);
      rejected.push(...valid.rejected, ...fresh.rejected);
      status(`🎧 ${understood}\n🔍 Enlazando con Spotify (${found.length}/${req.count})...`);

      // Buscar en Spotify en paralelo (lotes de 4) y luego decidir en orden, como antes.
      const lookups = [];
      for (let k = 0; k < fresh.kept.length; k += 4) {
        checkAbort();
        const batch = fresh.kept.slice(k, k + 4);
        lookups.push(...await Promise.all(batch.map(it => SpotifyService.findTrack(it.title, it.artist, req.instrumental))));
      }
      checkAbort();
      for (const [idx, item] of fresh.kept.entries()) {
        if (found.length >= req.count) break;
        markTried(item.title, item.artist);
        const track = lookups[idx];
        if (!track) {
          rejected.push({ ...item, reason: "sin coincidencia fiable en Spotify" });
        } else if (usedUris.has(track.uri)) {
          rejected.push({ ...item, reason: "duplicada en Spotify" });
        } else if ((await owned([track.uri])).has(track.uri)) {
          usedUris.add(track.uri);
          rejected.push({ ...item, reason: "ya está en tu biblioteca" });
        } else if (overCap(track.artist)) {
          usedUris.add(track.uri);
          rejected.push({ ...item, reason: "demasiadas del mismo artista" });
        } else if (repeatedSong(track.name)) {
          usedUris.add(track.uri);
          rejected.push({ ...item, reason: "canción repetida (otra versión)" });
        } else {
          usedUris.add(track.uri);
          titles.add(Match.normalize(track.name));
          countArtist(track.artist);
          found.push(track);
        }
      }
    }

    lap("enlazar títulos con Spotify");
    return { req, understood, found, rejected };
  }

  // --------------------------------------------------------------------------
  // PASO 6: Interfaz Gráfica con Controles de Curaduría y Pestañas
  // --------------------------------------------------------------------------
  // Última playlist creada (se recupera de localStorage para poder retocarla aunque reinicies Spotify).
  let lastRun = Config.getLastRun();

  const UI = {
    // Ventana con el prompt completo de una playlist de Vibemusic. Todo con textContent (texto del usuario).
    showPrompt(entry) {
      const box = document.createElement("div");
      box.className = "mood-ai-container";
      const add = (tag, text, style) => {
        const el = document.createElement(tag);
        el.textContent = text;
        if (style) el.style.cssText = style;
        box.appendChild(el);
        return el;
      };
      add("div", "Prompt", "font-size:12px;font-weight:700;color:#b3b3b3;");
      add("div", entry.prompt, "white-space:pre-wrap;user-select:text;background:#242424;border:1px solid #3e3e3e;border-radius:8px;padding:12px;font-size:14px;line-height:1.5;");
      if (entry.understood) add("div", entry.understood, "font-size:12px;color:#b3b3b3;");
      const meta = [entry.count ? `${entry.count} canciones` : "", entry.date ? new Date(entry.date).toLocaleString("es-ES", { dateStyle: "long", timeStyle: "short" }) : ""].filter(Boolean).join(" · ");
      if (meta) add("div", meta, "font-size:12px;color:#888;");
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;";
      const btn = (label, onClick) => {
        const b = document.createElement("button");
        b.className = "mood-ai-btn";
        b.textContent = label;
        b.onclick = onClick;
        row.appendChild(b);
      };
      btn("📋 Copiar", async () => {
        try { await navigator.clipboard.writeText(entry.prompt); Spicetify.showNotification("📋 Prompt copiado"); }
        catch { Spicetify.showNotification("⚠️ No se pudo copiar; selecciona el texto y usa Ctrl+C", true); }
      });
      btn("🔁 Usar este prompt", () => { Spicetify.PopupModal.hide(); setTimeout(() => UI.openModal("generator", entry.prompt), 200); });
      box.appendChild(row);
      Spicetify.PopupModal.display({ title: "📝 Prompt de la lista", content: box, isLarge: false });
    },

    // Muestra resumen + descartadas como texto plano (nunca HTML: viene de la IA).
    renderReport(statusDiv, headline, rejected) {
      statusDiv.style.display = "block";
      statusDiv.style.color = "#b3b3b3";
      statusDiv.textContent = headline;
      if (rejected.length > 0) {
        const list = document.createElement("ul");
        list.style.cssText = "text-align:left;margin:8px 0 0;padding-left:18px;font-size:12px;";
        for (const r of rejected) {
          const li = document.createElement("li");
          li.textContent = `${r.title} — ${r.artist || "?"}: ${r.reason}`;
          list.appendChild(li);
        }
        statusDiv.appendChild(list);
      }
    },

    injectStyles() {
      if (document.getElementById("mood-ai-styles")) return;
      const style = document.createElement("style");
      style.id = "mood-ai-styles";
      style.textContent = `
        .mood-ai-container {
          display: flex;
          flex-direction: column;
          gap: 16px;
          color: #ffffff;
          font-family: var(--font-family, CircularSp, sans-serif);
          padding: 4px;
          width: 100%;
          box-sizing: border-box;
        }
        .mood-ai-tabs {
          display: flex;
          gap: 8px;
          border-bottom: 1px solid #282828;
          padding-bottom: 8px;
        }
        .mood-ai-tab {
          background: transparent;
          border: none;
          color: #b3b3b3;
          font-weight: 700;
          font-size: 14px;
          padding: 8px 14px;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .mood-ai-tab:hover {
          color: #ffffff;
          background: #242424;
        }
        .mood-ai-tab.active {
          color: #1db954;
          background: #181818;
          border-bottom: 2px solid #1db954;
        }
        .mood-ai-textarea {
          width: 100%;
          box-sizing: border-box;
          background: #242424;
          border: 1px solid #3e3e3e;
          border-radius: 8px;
          color: #ffffff;
          padding: 12px;
          font-size: 14px;
          resize: vertical;
          min-height: 85px;
          outline: none;
          transition: border-color 0.2s;
        }
        .mood-ai-textarea:focus {
          border-color: #1db954;
        }
        .mood-ai-options-row {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 10px;
        }
        .mood-ai-option {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0;
          font-size: 12px;
          color: #b3b3b3;
        }
        .mood-ai-select {
          background: #242424;
          border: 1px solid #3e3e3e;
          color: #ffffff;
          border-radius: 6px;
          /* Spotify fija la altura de los <select>: el padding vertical recortaba la letra.
             Altura explícita + padding solo lateral + line-height normal = texto centrado entero. */
          box-sizing: border-box;
          height: 32px;
          padding: 0 10px;
          line-height: normal;
          font-size: 12px;
          outline: none;
          cursor: pointer;
          width: 100%;
          min-width: 0;
          text-overflow: ellipsis;
        }
        .mood-ai-actions {
          display: flex;
          margin-top: 4px;
        }
        .mood-ai-btn {
          background-color: #1db954;
          color: #000000;
          border: none;
          border-radius: 20px;
          padding: 12px 24px;
          font-weight: 700;
          font-size: 14px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: transform 0.1s, background-color 0.2s;
        }
        .mood-ai-btn:hover {
          transform: scale(1.03);
          background-color: #1ed760;
        }
        .mood-ai-status {
          font-size: 13px;
          color: #b3b3b3;
          text-align: center;
          padding: 12px;
          background: #181818;
          border-radius: 8px;
          line-height: 1.5;
          white-space: pre-line;
          overflow-wrap: anywhere;
        }
        .mood-ai-status ul {
          max-height: 140px;
          overflow-y: auto;
          white-space: normal;
        }
        .mood-ai-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-bottom: 12px;
        }
        .mood-ai-field label {
          font-size: 12px;
          font-weight: 600;
          color: #b3b3b3;
        }
        .mood-ai-field .mood-ai-select {
          height: 40px;
          padding: 0 12px;
          font-size: 13px;
        }
        .mood-ai-provider {
          border: 1px solid #3e3e3e;
          border-radius: 8px;
          padding: 8px 12px;
        }
        .mood-ai-provider summary {
          cursor: pointer;
          font-weight: 700;
          font-size: 13px;
          padding: 4px 0;
        }
        .mood-ai-provider[open] summary {
          margin-bottom: 8px;
        }
        .mood-ai-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .mood-ai-chip {
          background: #242424;
          border: 1px solid #3e3e3e;
          color: #b3b3b3;
          border-radius: 999px;
          padding: 4px 10px;
          font-size: 11px;
          cursor: pointer;
        }
        .mood-ai-chip:hover {
          color: #fff;
          border-color: #1db954;
        }
        .mood-ai-hint {
          font-size: 11px;
          color: #888;
        }
        .mood-ai-check {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: #b3b3b3;
          cursor: pointer;
        }
        .mood-ai-refine {
          flex-direction: column;
          gap: 6px;
          padding: 10px 12px;
          border: 1px solid #3e3e3e;
          border-radius: 8px;
          font-size: 12px;
          color: #b3b3b3;
        }
        .mood-ai-refine-row {
          display: flex;
          gap: 8px;
        }
        .mood-ai-refine-row input {
          flex: 1;
          min-width: 0;
          background: #242424;
          border: 1px solid #3e3e3e;
          border-radius: 20px;
          color: #ffffff;
          padding: 8px 14px;
          font-size: 13px;
          outline: none;
        }
        .mood-ai-refine-row .mood-ai-btn {
          padding: 8px 16px;
          font-size: 13px;
        }
        .mood-ai-field input {
          background: #242424;
          border: 1px solid #3e3e3e;
          border-radius: 4px;
          color: #ffffff;
          padding: 10px 12px;
          font-size: 13px;
          outline: none;
        }
      `;
      document.head.appendChild(style);
    },

    // prefill: texto inicial del prompt (lo usa "Más como esto" del menú contextual).
    openModal(initialTab = "generator", prefill = "") {
      this.injectStyles();

      if (!Config.anyConfigured()) {
        initialTab = "settings";
      }

      const content = document.createElement("div");
      content.className = "mood-ai-container";

      content.innerHTML = `
        <div class="mood-ai-tabs">
          <button class="mood-ai-tab ${initialTab === 'generator' ? 'active' : ''}" id="tab-btn-generator">
            🎵 Crear Playlist
          </button>
          <button class="mood-ai-tab ${initialTab === 'settings' ? 'active' : ''}" id="tab-btn-settings">
            ⚙️ Ajustes de API
          </button>
        </div>

        <!-- VISTA 1: GENERADOR -->
        <div id="view-generator" style="display: ${initialTab === 'generator' ? 'flex' : 'none'}; flex-direction: column; gap: 12px;">
          <p style="font-size: 13px; color: #b3b3b3; margin: 0;">
            Describe tu estado de ánimo o el tipo de música. Se creará la playlist en tu Spotify y empezará a sonar:
          </p>

          <textarea 
            class="mood-ai-textarea" 
            id="mood-ai-prompt" 
            placeholder="Describe lo que quieres escuchar con tus palabras. Ctrl+Enter para crear."
          ></textarea>
          <div class="mood-ai-chips" id="mood-ai-chips"></div>
          <div class="mood-ai-chips" id="mood-ai-recent" style="display:none;align-items:center;"></div>
          <div class="mood-ai-hint" id="mood-ai-inline-msg" style="color:#e9a14a;display:none;"></div>

          <!-- Filtros -->
          <div class="mood-ai-options-row">
            <label class="mood-ai-option" title="Si el texto dice un número (p. ej. 'los 10 mejores'), manda el texto">
              Canciones
              <select class="mood-ai-select" id="mood-ai-count-select">
                ${[5, 10, 15, 20, 30].map(n => `<option value="${n}" ${Config.getTrackCount() === n ? 'selected' : ''}>${n}</option>`).join("")}
              </select>
            </label>
            <label class="mood-ai-option">
              Tipo
              <select class="mood-ai-select" id="mood-ai-type-select">
                <option value="auto" ${Config.getTrackType() === 'auto' ? 'selected' : ''}>Según el texto</option>
                <option value="instrumental" ${Config.getTrackType() === 'instrumental' ? 'selected' : ''}>🎹 Instrumentales</option>
                <option value="vocal" ${Config.getTrackType() === 'vocal' ? 'selected' : ''}>🎤 Con voz</option>
              </select>
            </label>
            <label class="mood-ai-option">
              Curaduría
              <select class="mood-ai-select" id="mood-ai-curation-select">
                <option value="deep_cuts" ${Config.getCurationMode() === 'deep_cuts' ? 'selected' : ''}>💎 Joyas ocultas</option>
                <option value="balanced" ${Config.getCurationMode() === 'balanced' ? 'selected' : ''}>⚖️ Equilibrado</option>
                <option value="classics" ${Config.getCurationMode() === 'classics' ? 'selected' : ''}>👑 Clásicos</option>
              </select>
            </label>
          </div>

          <label class="mood-ai-check" title="Comprueba cada pista contra tu biblioteca (Me gusta y guardadas)">
            <input type="checkbox" id="mood-ai-exclude-library" ${Config.getExcludeLibrary() ? 'checked' : ''} />
            Solo descubrimientos: excluir lo que ya está en mi biblioteca
          </label>

          <div class="mood-ai-actions">
            <button class="mood-ai-btn" id="mood-ai-btn-generate" style="width: 100%;">
              <span>▶</span> Crear y reproducir playlist
            </button>
          </div>

          <div id="mood-ai-status" class="mood-ai-status" style="display: none;"></div>

          <div id="mood-ai-refine" class="mood-ai-refine" style="display: none;">
            <span id="mood-ai-refine-label"></span>
            <div class="mood-ai-refine-row">
              <input type="text" id="mood-ai-refine-input" placeholder="Ej: más oscuro, sin remixes" />
              <button class="mood-ai-btn" id="mood-ai-btn-refine">Ajustar</button>
            </div>
          </div>
        </div>

        <!-- VISTA 2: AJUSTES API -->
        <div id="view-settings" style="display: ${initialTab === 'settings' ? 'flex' : 'none'}; flex-direction: column; gap: 12px;">
          <p style="font-size: 13px; color: #b3b3b3; margin: 0;">
            Configura al menos un proveedor. El texto de tu petición se envía al proveedor que uses.
            Las claves se guardan en este equipo, en el almacenamiento de Spotify, que <b>otras extensiones
            de Spicetify también pueden leer</b> y no se pueden ocultar de ellas. Por eso: usa claves
            <b>gratuitas o con límite de gasto</b>, una clave solo para Vibemusic, y revócala en la web del
            proveedor si sospechas de alguna extensión.
          </p>

          <div class="mood-ai-field">
            <label for="cfg-primary">Proveedor principal (los demás configurados actúan de respaldo):</label>
            <select class="mood-ai-select" id="cfg-primary">
              ${Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}">${p.label}</option>`).join("")}
            </select>
          </div>

          ${Object.entries(PROVIDERS).map(([id, p]) => `
          <details class="mood-ai-provider" data-provider="${id}">
            <summary>${p.label} <span class="mood-ai-hint" data-role="status"></span></summary>
            <small class="mood-ai-hint">${p.note}</small>
            ${id === "custom" ? `
            <div class="mood-ai-field">
              <label>URL base:</label>
              <input type="text" data-role="base" placeholder="https://api.mistral.ai/v1 · http://localhost:11434/v1" />
            </div>` : ""}
            <div class="mood-ai-field">
              <label>API Key:</label>
              <input type="password" data-role="key" placeholder="${p.keyHint}" />
            </div>
            <div class="mood-ai-field">
              <label>Modelo:</label>
              <select class="mood-ai-select" data-role="model"></select>
              <small class="mood-ai-hint" data-role="hint"></small>
              <button class="mood-ai-chip" data-role="test" style="align-self:flex-start;">🔌 Probar conexión</button>
            </div>
          </details>`).join("")}

          <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px;">
            <button class="mood-ai-btn" id="cfg-btn-clear" style="background:#3e3e3e;color:#fff;">🗑️ Borrar todas las claves</button>
            <button class="mood-ai-btn" id="cfg-btn-save">💾 Guardar Ajustes</button>
          </div>
        </div>
      `;

      // Gestión de Pestañas
      const tabGen = content.querySelector("#tab-btn-generator");
      const tabSet = content.querySelector("#tab-btn-settings");
      const viewGen = content.querySelector("#view-generator");
      const viewSet = content.querySelector("#view-settings");

      const switchTab = (tab) => {
        if (tab === "generator") {
          tabGen.classList.add("active");
          tabSet.classList.remove("active");
          viewGen.style.display = "flex";
          viewSet.style.display = "none";
        } else {
          tabSet.classList.add("active");
          tabGen.classList.remove("active");
          viewSet.style.display = "flex";
          viewGen.style.display = "none";
        }
      };

      tabGen.onclick = () => switchTab("generator");
      tabSet.onclick = () => switchTab("settings");

      // Guardar opciones de curaduría
      const curationSelect = content.querySelector("#mood-ai-curation-select");
      const typeSelect = content.querySelector("#mood-ai-type-select");
      curationSelect.onchange = () => Config.setCurationMode(curationSelect.value);
      typeSelect.onchange = () => Config.setTrackType(typeSelect.value);
      const countSelect = content.querySelector("#mood-ai-count-select");
      countSelect.onchange = () => Config.setTrackCount(countSelect.value);

      // Guardar Ajustes API
      // Ajustes: un bloque por proveedor. Los valores se ponen por DOM, nunca dentro del HTML.
      const primarySelect = content.querySelector("#cfg-primary");
      primarySelect.value = Config.getPrimary();
      const blocks = [...content.querySelectorAll(".mood-ai-provider")].map(el => {
        const id = el.dataset.provider;
        const q = role => el.querySelector(`[data-role="${role}"]`);
        const block = { id, el, key: q("key"), base: q("base"), model: q("model"), hint: q("hint"), status: q("status") };
        block.key.value = Config.getKey(id);
        if (block.base) block.base.value = Config.getBaseUrl(id);
        block.status.textContent = Config.isConfigured(id) ? "✅" : "";
        if (id === primarySelect.value || Config.isConfigured(id)) el.open = true;
        return block;
      });

      // recommended = PROVIDERS[id].defaultModel: va primero y marcado con ⭐ (elegido tras medirlos en vivo).
      const setModelOptions = (select, list, current, recommended = "") => {
        select.replaceChildren();
        if (recommended) {
          const rec = list.find(m => m.id === recommended) || { id: recommended, label: recommended };
          list = [rec, ...list.filter(m => m.id !== recommended)];
        }
        const ids = new Set(list.map(m => m.id));
        // El modelo guardado se conserva aunque ya no salga en la lista.
        if (current && !ids.has(current)) list = [{ id: current, label: `${current} (guardado)` }, ...list];
        for (const m of list) {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = m.id === recommended ? `${m.label} ⭐ recomendado` : m.label; // texto, nunca innerHTML
          select.appendChild(opt);
        }
        select.value = current || list[0]?.id || "";
      };

      const loadModels = async (b) => {
        const current = b.model.value || Config.getModel(b.id);
        const key = b.key.value.trim();
        const base = b.id === "custom" ? b.base.value.trim().replace(/\/+$/, "") : PROVIDERS[b.id].base;
        if (!base || (b.id !== "custom" && b.id !== "openrouter" && !key)) {
          setModelOptions(b.model, [], current, PROVIDERS[b.id].defaultModel);
          b.hint.textContent = b.id === "custom" ? "Escribe la URL base para cargar los modelos." : "Introduce la clave para cargar la lista de modelos.";
          return;
        }
        b.hint.textContent = "Cargando modelos...";
        try {
          const list = await AIService.fetchModels(base, key);
          setModelOptions(b.model, list, current, PROVIDERS[b.id].defaultModel);
          b.hint.textContent = `${list.length} modelos disponibles${list.some(m => m.free) ? " (🆓 = gratis)" : ""}.`;
        } catch (err) {
          setModelOptions(b.model, [], current, PROVIDERS[b.id].defaultModel);
          b.hint.textContent = `No se pudo cargar la lista (${err.message}${b.id === "custom" ? "; ¿permite CORS? En Ollama: OLLAMA_ORIGINS=https://xpui.app.spotify.com" : ""}). Se mantiene el modelo guardado.`;
        }
      };

      // "Probar conexión": una llamada mínima con lo escrito ahora (sin guardar) y el resultado en claro.
      const testProvider = async (b) => {
        const p = PROVIDERS[b.id];
        const base = b.id === "custom" ? b.base.value.trim().replace(/\/+$/, "") : p.base;
        if (!base || !b.model.value) { b.hint.textContent = "Falta la URL o el modelo."; return; }
        b.hint.textContent = "🔌 Probando...";
        const t0 = performance.now();
        try {
          await AIService.callProvider(`${base}/chat/completions`, b.key.value.trim(), b.model.value,
            "Responde solo: ok", "ok", 0, p.headers || {}, false, 64, (p.fastBody || p.extraBody));
          b.hint.textContent = `✅ Funciona (${((performance.now() - t0) / 1000).toFixed(1)} s con ${b.model.value}).`;
        } catch (err) {
          const why = err.status === 401 || err.status === 403 ? "clave incorrecta o sin permiso"
            : cooldownSeconds(err) ? "límite de uso alcanzado; prueba más tarde"
            : /no longer|does not exist|not found/i.test(err.message) ? "ese modelo ya no existe; elige otro"
            : err.message;
          b.hint.textContent = `❌ ${why}`;
        }
      };

      for (const b of blocks) {
        b.el.querySelector('[data-role="test"]').onclick = () => testProvider(b);
        b.key.onchange = () => loadModels(b);
        if (b.base) b.base.onchange = () => {
          loadModels(b);
          if (Match.insecureUrl(b.base.value)) {
            b.hint.textContent = "⚠️ Esta URL usa http:// hacia otro equipo: tu clave viajaría SIN cifrar. Usa https://.";
          }
        };
      }
      let modelsLoaded = false;
      const loadModelsOnce = () => {
        if (modelsLoaded) return;
        modelsLoaded = true;
        blocks.forEach(loadModels);
      };
      tabSet.addEventListener("click", loadModelsOnce);
      if (initialTab === "settings") loadModelsOnce();

      // Borrar claves: deja la extensión sin credenciales en este equipo (localStorage).
      content.querySelector("#cfg-btn-clear").onclick = () => {
        if (!window.confirm("¿Borrar las claves de API de todos los proveedores guardadas en este equipo?")) return;
        for (const b of blocks) {
          Config.setKey(b.id, "");
          b.key.value = "";
          b.status.textContent = "";
        }
        Spicetify.showNotification("🗑️ Claves borradas de este equipo");
      };

      content.querySelector("#cfg-btn-save").onclick = () => {
        Config.setPrimary(primarySelect.value);
        for (const b of blocks) {
          Config.setKey(b.id, b.key.value);
          if (b.model.value) Config.setModel(b.id, b.model.value);
          if (b.base) Config.setCustomBaseUrl(b.base.value);
          b.status.textContent = Config.isConfigured(b.id) ? "✅" : "";
        }
        if (!Config.anyConfigured()) {
          Spicetify.showNotification("⚠️ Configura al menos un proveedor", true);
          return;
        }
        Spicetify.showNotification("✅ Ajustes guardados correctamente");
        switchTab("generator");
      };

      // Generar y Reproducir
      const btnGenerate = content.querySelector("#mood-ai-btn-generate");
      const inputPrompt = content.querySelector("#mood-ai-prompt");
      const statusDiv = content.querySelector("#mood-ai-status");
      const libraryCheck = content.querySelector("#mood-ai-exclude-library");
      libraryCheck.onchange = () => Config.setExcludeLibrary(libraryCheck.checked);
      const refineBox = content.querySelector("#mood-ai-refine");
      const refineLabel = content.querySelector("#mood-ai-refine-label");
      const refineInput = content.querySelector("#mood-ai-refine-input");
      const btnRefine = content.querySelector("#mood-ai-btn-refine");
      // Texto inicial: el que trae "Más como esto"/"Usar este prompt" o, si no, el último usado.
      inputPrompt.value = prefill || Config.getLastPrompt();
      const inlineMsg = content.querySelector("#mood-ai-inline-msg");
      const chips = content.querySelector("#mood-ai-chips");
      for (const ex of Match.EXAMPLES) {
        const chip = document.createElement("button");
        chip.className = "mood-ai-chip";
        chip.textContent = ex.label;                 // texto fijo nuestro, pero igualmente como texto
        chip.title = ex.prompt;                      // al pasar el ratón se ve el prompt completo
        chip.onclick = () => { inputPrompt.value = ex.prompt; inlineMsg.style.display = "none"; inputPrompt.focus(); };
        chips.appendChild(chip);
      }

      // 🕘 Recientes: hasta 5 últimos prompts únicos del usuario (solo si ya creó alguna lista).
      const recentBox = content.querySelector("#mood-ai-recent");
      const renderRecent = () => {
        recentBox.replaceChildren();
        const recents = Match.recentPrompts(History.all(), 5);
        if (recents.length === 0) {
          recentBox.style.display = "none";
          return;
        }
        recentBox.style.display = "flex";
        const tag = document.createElement("span");
        tag.className = "mood-ai-hint";
        tag.textContent = "🕘 Recientes:";
        recentBox.appendChild(tag);
        for (const r of recents) {
          const chip = document.createElement("button");
          chip.className = "mood-ai-chip";
          chip.textContent = r.label;                // siempre textContent (texto guardado en localStorage)
          chip.title = r.prompt;
          chip.onclick = () => { inputPrompt.value = r.prompt; inlineMsg.style.display = "none"; inputPrompt.focus(); };
          recentBox.appendChild(chip);
        }
      };
      renderRecent();

      // Ctrl+Enter (o Cmd+Enter en Mac) = crear, sin quitar las manos del teclado.
      inputPrompt.onkeydown = e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); btnGenerate.onclick(); } };

      const showRefine = () => {
        if (!lastRun) return;
        refineBox.style.display = "flex";
        // Texto del usuario y nombres de Spotify: siempre textContent.
        // Debe quedar claro que habla de TU ÚLTIMA playlist (no es un ejemplo): Brian lo confundió.
        refineLabel.textContent = `✏️ ¿Retocar tu última playlist (${lastRun.tracks.length} canciones)? Escribe el cambio y se creará una versión nueva.`;
        refineLabel.title = lastRun.name; // el nombre completo, al pasar el ratón
      };
      showRefine();

      let activeAbort = null;
      const setBtnGenerateDefault = () => {
        btnGenerate.replaceChildren();
        const icon = document.createElement("span");
        icon.textContent = "▶";
        btnGenerate.append(icon, " Crear y reproducir playlist");
        btnGenerate.style.backgroundColor = "#1db954";
        btnGenerate.style.color = "#000000";
      };

      // text = lo que se interpreta; nameText = nombre de la playlist; context = versión anterior.
      const run = async (text, nameText, context = "") => {
        const ctrl = new AbortController();
        activeAbort = ctrl;
        btnGenerate.textContent = "⏹ Cancelar";
        btnGenerate.style.backgroundColor = "#3e3e3e";
        btnGenerate.style.color = "#ffffff";
        btnRefine.disabled = true;
        btnRefine.style.opacity = "0.6";
        statusDiv.style.display = "block";
        statusDiv.style.color = "#b3b3b3";
        const status = msg => { statusDiv.style.color = "#b3b3b3"; statusDiv.textContent = msg; };
        status("🧠 Entendiendo tu petición...");

        // Fase en curso, para que el error diga dónde falló (IA y búsqueda, o creación en Spotify).
        let phase = "buscar";
        try {
          const { req, understood, found, rejected } = await buildTrackList(text, {
            count: Number(countSelect.value),
            trackType: typeSelect.value,
            excludeLibrary: libraryCheck.checked
          }, status, context, ctrl.signal);

          if (ctrl.signal.aborted) throw new DOMException("Cancelado", "AbortError");
          const requested = req.count;
          if (found.length === 0) {
            UI.renderReport(statusDiv, `${understood}\n⚠️ Ninguna sugerencia coincidió con Spotify. Prueba otros términos.`, rejected);
            return;
          }

          status(`🎶 Creando playlist privada con ${found.length} pistas...`);
          phase = "crear";
          // Nombre: el resumen que hizo la IA; al "Ajustar", el texto del ajuste.
          const result = await SpotifyService.produceAndNavigatePlaylist(context ? nameText : (req.summary || nameText), found);
          lastRun = { text, name: result.name, tracks: found };
          Config.setLastRun(lastRun);
          // La descripción lleva el prompt: SOLO si la playlist quedó privada (privacidad del usuario).
          if (result.uri && result.isPrivate) {
            History.save(result.uri, { prompt: text, understood, count: found.length, date: Date.now() });
            renderRecent();
            // El nombre va recortado; el prompt completo queda en la descripción (verificado en vivo:
            // PlaylistAPI.updateDetails(uri, { description }) funciona en Spotify 1.2.95).
            try {
              await Spicetify.Platform?.PlaylistAPI?.updateDetails?.(result.uri, { description: Match.playlistDescription(text, understood) });
            } catch (err) { console.warn("[Vibemusic] No se pudo guardar la descripción:", err); }
          }
          showRefine();
          refineInput.value = "";

          // "Añadidas" = las que Spotify confirma que están en la playlist (contadas tras añadir).
          const summary = `Pedidas: ${requested} · Encontradas: ${found.length} · Añadidas: ${result.added}`;
          const privacy = result.isPrivate === false ? " · ⚠️ no se pudo hacer privada" : result.isPrivate ? " · 🔒 privada" : "";
          Spicetify.showNotification(`🎵 ${result.name}: ${result.added}/${requested} canciones${privacy}`);
          if (result.added >= requested && result.isPrivate !== false) {
            Spicetify.PopupModal.hide();
          } else {
            UI.renderReport(statusDiv, `${understood}\n⚠️ ${result.added < requested ? "Lista incompleta. " : ""}${summary}${privacy}`, rejected);
          }
        } catch (error) {
          if (error?.name === "AbortError" || ctrl.signal.aborted) {
            statusDiv.style.display = "block";
            statusDiv.style.color = "#b3b3b3";
            statusDiv.textContent = "⏹ Generación cancelada.";
            return;
          }
          console.error("[Vibemusic] Error en el flujo:", error);
          statusDiv.style.display = "block";
          statusDiv.style.color = "#e91429";
          const where = phase === "crear" ? "🎵 Al crear la playlist en Spotify" : "🧠 Al buscar canciones";
          statusDiv.textContent = `❌ ${where}: ${error.message}`;
        } finally {
          activeAbort = null;
          setBtnGenerateDefault();
          btnRefine.disabled = false;
          btnRefine.style.opacity = "1";
        }
      };

      btnGenerate.onclick = () => {
        if (activeAbort) {
          activeAbort.abort();
          return;
        }
        const text = inputPrompt.value.trim();
        if (!text) {
          // Aviso dentro del modal en vez de alert(), que bloquea toda la ventana de Spotify.
          inlineMsg.textContent = "Escribe qué quieres escuchar o elige un ejemplo.";
          inlineMsg.style.display = "block";
          inputPrompt.focus();
          return;
        }
        inlineMsg.style.display = "none";
        Config.setLastPrompt(text);
        run(text, text);
      };

      btnRefine.onclick = () => {
        const adjustment = refineInput.value.trim();
        if (!adjustment || !lastRun) return;
        const { text, context } = Match.refineRequest(lastRun.text, lastRun.tracks, adjustment);
        run(text, `${adjustment} · ${lastRun.text}`, context);
      };
      refineInput.onkeydown = e => { if (e.key === "Enter") btnRefine.onclick(); };

      Spicetify.PopupModal.display({
        title: "✨ Vibemusic",
        content: content,
        isLarge: false
      });
    }
  };

  // --------------------------------------------------------------------------
  // PASO 7: Botón en la Barra Superior
  // --------------------------------------------------------------------------
  // Icono: nota musical + destellos (música + IA). currentColor = toma el color del tema de Spotify.
  const vibemusicIconSVG = `
    <svg role="img" height="18" width="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M13 4v10.55A4 4 0 1 0 15 18V8h4V4h-6z"/>
      <path d="M6 2l.95 2.05L9 5l-2.05.95L6 8l-.95-2.05L3 5l2.05-.95z"/>
      <path d="M19.5 11l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>
    </svg>
  `;

  new Spicetify.Topbar.Button(
    "Vibemusic",
    vibemusicIconSVG,
    () => {
      UI.openModal();
    }
  );

  // --------------------------------------------------------------------------
  // PASO 8: "Más como esto" en el menú contextual de canciones y playlists
  // Verificado en vivo (2026-11-14): ContextMenu.Item(nombre, onClick, shouldAdd) con .register().
  // Si no existe, la extensión carga igual sin esta opción.
  // --------------------------------------------------------------------------
  if (Spicetify.ContextMenu?.Item) {
    try {
      new Spicetify.ContextMenu.Item(
        "Vibemusic: más como esto",
        async (uris) => {
          let info = null;
          try { info = await SpotifyService.describeUri(uris[0]); } catch (err) { console.warn("[Vibemusic]", err); }
          const prompt = Match.seedPrompt(info);
          if (!prompt) Spicetify.showNotification("⚠️ No pude leer el nombre; escribe tu petición", true);
          UI.openModal("generator", prompt);
        },
        (uris) => uris.length === 1 && !!Match.uriKind(uris[0])
      ).register();

      // Muestra el prompt de una playlist de Vibemusic: primero busca en el historial local y, si no
      // está (otro PC o caché borrada), lo recupera de la descripción de la playlist en Spotify.
      new Spicetify.ContextMenu.Item(
        "Vibemusic: mostrar prompt de la lista",
        async (uris) => {
          const uri = uris[0];
          let entry = History.get(uri);
          if (!entry) {
            try {
              const meta = await Spicetify.Platform?.PlaylistAPI?.getMetadata?.(uri);
              const parsed = Match.parsePlaylistDescription(meta?.description);
              if (parsed) entry = { ...parsed, count: meta?.totalLength || null, date: null };
            } catch (err) { console.warn("[Vibemusic] getMetadata falló:", err); }
          }
          if (entry) UI.showPrompt(entry);
          else Spicetify.showNotification("ℹ️ Esta playlist no tiene un prompt guardado por Vibemusic");
        },
        (uris) => uris.length === 1 && Match.uriKind(uris[0]) === "playlist"
      ).register();
    } catch (err) {
      console.warn("[Vibemusic] No se pudo registrar el menú contextual:", err);
    }
  }

  console.log("🚀 [Vibemusic] Cargado.");
})();
