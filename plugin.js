// Kino plugin: Bilibili v0.2.0
// WBI sign + cookies para evitar 412 en playurl

const API = "https://api.bilibili.com";
const WEB = "https://www.bilibili.com";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Referer: "https://www.bilibili.com/",
  Origin: "https://www.bilibili.com",
};

// Tabla de mezcla WBI (oficial de Bilibili)
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

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

// ---------- cookies ----------
let warmed = false;
async function warmCookies() {
  if (warmed) return;
  try {
    await kino.fetch(WEB + "/", {
      headers: HEADERS,
      cookies: true,
      timeoutMs: 12000,
    });
    await kino.fetch(API + "/x/web-interface/nav", {
      headers: HEADERS,
      cookies: true,
      timeoutMs: 10000,
    });
    warmed = true;
  } catch (e) {
    log("warm failed", e && e.message);
  }
}

// ---------- WBI ----------
let wbiKeys = null; // { imgKey, subKey, ts }

async function getWbiKeys() {
  const now = Date.now();
  if (wbiKeys && now - wbiKeys.ts < 10 * 60 * 1000) return wbiKeys;

  await warmCookies();
  const r = await kino.fetch(API + "/x/web-interface/nav", {
    headers: HEADERS,
    cookies: true,
  });
  if (!r.ok) throw new Error("nav " + r.status);
  const data = JSON.parse(r.text());
  const img = (data.data && data.data.wbi_img) || {};
  const imgUrl = img.img_url || "";
  const subUrl = img.sub_url || "";
  const imgKey = imgUrl.split("/").pop().split(".")[0];
  const subKey = subUrl.split("/").pop().split(".")[0];
  if (!imgKey || !subKey) throw new Error("no wbi keys");
  wbiKeys = { imgKey, subKey, ts: now };
  return wbiKeys;
}

function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  let out = "";
  for (let i = 0; i < 32; i++) out += raw[MIXIN_KEY_ENC_TAB[i]];
  return out;
}

function encWbi(params, imgKey, subKey) {
  const mixin = getMixinKey(imgKey, subKey);
  const wts = Math.floor(Date.now() / 1000);
  const copy = Object.assign({}, params, { wts: String(wts) });
  const keys = Object.keys(copy).sort();
  const query = keys
    .map((k) => {
      // filtrar caracteres especiales como hace Bilibili
      const v = String(copy[k]).replace(/[!'()*]/g, "");
      return encodeURIComponent(k) + "=" + encodeURIComponent(v);
    })
    .join("&");
  const w_rid = kino.crypto.hash("md5", query + mixin);
  return query + "&w_rid=" + w_rid;
}

async function signedUrl(path, params) {
  const { imgKey, subKey } = await getWbiKeys();
  const qs = encWbi(params, imgKey, subKey);
  return API + path + "?" + qs;
}

// ---------- fetch JSON ----------
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
  if (text.trim().startsWith("<")) {
    throw kino.error("unavailable", "html block", {
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
    const msg = data.message || "Error " + data.code;
    if (data.code === -412) {
      throw kino.error("unavailable", msg, {
        userMessage: "Bilibili bloqueó esta petición (-412)",
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

  // all/v2 suele funcionar mejor que search/type
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
  const data = await getJson(
    API + "/x/web-interface/ranking/v2?rid=0&type=all"
  );
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
function streamFromPlayData(d, bvid) {
  const headers = {
    Referer: "https://www.bilibili.com/video/" + bvid,
    "User-Agent": HEADERS["User-Agent"],
    Origin: "https://www.bilibili.com",
  };

  if (d.durl && d.durl.length && d.durl[0].url) {
    return { url: d.durl[0].url, headers, mime: "video/mp4" };
  }

  if (d.dash && d.dash.video && d.dash.video.length) {
    // Preferir AVC (codecid 7) si existe; si no, el primero
    let video = d.dash.video.find((v) => v.codecid === 7) || d.dash.video[0];
    const url = video.baseUrl || video.base_url;
    if (url) return { url, headers };
  }
  return null;
}

export async function resolve(ref) {
  const s = String(ref);
  let bvid = null;
  let aid = null;
  if (s.startsWith("BV")) bvid = s;
  else if (s.startsWith("av")) aid = s.slice(2);
  else bvid = s;

  // 1) view → cid
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

  // 2) Intentos de playurl (de más permisivo a más estricto)
  const attempts = [];

  // html5 sin WBI
  attempts.push(
    API +
      "/x/player/playurl?bvid=" +
      encodeURIComponent(realBvid) +
      "&cid=" +
      cid +
      "&qn=32&fnval=1&platform=html5&high_quality=1"
  );
  attempts.push(
    API +
      "/x/player/playurl?avid=" +
      realAid +
      "&cid=" +
      cid +
      "&qn=16&fnval=1&platform=html5"
  );
  // clásico
  attempts.push(
    API +
      "/x/player/playurl?bvid=" +
      encodeURIComponent(realBvid) +
      "&cid=" +
      cid +
      "&qn=32&fnval=0"
  );

  // WBI firmado (el que más suele funcionar)
  try {
    const wbi1 = await signedUrl("/x/player/wbi/playurl", {
      bvid: realBvid,
      cid: String(cid),
      qn: "32",
      fnval: "16",
      fourk: "1",
      platform: "html5",
      high_quality: "1",
    });
    attempts.push(wbi1);

    const wbi2 = await signedUrl("/x/player/wbi/playurl", {
      bvid: realBvid,
      cid: String(cid),
      qn: "16",
      fnval: "1",
      platform: "html5",
    });
    attempts.push(wbi2);

    const wbi3 = await signedUrl("/x/player/wbi/playurl", {
      avid: String(realAid),
      cid: String(cid),
      qn: "32",
      fnval: "16",
      fourk: "1",
    });
    attempts.push(wbi3);
  } catch (e) {
    log("wbi build failed", e && e.message);
  }

  let lastErr = null;
  for (const url of attempts) {
    try {
      const play = await getJson(url);
      const stream = streamFromPlayData(play.data, realBvid);
      if (stream) return stream;
    } catch (e) {
      lastErr = e;
      log("play attempt fail", (e && e.message) || e);
    }
  }

  if (lastErr) throw lastErr;
  throw kino.error("unavailable", "no stream", {
    userMessage:
      "No se pudo obtener el video (bloqueo de Bilibili). Prueba otro título.",
  });
}
