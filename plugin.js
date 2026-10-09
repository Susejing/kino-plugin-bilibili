// Kino plugin: Bilibili (v0.1.1)
// Busca videos y obtiene streams básicos.

const API = "https://api.bilibili.com";
const WEB = "https://www.bilibili.com";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://www.bilibili.com",
};

function log(...args) {
  try {
    kino.log(...args);
  } catch {}
}

// Obtiene cookies (buvid3) visitando bilibili.com una vez
let warmed = false;
async function warmCookies() {
  if (warmed) return;
  try {
    await kino.fetch(WEB, { headers: HEADERS, cookies: true, timeoutMs: 12000 });
    warmed = true;
  } catch (e) {
    log("warm cookies failed", e && e.message);
  }
}

async function getJson(url) {
  await warmCookies();
  const r = await kino.fetch(url, { headers: HEADERS, cookies: true });
  if (!r.ok) {
    throw kino.error("unavailable", "Bilibili HTTP " + r.status, {
      userMessage: "Bilibili no respondió (HTTP " + r.status + ")",
    });
  }
  const text = r.text();
  // Si devuelve HTML (bloqueo anti-bot) en vez de JSON
  if (text.trim().startsWith("<") || text.includes("出错啦")) {
    throw kino.error("unavailable", "Bilibili bloqueó la petición", {
      userMessage: "Bilibili bloqueó la búsqueda. Prueba más tarde.",
    });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw kino.error("unavailable", "Respuesta no JSON", {
      userMessage: "Bilibili devolvió una respuesta inválida",
    });
  }
  if (data.code !== 0 && data.code !== undefined) {
    const msg = data.message || "Error " + data.code;
    throw kino.error("unavailable", msg, {
      userMessage: "Bilibili: " + msg,
    });
  }
  return data;
}

function cleanTitle(t) {
  return String(t || "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function posterUrl(pic) {
  if (!pic) return undefined;
  if (pic.startsWith("//")) return "https:" + pic;
  if (pic.startsWith("http")) return pic;
  return undefined;
}

function toVideoItem(v) {
  return {
    id: String(v.bvid || v.aid),
    ref: v.bvid || ("av" + v.aid),
    title: cleanTitle(v.title),
    kind: "movie",
    poster: posterUrl(v.pic),
    year: v.pubdate
      ? String(new Date(v.pubdate * 1000).getFullYear())
      : undefined,
    overview: cleanTitle(v.description || v.desc || "").slice(0, 300),
  };
}

// ---------- SEARCH ----------
export async function search(query) {
  const q = (query.q || "").trim();
  if (!q) return [];

  // all/v2 funciona mejor sin login que search/type
  const url =
    API +
    "/x/web-interface/search/all/v2?keyword=" +
    encodeURIComponent(q) +
    "&page=1";

  const data = await getJson(url);
  const blocks = (data.data && data.data.result) || [];
  const out = [];
  const seen = new Set();

  for (const block of blocks) {
    if (block.result_type !== "video") continue;
    const list = Array.isArray(block.data) ? block.data : [];
    for (const v of list) {
      const item = toVideoItem(v);
      if (!item.ref || seen.has(item.ref)) continue;
      seen.add(item.ref);
      out.push(item);
    }
  }

  return out;
}

// ---------- HOME ----------
export async function home() {
  const url = API + "/x/web-interface/ranking/v2?rid=0&type=all";
  const data = await getJson(url);
  const list = (data.data && data.data.list) || [];

  const items = list.slice(0, 20).map(toVideoItem);

  return [
    {
      id: "popular",
      title: "Populares en Bilibili",
      items,
    },
  ];
}

// ---------- RESOLVE ----------
export async function resolve(ref) {
  let bvid = null;
  let aid = null;

  if (String(ref).startsWith("BV")) {
    bvid = ref;
  } else if (String(ref).startsWith("av")) {
    aid = String(ref).slice(2);
  } else {
    bvid = ref;
  }

  let viewUrl = API + "/x/web-interface/view?";
  if (bvid) viewUrl += "bvid=" + encodeURIComponent(bvid);
  else viewUrl += "aid=" + encodeURIComponent(aid);

  const view = await getJson(viewUrl);
  const videoData = view.data;
  if (!videoData) {
    throw kino.error("not_found", "Video no encontrado", {
      userMessage: "No se encontró ese video en Bilibili",
    });
  }

  const cid = videoData.cid;
  const realBvid = videoData.bvid;

  // qn=64 = 720p (sin login a veces da menos)
  // fnval=16 pide DASH
  const playUrl =
    API +
    "/x/player/playurl?bvid=" +
    encodeURIComponent(realBvid) +
    "&cid=" +
    cid +
    "&qn=64&fnval=16&fourk=1";

  const play = await getJson(playUrl);
  const d = play.data;
  if (!d) {
    throw kino.error("unavailable", "Sin datos de stream", {
      userMessage: "No se pudo obtener el video",
    });
  }

  const streamHeaders = {
    Referer: "https://www.bilibili.com",
    "User-Agent": HEADERS["User-Agent"],
  };

  // Preferir durl (mp4/flv) porque es un solo archivo
  if (d.durl && d.durl.length) {
    return {
      url: d.durl[0].url,
      headers: streamHeaders,
    };
  }

  // DASH: video solo (sin audio unido) — Kino no mezcla pistas
  if (d.dash && d.dash.video && d.dash.video.length) {
    const video = d.dash.video[0];
    const url = video.baseUrl || video.base_url;
    if (url) {
      return {
        url,
        headers: streamHeaders,
      };
    }
  }

  throw kino.error("unavailable", "No se pudo obtener el stream", {
    userMessage: "Este video no se puede reproducir ahora",
  });
}
