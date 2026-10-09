// Kino plugin: Bilibili v0.3.0
// Búsqueda por API + reproducción con browser.capture (anti-412)

const API = "https://api.bilibili.com";
const WEB = "https://www.bilibili.com";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
  Referer: "https://www.bilibili.com/",
  Origin: "https://www.bilibili.com",
};

function log(...args) {
  try {
    kino.log(...args);
  } catch {}
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

let warmed = false;
async function warmCookies() {
  if (warmed) return;
  try {
    await kino.fetch(WEB + "/", { headers: HEADERS, cookies: true, timeoutMs: 12000 });
    warmed = true;
  } catch (e) {
    log("warm", e && e.message);
  }
}

async function getJson(url) {
  await warmCookies();
  const r = await kino.fetch(url, { headers: HEADERS, cookies: true, timeoutMs: 20000 });
  if (!r.ok) {
    throw kino.error("unavailable", "HTTP " + r.status, {
      userMessage: "Bilibili no respondió (HTTP " + r.status + ")",
    });
  }
  const text = r.text();
  if (text.trim().startsWith("<")) {
    throw kino.error("unavailable", "blocked", {
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
    throw kino.error("unavailable", data.message || String(data.code), {
      userMessage: "Bilibili: " + (data.message || data.code),
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

// ---------- RESOLVE (browser capture) ----------
function pickStream(captures) {
  if (!captures || !captures.length) return null;

  // Preferir m3u8 / dash / mp4
  const scored = captures.map((c) => {
    const u = (c.url || "").toLowerCase();
    let score = 0;
    if (u.includes(".m3u8")) score += 30;
    if (u.includes("m4s") || u.includes("dash")) score += 20;
    if (u.includes(".mp4")) score += 25;
    if (u.includes("bilivideo")) score += 10;
    if (c.mime && c.mime.includes("mpegurl")) score += 15;
    if (c.mime && c.mime.includes("mp4")) score += 10;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0] && scored[0].c;
  if (!best || !best.url) return null;

  const headers = Object.assign(
    {
      Referer: "https://www.bilibili.com/",
      "User-Agent": HEADERS["User-Agent"],
    },
    best.headers || {}
  );

  const out = { url: best.url, headers };
  if (best.mime) out.mime = best.mime;
  return out;
}

export async function resolve(ref) {
  const s = String(ref);
  let bvid = s;
  if (s.startsWith("av")) {
    // resolver av → bvid por si acaso
    try {
      const view = await getJson(API + "/x/web-interface/view?aid=" + encodeURIComponent(s.slice(2)));
      if (view.data && view.data.bvid) bvid = view.data.bvid;
    } catch (e) {
      log("av resolve", e && e.message);
    }
  } else if (!s.startsWith("BV")) {
    bvid = s;
  }

  const pageUrl = WEB + "/video/" + encodeURIComponent(bvid);

  // 1) Intento rápido por API html5 (a veces funciona)
  try {
    const view = await getJson(
      API + "/x/web-interface/view?bvid=" + encodeURIComponent(bvid)
    );
    const cid = view.data && view.data.cid;
    if (cid) {
      const play = await getJson(
        API +
          "/x/player/playurl?bvid=" +
          encodeURIComponent(bvid) +
          "&cid=" +
          cid +
          "&qn=32&fnval=1&platform=html5"
      );
      const d = play.data;
      if (d && d.durl && d.durl[0] && d.durl[0].url) {
        return {
          url: d.durl[0].url,
          headers: {
            Referer: pageUrl,
            "User-Agent": HEADERS["User-Agent"],
          },
          mime: "video/mp4",
        };
      }
    }
  } catch (e) {
    log("api play failed, using browser", e && e.message);
  }

  // 2) Navegador oculto: abre la página y captura el stream real
  if (typeof kino.browser === "undefined" || typeof kino.browser.capture !== "function") {
    throw kino.error("unavailable", "no browser", {
      userMessage:
        "Este plugin necesita el navegador oculto. Actualiza Kino e instala de nuevo aceptando el permiso.",
    });
  }

  let captures;
  try {
    captures = await kino.browser.capture(pageUrl, {
      // deja que la página cargue y pulse play
      timeoutMs: 45000,
    });
  } catch (e) {
    log("capture error", e && e.code, e && e.message);
    const code = e && e.code;
    if (code === "blocked") {
      throw kino.error("unavailable", "captcha", {
        userMessage: "Bilibili pidió verificación humana. No se puede abrir este video.",
      });
    }
    throw kino.error("unavailable", "capture fail", {
      userMessage: "No se pudo abrir el video en el navegador oculto.",
    });
  }

  const stream = pickStream(captures);
  if (stream) return stream;

  throw kino.error("unavailable", "no stream found", {
    userMessage:
      "No se encontró stream. Bilibili puede estar bloqueando tu región. Prueba otro video o con VPN.",
  });
}
