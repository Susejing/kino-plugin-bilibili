// Kino plugin: Bilibili (v0.1.2)
// Búsqueda + reproducción con platform=html5 (menos bloqueos)

const API = "https://api.bilibili.com";
const WEB = "https://www.bilibili.com";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  Referer: "https://www.bilibili.com",
  Origin: "https://www.bilibili.com",
};

function log(...args) {
  try {
    kino.log(...args);
  } catch {}
}

let warmed = false;
async function warmCookies() {
  if (warmed) return;
  try {
    await kino.fetch(WEB + "/", {
      headers: HEADERS,
      cookies: true,
      timeoutMs: 12000,
    });
    // también pega a la API para que setee cookies de api.bilibili.com
    await kino.fetch(API + "/x/web-interface/nav", {
      headers: HEADERS,
      cookies: true,
      timeoutMs: 10000,
    });
    warmed = true;
  } catch (e) {
    log("warm cookies failed", e && e.message);
  }
}

async function getJson(url) {
  await warmCookies();
  const r = await kino.fetch(url, {
    headers: HEADERS,
    cookies: true,
    timeoutMs: 20000,
  });
  if (!r.ok) {
    throw kino.error("unavailable", "HTTP " + r.status, {
      userMessage: "Bilibili no respondió (HTTP " + r.status + ")",
    });
  }
  const text = r.text();
  if (text.trim().startsWith("<") || text.includes("出错啦")) {
    throw kino.error("unavailable", "blocked html", {
      userMessage: "Bilibili bloqueó la petición. Prueba otro video o más tarde.",
    });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw kino.error("unavailable", "not json", {
      userMessage: "Bilibili devolvió una respuesta inválida",
    });
  }
  if (data.code !== 0 && data.code !== undefined) {
    const msg = data.message || "Error " + data.code;
    // -412 = bloqueo anti-bot
    if (data.code === -412 || data.code === 412) {
      throw kino.error("unavailable", msg, {
        userMessage: "Bilibili bloqueó esta petición (-412). Prueba otro video.",
      });
    }
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
  return [
    {
      id: "popular",
      title: "Populares en Bilibili",
      items: list.slice(0, 20).map(toVideoItem),
    },
  ];
}

// ---------- RESOLVE ----------
export async function resolve(ref) {
  let bvid = null;
  let aid = null;
  const s = String(ref);

  if (s.startsWith("BV")) bvid = s;
  else if (s.startsWith("av")) aid = s.slice(2);
  else bvid = s;

  // 1) Metadatos del video (cid)
  let viewUrl = API + "/x/web-interface/view?";
  if (bvid) viewUrl += "bvid=" + encodeURIComponent(bvid);
  else viewUrl += "aid=" + encodeURIComponent(aid);

  const view = await getJson(viewUrl);
  const videoData = view.data;
  if (!videoData) {
    throw kino.error("not_found", "no data", {
      userMessage: "No se encontró ese video en Bilibili",
    });
  }

  const cid = videoData.cid;
  const realBvid = videoData.bvid;
  const realAid = videoData.aid;

  const streamHeaders = {
    Referer: "https://www.bilibili.com/video/" + realBvid,
    "User-Agent": HEADERS["User-Agent"],
    Origin: "https://www.bilibili.com",
  };

  // 2) Intentar varias formas de playurl (html5 primero = MP4, menos bloqueos)
  const attempts = [
    // html5 → MP4 directo, suele ser el más permisivo
    API +
      "/x/player/playurl?bvid=" +
      encodeURIComponent(realBvid) +
      "&cid=" +
      cid +
      "&qn=64&fnval=1&platform=html5&high_quality=1",
    // calidad baja html5
    API +
      "/x/player/playurl?bvid=" +
      encodeURIComponent(realBvid) +
      "&cid=" +
      cid +
      "&qn=16&fnval=1&platform=html5",
    // clásico flv/mp4
    API +
      "/x/player/playurl?bvid=" +
      encodeURIComponent(realBvid) +
      "&cid=" +
      cid +
      "&qn=32&fnval=0",
    // con avid
    API +
      "/x/player/playurl?avid=" +
      realAid +
      "&cid=" +
      cid +
      "&qn=32&fnval=1&platform=html5",
  ];

  let lastErr = null;
  for (const playUrl of attempts) {
    try {
      const play = await getJson(playUrl);
      const d = play.data;
      if (!d) continue;

      if (d.durl && d.durl.length && d.durl[0].url) {
        return {
          url: d.durl[0].url,
          headers: streamHeaders,
          mime: "video/mp4",
        };
      }

      // DASH (solo video; puede ir sin audio)
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
    } catch (e) {
      lastErr = e;
      log("playurl attempt failed", playUrl.slice(0, 80), e && e.message);
    }
  }

  if (lastErr) throw lastErr;
  throw kino.error("unavailable", "no stream", {
    userMessage: "No se pudo obtener el video. Prueba otro título.",
  });
}
