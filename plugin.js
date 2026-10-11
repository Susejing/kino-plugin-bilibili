{
  "id": "bilibili",
  "name": "Bilibili",
  "version": "0.6.0",
  "apiVersion": 6,
  "entry": "plugin.js",
  "description": "Busca y explora videos de Bilibili. La reproducción puede requerir VPN o cookie SESSDATA fuera de Asia.",
  "author": "Susejing",
  "homepage": "https://github.com/Susejing/kino-plugin-bilibili",
  "hosts": [
    "api.bilibili.com",
    "www.bilibili.com",
    "*.bilibili.com",
    "*.bilivideo.com"
  ],
  "streamHosts": "any",
  "capabilities": ["search", "home", "resolve"],
  "color": "#FB7299",
  "categories": ["anime", "movies", "series"],
  "settings": [
    {
      "key": "sessdata",
      "label": "Cookie SESSDATA",
      "type": "password",
      "hint": "Opcional. Si usas VPN o estás en Asia, a veces ayuda. F12 → Application → Cookies → SESSDATA"
    }
  ]
}
