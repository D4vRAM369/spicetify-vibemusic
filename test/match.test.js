// Ejecutar: node --test test/
const test = require("node:test");
const assert = require("node:assert/strict");
const { Match, parseLLMResponse, parseModelList, providerChain } = require("../vibemusic.js");

test("cantidad pedida en el texto", () => {
  assert.equal(Match.parseRequestedCount("los 10 mejores temas de rap de 2000 a 2010"), 10);
  assert.equal(Match.parseRequestedCount("top 15 boom bap"), 15);
  assert.equal(Match.parseRequestedCount("99 canciones"), 50); // tope MAX_TRACKS
  assert.equal(Match.parseRequestedCount("rap de 2000 a 2010"), null);
});

test("rango de años", () => {
  assert.deepEqual(Match.parseYearRange("rap de 2000 a 2010"), { from: 2000, to: 2010 });
  assert.deepEqual(Match.parseYearRange("rap 2010-2000"), { from: 2000, to: 2010 });
  assert.deepEqual(Match.parseYearRange("beats años 90"), { from: 1990, to: 1999 });
  assert.deepEqual(Match.parseYearRange("80s synth"), { from: 1980, to: 1989 });
  assert.deepEqual(Match.parseYearRange("hits 2000s"), { from: 2000, to: 2009 });
  assert.deepEqual(Match.parseYearRange("boom bap noventero"), { from: 1990, to: 1999 });
  assert.equal(Match.parseYearRange("los 10 mejores temas"), null);
});

test("matching rechaza otro artista aunque el título se parezca", () => {
  const wanted = { title: "Hate It or Love It", artist: "The Game" };
  const candidates = [
    { uri: "spotify:track:ozuna", name: "Hate It or Love It", artists: ["Ozuna"] },
    { uri: "spotify:track:game", name: "Hate It Or Love It - Remastered", artists: ["The Game", "50 Cent"] }
  ];
  assert.equal(Match.pickBest(wanted, candidates).uri, "spotify:track:game");
  assert.equal(Match.pickBest(wanted, [candidates[0]]), null);
});

test("matching tolera acentos, feat y artistas separados", () => {
  const best = Match.pickBest(
    { title: "Paid in Full (feat. X)", artist: "Eric B. & Rakim" },
    [{ uri: "spotify:track:1", name: "Paid In Full", artists: ["Eric B.", "Rakim"] }]
  );
  assert.ok(best);
});

test("validación quita duplicados y años fuera de rango", () => {
  const items = [
    { title: "In Da Club", artist: "50 Cent", year: 2003 },
    { title: "In da club", artist: "50 cent", year: 2003 },
    { title: "Taki Taki", artist: "Ozuna", year: 2018 },
    { title: "Sin año", artist: "X", year: null }
  ];
  const { kept, rejected } = Match.validateRecommendations(items, { range: { from: 2000, to: 2010 } });
  assert.deepEqual(kept.map(k => k.title), ["In Da Club", "Sin año"]);
  assert.deepEqual(rejected.map(r => r.reason), ["duplicada", "fuera de época (2018)"]);
});

test("parser lee el año de la IA", () => {
  const out = parseLLMResponse('{"recommendations":[{"title":"Ms. Jackson","artist":"Outkast","year":"2000"}]}');
  assert.equal(out[0].year, 2000);
});

// Caso real 2: "10 instrumentales boom bap con fuerza para escribir temas de rap" + filtro Instrumentales
test("el filtro Instrumentales manda y el número se lee aunque diga 'instrumentales'", () => {
  assert.equal(Match.parseRequestedCount("quiero 10 instrumentales boom bap"), 10);
  const req = Match.resolveRequest("10 instrumentales boom bap", { instrumental: null, language: "en" }, { count: 5, trackType: "instrumental" });
  assert.equal(req.count, 10);
  assert.equal(req.instrumental, true);
  assert.equal(req.language, null); // idioma no aplica a instrumentales
  assert.equal(req.askFor, 15);
});

test("la interpretación de la IA se usa cuando el modal está en automático", () => {
  const req = Match.resolveRequest("diez beats noventeros", {
    count: 10, instrumental: true, era: { from: 1999, to: 1990 }, genre: "boom bap", exclude_artists: ["Drake", 3]
  }, { count: 5, trackType: "auto" });
  assert.deepEqual([req.count, req.instrumental, req.range], [10, true, { from: 1990, to: 1999 }]);
  assert.deepEqual(req.excludeArtists, ["Drake"]);
  assert.match(Match.describe(req), /10 canciones · boom bap · instrumental · 1990–1999/);
});

test("sin IA de interpretación cae en la detección local", () => {
  const req = Match.resolveRequest("top 15 rap de 2000 a 2010", null, { count: 5, trackType: "auto" });
  assert.deepEqual([req.count, req.instrumental, req.range], [15, null, { from: 2000, to: 2010 }]);
});

test("validación descarta temas con voz si se piden instrumentales", () => {
  const items = [
    { title: "Mass Appeal", artist: "Gang Starr", instrumental: false },
    { title: "Mass Appeal (Instrumental)", artist: "Gang Starr", instrumental: true },
    { title: "Aruarian Dance", artist: "Nujabes", instrumental: null }
  ];
  const { kept, rejected } = Match.validateRecommendations(items, { instrumental: true });
  assert.deepEqual(kept.map(k => k.title), ["Mass Appeal (Instrumental)", "Aruarian Dance"]);
  assert.equal(rejected[0].reason, "tiene voz");
});

test("matching exige la versión instrumental si el título la pide", () => {
  const wanted = { title: "Mass Appeal (Instrumental)", artist: "Gang Starr", instrumental: true };
  const vocal = { uri: "spotify:track:v", name: "Mass Appeal", artists: ["Gang Starr"] };
  const inst = { uri: "spotify:track:i", name: "Mass Appeal - Instrumental", artists: ["Gang Starr"] };
  assert.equal(Match.pickBest(wanted, [vocal]), null);
  assert.equal(Match.pickBest(wanted, [vocal, inst]).uri, "spotify:track:i");
});

test("validación filtra idioma y artistas excluidos", () => {
  const items = [
    { title: "A", artist: "Drake", language: "en" },
    { title: "B", artist: "Nach", language: "es" },
    { title: "C", artist: "Kase.O", language: "es" }
  ];
  const { kept } = Match.validateRecommendations(items, { language: "es", excludeArtists: ["Nach"] });
  assert.deepEqual(kept.map(k => k.title), ["C"]);
});

test("lista de modelos: solo chat, gratis primero, orden alfabético", () => {
  const groq = parseModelList({ data: [
    { id: "whisper-large-v3" }, { id: "llama-3.3-70b-versatile" }, { id: "gemma2-9b-it" },
    { id: "meta-llama/llama-guard-4-12b" }, { id: "old-model", active: false }
  ] });
  assert.deepEqual(groq.map(m => m.id), ["gemma2-9b-it", "llama-3.3-70b-versatile"]);

  const or = parseModelList({ data: [
    { id: "openai/gpt-4o", pricing: { prompt: "0.0000025", completion: "0.00001" } },
    { id: "meta-llama/llama-3.3-70b-instruct:free", pricing: { prompt: "0", completion: "0" } },
    { id: "x/image-gen", architecture: { output_modalities: ["image"] } }
  ] });
  assert.deepEqual(or.map(m => m.label), ["🆓 meta-llama/llama-3.3-70b-instruct:free", "openai/gpt-4o"]);
  assert.deepEqual(parseModelList(null), []);
});

test("proveedores: el principal va primero y se saltan los no configurados", () => {
  const configured = id => ["groq", "gemini", "custom"].includes(id);
  assert.deepEqual(providerChain("custom", configured), ["custom", "gemini", "groq"]);
  assert.deepEqual(providerChain("openrouter", configured), ["gemini", "groq", "custom"]);
  assert.deepEqual(providerChain("inexistente", configured), ["gemini", "groq", "custom"]);
});

test("modelos de Gemini: sin prefijo models/ y sin embeddings/imagen", () => {
  const list = parseModelList({ data: [
    { id: "models/gemini-2.5-flash" }, { id: "models/text-embedding-004" },
    { id: "models/imagen-4.0-generate" }, { id: "models/gemini-2.5-pro" }
  ] });
  assert.deepEqual(list.map(m => m.id), ["gemini-2.5-flash", "gemini-2.5-pro"]);
});

// Prueba en vivo (velocidad, 2026-11-14): ernie envolvía el JSON en texto → 0 elecciones;
// Gemini daba 429 en cada llamada y se perdía tiempo reintentándolo.
const { parseJSON, cooldownSeconds } = require("../vibemusic.js");

test("parseJSON: JSON envuelto en texto, en bloque de código o tras <think>", () => {
  assert.deepEqual(parseJSON('Aquí tienes tu selección: {"picks":[{"i":3}]} ¡Que la disfrutes!'), { picks: [{ i: 3 }] });
  assert.deepEqual(parseJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJSON('<think>hmm, veamos…</think>\n[1,2]'), [1, 2]);
  assert.throws(() => parseJSON("no hay nada aquí"));
});

test("disyuntor: segundos de descanso según el error", () => {
  const e = (message, status) => Object.assign(new Error(message), { status });
  assert.equal(cooldownSeconds(e("Error HTTP 429", 429)), 60);                         // Gemini: sin pista → 60 s
  assert.equal(cooldownSeconds(e("Rate limit reached ... Please try again in 12.495s.", 429)), 14); // Groq dice cuánto
  assert.equal(cooldownSeconds(e("Rate limit reached for model ... try again in 3s")), 4);
  assert.equal(cooldownSeconds(e("Failed to validate JSON", 400)), 0);                 // no es de límite
  assert.equal(cooldownSeconds(e("The model does not exist", 404)), 0);
});
