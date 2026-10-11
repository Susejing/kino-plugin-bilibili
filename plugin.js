// Kino plugin: Bilibili v0.5.0
// buvid3 automático + SESSDATA opcional + Origin/Referer (anti-412)

const API = "https://api.bilibili.com";
const WEB = "https://www.bilibili.com";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function log(...args) {
  try {
    kino.log(...args);
  } catch {}
}

function sessdata() {
  let s = String(kino.config.get("sessdata") || "").trim();
  if (s.toLowerCase().startsWith("sessdata=")) s = s.slice(9).trim();
  return s;
}

// ---------- buvid (huella de dispositivo) ----------
let buvidCache = null;

async function ensureBuvid() {
  if (buvidCache) return buvidCache;

  // 1) intentar storage del plugin
  try {
    const saved = kino.storage.get("buvid");
    if (saved && saved.b3) {
      buvidCache = saved;
      return buvidCache;
    }
  } catch {}

  // 2) pedir a Bilibili
  try {
    const r = await kino.fetch(API + "/x/frontend/finger/spi", {
      headers: {
        "User-Agent": UA,
        Referer: WEB + "/",
        Origin: WEB,
      },
      timeoutMs: 12000,
    });
    if (r.ok) {
      const data = r.json();
      if (data && data.code === 0 && data.data) {
        buvidCache = {
          b3: data.data.b_3 || data.data.buvid3 || "",
          b4: data.data.b_4 || data.data.buvid4 || "",
        };
        try {
          kino.storage.set("buvid", buvidCache);
        } catch {}
        return buvidCache;
      }
    }
  } catch (e) {
    log("buvid fail", e && e.message);
  }

  // 3) fallback aleatorio (mejor que nada)
  const rand = () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const n = (Math.random() * 16) | 0;
      const v = c === "x" ? n : (n & 0x3) | 0x8;
      return v.toString(16);
    });
  buvidCache = { b3: rand() + "infoc", b4: rand() };
  try {
    kino.storage.set("buvid", buvidCache);
  } catch {}
  return buvidCache;
}

function cookieHeader() {
  const parts = [];
  const sd = sessdata();
  if (sd) parts.push("SESSDATA=" + sd);
  if (buvidCache) {
    if (buvidCache.b3) parts.push("buvid3=" + buvidCache.b3);
    if (buvidCache.b4) parts.push("buvid4=" + buvidCache.b4);
  }
  return parts.length ? parts.join("; ") : undefined;
}

function baseHeaders(extra) {
  const h = {
    "User-Agent": UA,
    Referer: WEB + "/",
    Origin: WEB,
  };
  const ck = cookieHeader();
  if (ck) h.Cookie = ck;
  if (extra) {
    for (const k in extra) h[k] = extra[k];
  }
  return h;
}

function cleanTitle(t) {
  return String(t || "").replace(/<[^>]+>/g, "").trim();
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

async function getJson(url, extraHeaders) {
  await ensureBuvid();
  const r = await kino.fetch(url, {
    headers: baseHeaders(extraHeaders),
    cookies: true,
    timeoutMs: 20000,
  });
  if (!r.ok) {
    throw kino.error("unavailable", "HTTP " + r.status, {
      userMessage: "Bilibili no respondió (HTTP " + r.status + ")",
    });
  }
  const text = r.text();
  if (text.trim().startsWith("<")) {
    throw kino.error("unavailable", "blocked html", {
      userMessage: "Bilibili bloqueó la petición",
    });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw kino.error("unavailable", "bad json", {
      userMessage: "Respuesta inválida de Bilibili",
    });
  }
  if (data.code !== 0 && data.code !== undefined) {
    const msg = data.message || String(data.code);
    if (data.code === -101) {
      throw kino.error("auth_required", msg, {
        userMessage:
          "Sesión inválida. Revisa SESSDATA en Ajustes ▸ Bilibili ▸ Configurar",
      });
    }
    if (data.code === -412 || data.code === 412) {
      throw kino.error("unavailable", msg, {
        userMessage: sessdata()
          ? "Bilibili bloqueó el stream (-412). Prueba renovar SESSDATA o VPN."
          : "Bilibili bloqueó el stream. Pon SESSDATA en Configurar o usa VPN.",
      });
    }
    throw kino.error("unavailable", msg, {
      userMessage: "Bilibili: " + msg,
    });
  }
  return data;
}

// ---------- SEARCH ----------
export async function search(query) {
  const q = (query.q || "").trim();
  if (!q) return [];

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
  const data = await getJson(API + "/x/web-interface/ranking/v2?rid=0&type=all");
  const list = (data.data && data.data.list) || [];
  return [
    {
      id: "popular",
      title: "Populares en Bilibili",
      items: list.slice(0, 20).map(toVideoItem),
    },
  ];
}

// ---------- RESOLVE ----------
function streamFromPlay(d, realBvid) {
  const headers = baseHeaders({
    Referer: WEB + "/video/" + realBvid,
  });

  if (d.durl && d.durl[0] && d.durl[0].url) {
    return {
      url: d.durl[0].url,
      headers,
      mime: "video/mp4",
    };
  }
  if (d.dash && d.dash.video && d.dash.video.length) {
    const v =
      d.dash.video.find((x) => x.codecid === 7) || d.dash.video[0];
    const u = v.baseUrl || v.base_url;
    if (u) return { url: u, headers };
  }
  return null;
}

export async function resolve(ref) {
  await ensureBuvid();

  const s = String(ref);
  let bvid = null;
  let aid = null;
  if (s.startsWith("BV")) bvid = s;
  else if (s.startsWith("av")) aid = s.slice(2);
  else bvid = s;

  let viewUrl = API + "/x/web-interface/view?";
  if (bvid) viewUrl += "bvid=" + encodeURIComponent(bvid);
  else viewUrl += "aid=" + encodeURIComponent(aid);

  const view = await getJson(viewUrl);
  const vd = view.data;
  if (!vd) {
    throw kino.error("not_found", "no data", {
      userMessage: "Video no encontrado",
    });
  }

  const cid = vd.cid;
  const realBvid = vd.bvid;
  const realAid = vd.aid;

  // Varios intentos de playurl (del más permisivo al más completo)
  const attempts = [
    // html5 MP4 (suele ser el más fácil fuera de China)
    API +
      "/x/player/playurl?bvid=" +
      encodeURIComponent(realBvid) +
      "&cid=" +
      cid +
      "&qn=64&fnval=1&platform=html5&high_quality=1",
    API +
      "/x/player/playurl?bvid=" +
      encodeURIComponent(realBvid) +
      "&cid=" +
      cid +
      "&qn=32&fnval=1&platform=html5",
    API +
      "/x/player/playurl?avid=" +
      realAid +
      "&cid=" +
      cid +
      "&qn=32&fnval=0&otype=json",
    // DASH
    API +
      "/x/player/playurl?bvid=" +
      encodeURIComponent(realBvid) +
      "&cid=" +
      cid +
      "&qn=64&fnval=16&fourk=1",
  ];

  let lastErr = null;
  for (const playUrl of attempts) {
    try {
      const play = await getJson(playUrl);
      const stream = streamFromPlay(play.data, realBvid);
      if (stream) return stream;
    } catch (e) {
      lastErr = e;
      log("play attempt fail", e && e.message);
    }
  }

  if (!sessdata()) {
    throw kino.error("auth_required", "need sessdata", {
      userMessage:
        "Para reproducir, pon SESSDATA en Ajustes ▸ Bilibili ▸ Configurar (o prueba VPN)",
    });
  }
  if (lastErr) throw lastErr;
  throw kino.error("unavailable", "no stream", {
    userMessage:
      "No se pudo obtener el video. Renueva SESSDATA o prueba VPN (HK/JP).",
  });
}
