

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORTA = 8080;
const ALPHA = 0.3;              // filtro passa-baixa (0..1, menor = mais suave)
const INTERVALO_ENVIO_MS = 33;  // ~30 atualizacoes/s para o navegador

// ---------------- Servidor HTTP (entrega a pagina) -----------
const servidor = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    fs.readFile(path.join(__dirname, "index.html"), (erro, dados) => {
      if (erro) { res.writeHead(500); return res.end("index.html nao encontrado"); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(dados);
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ---------------- Dois "canais" WebSocket na mesma porta -----
const wssEsp = new WebSocketServer({ noServer: true });      // ESP32
const wssBrowser = new WebSocketServer({ noServer: true });  // navegadores

servidor.on("upgrade", (req, socket, head) => {
  const caminho = req.url.split("?")[0];
  const alvo = caminho === "/browser" ? wssBrowser : wssEsp;  // qualquer outro caminho = ESP32
  alvo.handleUpgrade(req, socket, head, (ws) => alvo.emit("connection", ws, req));
});

// ---------------- Estado dos jogadores -----------------------
const jogadores = new Map();
let proximoId = 1;

wssEsp.on("connection", (ws, req) => {
  const id = proximoId++;
  const ip = (req.socket.remoteAddress || "").replace("::ffff:", "");
  jogadores.set(id, { id, ip, x: 0, y: 0, z: 1, pitch: 0, roll: 0, contagem: 0, taxa: 0 });
  console.log(`[ESP32 #${id}] conectado (${ip})`);

  ws.on("message", (dados) => {
    let m;
    try { m = JSON.parse(dados.toString()); } catch (e) { return; }
    if (typeof m.x !== "number" || typeof m.y !== "number" || typeof m.z !== "number") return;

    const j = jogadores.get(id);
    if (!j) return;

    // Filtro passa-baixa: suaviza o ruido do acelerometro
    j.x += ALPHA * (m.x - j.x);
    j.y += ALPHA * (m.y - j.y);
    j.z += ALPHA * (m.z - j.z);

    // Inclinacao em graus a partir da gravidade
    j.roll  = Math.atan2(j.y, j.z) * 180 / Math.PI;
    j.pitch = Math.atan2(-j.x, Math.sqrt(j.y * j.y + j.z * j.z)) * 180 / Math.PI;
    j.contagem++;
  });

  ws.on("close", () => {
    jogadores.delete(id);
    console.log(`[ESP32 #${id}] desconectado`);
  });

  ws.on("error", () => {});
});

wssBrowser.on("connection", (ws, req) => {
  console.log(`[Navegador] conectado (${req.socket.remoteAddress})`);
  ws.on("close", () => console.log("[Navegador] desconectado"));
  ws.on("error", () => {});
});

// ---------------- Envio periodico para os navegadores --------
setInterval(() => {
  if (wssBrowser.clients.size === 0) return;

  const pacote = JSON.stringify({
    tipo: "estado",
    enviadoEm: Date.now(),
    jogadores: [...jogadores.values()].map((j) => ({
      id: j.id, ip: j.ip, taxa: j.taxa,
      x: +j.x.toFixed(3), y: +j.y.toFixed(3), z: +j.z.toFixed(3),
      pitch: +j.pitch.toFixed(1), roll: +j.roll.toFixed(1)
    }))
  });

  for (const cliente of wssBrowser.clients) {
    if (cliente.readyState === 1) cliente.send(pacote);
  }
}, INTERVALO_ENVIO_MS);

// ---------------- Taxa de amostras por ESP32 (a cada 1 s) ----
setInterval(() => {
  for (const j of jogadores.values()) { j.taxa = j.contagem; j.contagem = 0; }
}, 1000);

servidor.listen(PORTA, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORTA}`);
  console.log(`Jogo:   http://SEU_IP:${PORTA}`);
  console.log(`ESP32:  ws://SEU_IP:${PORTA}/`);
});
