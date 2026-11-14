// Ejecutar: node --test test/
// Funciones puras del grounding, el relleno, el menú contextual y el ajuste.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Match } = require("../vibemusic.js");

const c = (uri, name, artists, album = "") => ({ uri: `spotify:track:${uri}`, name, artists, album });

test("consultas de búsqueda: primero las concretas (IA, artistas), el género al final y sin repetir", () => {
  const req = {
    instrumental: true, genre: "boom bap", includeArtists: ["Pete Rock"],
    searchQueries: ["Boom Bap Instrumental", "Madlib beat tape", "  ", "Nujabes instrumentals"]
  };
  // "boom bap instrumental" (el género) ya está en la primera consulta: no se repite.
  assert.deepEqual(Match.buildSearchQueries(req), [
    "Boom Bap Instrumental", "Madlib beat tape", "Nujabes instrumentals", "Pete Rock instrumental"
  ]);
  assert.deepEqual(Match.buildSearchQueries({ genre: "jazz modal", searchQueries: ["Miles Davis Kind of Blue"] }),
    ["Miles Davis Kind of Blue", "jazz modal"]);
  assert.equal(Match.buildSearchQueries({ ...req, searchQueries: ["a", "b", "c", "d", "e", "f"] }).length, 6);
  assert.deepEqual(Match.buildSearchQueries({ genre: "", includeArtists: [] }), []);
});

test("dedupe: si la misma canción llega primero en versión acústica, se queda la original", () => {
  const out = Match.dedupeCandidates([c("a", "Iris - Acoustic", ["The Goo Goo Dolls"]), c("o", "Iris", ["The Goo Goo Dolls"])]);
  assert.deepEqual(out.map(x => x.uri.slice(-1)), ["o"]);
});

test("dedupe del pool: misma URI y mismo tema en single y álbum", () => {
  const out = Match.dedupeCandidates([
    c("1", "Shook Ones", ["Mobb Deep"]),
    c("1", "Shook Ones", ["Mobb Deep"]),
    c("2", "Shook Ones - Remastered", ["Mobb Deep"]),
    c("3", "Shook Ones (Instrumental)", ["Mobb Deep"]),
    { uri: "", name: "x", artists: [] }
  ]);
  assert.deepEqual(out.map(x => x.uri), ["spotify:track:1", "spotify:track:3"]);
});

test("filtro del pool: sin instrumentales si se pide con voz y sin artistas excluidos", () => {
  const pool = [c("1", "Track (Instrumental)", ["A"]), c("2", "Track", ["Drake"]), c("3", "Otro", ["B"])];
  assert.deepEqual(Match.filterPool(pool, { instrumental: false, excludeArtists: ["drake"] }).map(x => x.uri), ["spotify:track:3"]);
  assert.equal(Match.filterPool(pool, {}, 2).length, 2);
});

test("lista compacta numerada con álbum solo si existe", () => {
  const txt = Match.compactCandidateList([c("1", "Lift Off", ["Pete Rock", "CL"], "Petestrumentals"), c("2", "B", ["X"])]);
  assert.equal(txt, "0. Lift Off — Pete Rock, CL [álbum: Petestrumentals]\n1. B — X");
});

test("parsePicks: formatos variados, fuera de rango y repetidos", () => {
  assert.deepEqual(Match.parsePicks('{"picks":[2,"0",2,9,-1,"x"]}', 5).map(p => p.i), [2, 0]);
  assert.deepEqual(Match.parsePicks('```json\n[{"i":1,"instrumental":false},{"index":3}]\n```', 5),
    [{ i: 1, instrumental: false, year: null }, { i: 3, instrumental: null, year: null }]);
  assert.deepEqual(Match.parsePicks("no es json", 5), []);
  assert.deepEqual(Match.parsePicks('{"picks":[1.5]}', 5), []);
});

test("relleno: descarta lo ya probado, pero la versión instrumental es otra", () => {
  const tried = new Set([Match.trackKey("Mass Appeal", "Gang Starr, DJ Premier")]);
  const { kept, rejected } = Match.dropTried([
    { title: "Mass Appeal", artist: "Gang Starr" },
    { title: "Mass Appeal (Instrumental)", artist: "Gang Starr" }
  ], tried);
  assert.deepEqual(kept.map(k => k.title), ["Mass Appeal (Instrumental)"]);
  assert.equal(rejected[0].reason, "ya probada");
});

test("askFor: margen ×1,5, mínimo 3 y tope 50", () => {
  assert.deepEqual([Match.askFor(10), Match.askFor(1), Match.askFor(40)], [15, 3, 50]);
});

test("modo escritor: bonus si el álbum es una obra instrumental", () => {
  const wanted = { title: "Lift Off", artist: "Pete Rock", instrumental: true };
  const vocalAlbum = c("v", "Lift Off", ["Pete Rock"], "Soul Survivor");
  const instAlbum = c("i", "Lift Off", ["Pete Rock"], "Petestrumentals");
  assert.equal(Match.pickBest(wanted, [vocalAlbum, instAlbum]).uri, "spotify:track:i");
  // Sin pedir instrumental no hay bonus: gana el primero con la misma puntuación.
  assert.equal(Match.pickBest({ ...wanted, instrumental: null }, [vocalAlbum, instAlbum]).uri, "spotify:track:v");
});

test("menú contextual: tipo de URI y texto inicial", () => {
  assert.equal(Match.uriKind("spotify:track:4uLU6hMCjMI75M1A2tKUQC"), "track");
  assert.equal(Match.uriKind("spotify:playlist:37i9dQZF1DX0XUsuxWHRQd"), "playlist");
  assert.equal(Match.uriKind("spotify:album:1"), null);
  assert.equal(Match.uriKind(undefined), null);
  assert.equal(Match.seedPrompt({ kind: "track", name: "C.R.E.A.M.", artists: ["Wu-Tang Clan"] }),
    "Canciones como «C.R.E.A.M.» de Wu-Tang Clan");
  assert.equal(Match.seedPrompt({ kind: "track", name: "X", artists: [] }), "Canciones como «X»");
  assert.equal(Match.seedPrompt({ kind: "playlist", name: "Noche", samples: ["a — b", "c — d"] }),
    "Música en la línea de mi playlist «Noche» (por ejemplo: a — b; c — d)");
  assert.equal(Match.seedPrompt({ kind: "track", name: "" }), "");
});

test("ajuste conversacional: texto encadenado y versión anterior como contexto", () => {
  const r = Match.refineRequest("10 beats boom bap", [{ name: "A", artist: "X" }, { name: "B", artist: "Y" }], "más oscuro");
  assert.equal(r.text, "10 beats boom bap. Ajuste: más oscuro");
  assert.match(r.context, /^Versión anterior: A — X; B — Y\./);
  assert.match(r.context, /"más oscuro"/);
  assert.equal(Match.refineRequest("x", [], "y").context, "");
});

test("resolveRequest recoge las consultas de búsqueda de la IA (máx. 6, solo texto)", () => {
  const req = Match.resolveRequest("beats", { search_queries: ["a", 2, "b", "c", "d", "e", "f", "g"] }, { count: 5, trackType: "auto" });
  assert.deepEqual(req.searchQueries, ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(Match.resolveRequest("beats", null, { count: 5, trackType: "auto" }).searchQueries, []);
});

// Caso real (prueba en vivo 2026-11-14): 9 de 10 pistas eran relleno de palabras clave.
// El filtro es genérico: el mismo tipo de relleno existe en piano, estudio, gimnasio, etc.
test("relleno de palabras clave: se detecta en cualquier género y solo entra si falta pool", () => {
  const filler = [
    c("f1", "Boom Bap Type Beat", ["Reli Beats", "Yardin Beats"]),
    c("f2", "Base de Rap - Underground Boombap - Hip Hop Instrumental", ["Rudeskillz Beats"]),
    c("f3", "1990 - 90's Boom Bap Instrumental Mix", ["Vintageman Produkcja Beats"]),
    c("f4", "Instrumental HipHop - Rap Beat", ["AesUno"]),
    c("f5", "Relaxing Piano Music for Study", ["Study Music Academy"]),
    c("f6", "Workout Mix 2024", ["Gym Hits"])
  ];
  const real = [
    c("r1", "C.R.E.A.M.", ["El Michels Affair"], "Enter The 37th Chamber"),
    c("r2", "Aruarian Dance", ["Nujabes"], "Samurai Champloo Music Record: Departure"),
    c("r3", "So What", ["Miles Davis"], "Kind of Blue"),
    c("r4", "Beat It", ["Michael Jackson"], "Thriller"),
    c("r5", "Mix Tape", ["Brand New"], "Your Favorite Weapon")
  ];
  for (const f of filler) assert.equal(Match.isFiller(f), true, f.name);
  for (const r of real) assert.equal(Match.isFiller(r), false, r.name);
  // Hay de sobra (≥ 2×count) → fuera el relleno
  assert.deepEqual(Match.filterPool([...filler, ...real], { count: 2 }).map(x => x.uri.slice(-2)), ["r1", "r2", "r3", "r4", "r5"]);
  // Falta pool → el relleno entra, pero al final
  assert.deepEqual(Match.filterPool([...filler, ...real], { count: 5 }).map(x => x.uri.slice(-2)),
    ["r1", "r2", "r3", "r4", "r5", "f1", "f2", "f3", "f4", "f5", "f6"]);
});

// Prueba en vivo (banco variado 2026-11-14): "Iris - Acoustic", "Sad Song - Demo" en vez de las originales,
// y 5 de Bonobo + 4 de Tycho al pedir "tipo Bonobo o Tycho".
test("versiones alternativas: se detectan solo en el sufijo y nunca en remasters", () => {
  for (const n of ["Iris - Acoustic", "Sad Song - Mauldeth Road West Demo, Nov '92", "Torn - Acoustic MTV Unplugged",
                   "Creep (Live)", "Black [Remix]", "Wonderwall - Karaoke Version"])
    assert.equal(Match.isAltVersion(n), true, n);
  for (const n of ["Live Forever", "Demons", "Iris", "Black - Remastered 2004", "Hurt - Album Version",
                   "My Funny Valentine - Rudy Van Gelder Remaster 2007", "Acoustic #3"])
    assert.equal(Match.isAltVersion(n), false, n);
});

test("versiones alternativas: al final del pool y penalizadas al emparejar, salvo que se pidan", () => {
  const pool = [c("a", "Iris - Acoustic", ["The Goo Goo Dolls"]), c("o", "Iris", ["The Goo Goo Dolls"]),
                c("x", "Slide", ["The Goo Goo Dolls"])];
  const req = Match.resolveRequest("canciones tristes de los 90", null, { count: 1 });
  assert.equal(req.allowVersions, false);
  assert.deepEqual(Match.filterPool(pool, req).map(x => x.uri.slice(-1)), ["o", "x"]);
  assert.equal(Match.pickBest({ title: "Iris", artist: "Goo Goo Dolls" }, pool).uri.slice(-1), "o");
  const reqLive = Match.resolveRequest("versiones acústicas tristes de los 90", null, { count: 1 });
  assert.equal(reqLive.allowVersions, true);
  // Pidiendo acústicas, la versión acústica ya no pierde puntos al emparejar por título.
  assert.equal(Match.pickBest({ title: "Iris - Acoustic", artist: "Goo Goo Dolls" }, pool).uri.slice(-1), "a");
  // El dedupe sigue juntando misma canción (se queda la original): ponytail, suficiente por ahora.
  assert.deepEqual(Match.filterPool(pool, reqLive).map(x => x.uri.slice(-1)), ["o", "x"]);
});

test("variedad: 2 por artista, sin límite si pide solo ciertos artistas", () => {
  const tipo = Match.resolveRequest("electrónica tipo Bonobo o Tycho", { include_artists: ["Bonobo", "Tycho"], only_artists: false }, { count: 10 });
  assert.equal(Match.artistCap(tipo), 2);
  const solo = Match.resolveRequest("10 canciones de Bonobo", { include_artists: ["Bonobo"], only_artists: true }, { count: 10 });
  assert.equal(Match.artistCap(solo), Infinity);
  assert.equal(Match.artistCap(Match.resolveRequest("x", { only_artists: true }, { count: 10 })), 2); // sin artistas citados no cuenta
  assert.equal(Match.artistCap(Match.resolveRequest("x", null, { count: 30 })), 3);
  assert.equal(Match.mainArtist("Bonobo, Andreya Triana"), "bonobo");
});

test("parsePicks lee el año declarado y descarta años imposibles", () => {
  const picks = Match.parsePicks('{"picks":[{"i":0,"year":2023},{"i":1,"year":"2004"},{"i":2,"year":99999},{"i":3}]}', 10);
  assert.deepEqual(picks.map(p => p.year), [2023, 2004, null, null]);
});

// Caso real (Groq declaraba años erróneos): pedido 2000-2009 y salían grupos de 2023.
test("consultas de búsqueda: la época pedida se añade como filtro year: de Spotify", () => {
  assert.deepEqual(
    Match.buildSearchQueries({ genre: "indie rock español", searchQueries: ["Los Planetas"], range: { from: 2000, to: 2009 } }),
    ["Los Planetas year:2000-2009", "indie rock español year:2000-2009"]);
  assert.deepEqual(Match.buildSearchQueries({ genre: "jazz", range: null }), ["jazz"]);
});

test("descripción de la playlist: prompt completo, ≤ 300 caracteres, recorta antes lo entendido", () => {
  const corto = Match.playlistDescription("indie español de los 2000", "Entendido: 15 canciones · indie");
  assert.equal(corto, "Vibemusic · «indie español de los 2000» · Entendido: 15 canciones · indie");
  const largo = "x".repeat(250);
  const d = Match.playlistDescription(largo, "Entendido: " + "y".repeat(100));
  assert.ok(d.length <= 300 && d.includes(largo) && !d.includes("Entendido"));
  assert.equal(Match.playlistDescription("z".repeat(400), "").length, 299);
});

test("URL insegura: http:// hacia otro equipo sí, hacia el propio equipo o https no", () => {
  assert.equal(Match.insecureUrl("http://192.168.1.20:11434/v1"), true);
  assert.equal(Match.insecureUrl("http://api.ejemplo.com/v1"), true);
  for (const u of ["https://api.mistral.ai/v1", "http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080", ""])
    assert.equal(Match.insecureUrl(u), false, u);
});

test("nombre de playlist: resumen con mayúscula, ≤ 60 caracteres y corte en palabra entera", () => {
  assert.equal(Match.playlistName("indie rock español de los 2000 para viajar"), "Vibemusic · Indie rock español de los 2000 para viajar");
  const n = Match.playlistName("una petición larguísima con muchísimas palabras que no caben en el nombre de la lista");
  assert.ok(n.length <= 60 && n.endsWith("…") && !/\s…$/.test(n), n);
  assert.equal(Match.playlistName(""), "Vibemusic · Mi selección");
});

test("redactSecrets: ninguna clave sale entera en mensajes de error", () => {
  const fakes = ["gsk_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456", "AIzaSyD-FAKE_fake_FAKE_fake_FAKE_1234567", "sk-or-v1-0123456789abcdef0123456789abcdef",
                 "sk-proj-abcdefghijklmnopqrstuvwxyz", "sk-****************wxyz"];
  for (const k of fakes) {
    const out = Match.redactSecrets(`Incorrect API key provided: ${k}. Try again.`);
    assert.ok(!out.includes(k.slice(6)), out);
    assert.match(out, /…\[clave oculta\]/);
  }
  assert.equal(Match.redactSecrets("Authorization: Bearer gsk_secretsecretsecret"), "Authorization: Bearer gsk_…[clave oculta]");
  assert.equal(Match.redactSecrets("Rate limit reached. Please try again in 12s."), "Rate limit reached. Please try again in 12s.");
  assert.equal(Match.redactSecrets(undefined), "");
});

test("parsePlaylistDescription: extrae prompt y entendido de la descripción de Spotify, o null si no es de Vibemusic", () => {
  const full = Match.parsePlaylistDescription("Vibemusic · «indie español de los 2000» · Entendido: 15 canciones · indie");
  assert.deepEqual(full, { prompt: "indie español de los 2000", understood: "Entendido: 15 canciones · indie" });
  const onlyPrompt = Match.parsePlaylistDescription("Vibemusic · «jazz sin voz para estudiar»");
  assert.deepEqual(onlyPrompt, { prompt: "jazz sin voz para estudiar", understood: "" });
  assert.equal(Match.parsePlaylistDescription("Mis canciones favoritas de 2024"), null);
  assert.equal(Match.parsePlaylistDescription(""), null);
  assert.equal(Match.parsePlaylistDescription(null), null);
});

test("recentPrompts y shortChipLabel: ordena por fecha, quita prompts repetidos y recorta etiquetas largas", () => {
  const hist = {
    "spotify:playlist:1": { prompt: "jazz tranquilo", date: 100 },
    "spotify:playlist:2": { prompt: "15 temas de indie rock español de los 2000 para un viaje largo", date: 300 },
    "spotify:playlist:3": { prompt: "JAZZ TRANQUILO", date: 200 },
    "spotify:playlist:4": { prompt: "", date: 400 },
    "spotify:playlist:5": null
  };
  const out = Match.recentPrompts(hist, 5);
  assert.deepEqual(out.map(x => x.uri), ["spotify:playlist:2", "spotify:playlist:3"]);
  assert.ok(out[0].label.length <= 30 && out[0].label.endsWith("…"));
  assert.equal(out[1].label, "JAZZ TRANQUILO");
  assert.deepEqual(Match.recentPrompts(null), []);
});

test("resolveRequest: no acepta un idioma inventado por la IA si el texto no menciona idioma ni gentilicio", () => {
  const generic = Match.resolveRequest(
    "10 canciones de rock alternativo",
    { count: 10, genre: "rock", instrumental: false, language: "pt", summary: "Rock alternativo, con voz, idioma portugués" },
    { count: 10, trackType: "auto" }
  );
  assert.equal(generic.language, null);
  assert.equal(Match.describe(generic), "10 canciones · rock · con voz");
  assert.equal(Match.playlistName(generic.summary), "Vibemusic · Rock alternativo");

  // Si el usuario SÍ menciona idioma o gentilicio, se respeta:
  const es = Match.resolveRequest("indie rock español de los 2000", { language: "es" }, { count: 10, trackType: "auto" });
  assert.equal(es.language, "es");
  const en = Match.resolveRequest("canciones tristes en inglés de los 90", { language: "en" }, { count: 10, trackType: "auto" });
  assert.equal(en.language, "en");
  const pt = Match.resolveRequest("bossa nova en portugués", { language: "pt" }, { count: 10, trackType: "auto" });
  assert.equal(pt.language, "pt");
});
