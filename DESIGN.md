# DESIGN — TikTok-while-thinking hook

**Estado:** Draft v0.1 — pendiente de aprobación
**Spec base:** [SPEC.md](./SPEC.md) v0.2
**Fecha:** 2026-05-19

---

## 1. Resumen de arquitectura

Tres procesos disjuntos colaboran vía un archivo de estado en `%TEMP%`:

```
Claude Code (CLI)
   │
   ├─ UserPromptSubmit ──► powershell ──► node src/cli.mjs play
   ├─ Stop              ──► powershell ──► node src/cli.mjs pause
   ├─ Notification      ──► powershell ──► node src/cli.mjs pause
   └─ SessionEnd        ──► powershell ──► node src/cli.mjs cleanup
                                              │
                                              ▼
                                  ┌────────────────────────┐
                                  │  state.json (%TEMP%)   │
                                  │  - chromePid           │
                                  │  - cdpPort             │
                                  │  - sessionId           │
                                  │  - playState           │
                                  │  - tabOpenedAt         │
                                  └────────────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────────┐
                              │ Chrome.exe (perfil dedicado)    │
                              │ --remote-debugging-port=<rand>  │
                              │ --user-data-dir=%TEMP%\...      │
                              │ Tab: tiktok.com/foryou          │
                              └─────────────────────────────────┘
```

**Por qué sin daemon:** un daemon de larga vida agrega complejidad (socket IPC, lifecycle, cleanup). Cada hook es un script Node corto (~80ms startup) que lee state.json, se conecta a CDP, hace su acción, y sale. Cumple AC-1.1 (<3s cold) y AC-3.1 (<500ms hot).

## 2. Layout del proyecto

```
C:\Users\Jbalerioecheverria\claude-tiktok-hook\
├── SPEC.md
├── DESIGN.md
├── package.json
├── package-lock.json
├── node_modules/                 (gitignore)
├── src/
│   ├── cli.mjs                   # entrypoint: dispatch play|pause|cleanup
│   ├── browser.mjs               # detectar Chrome, lanzar con CDP, esperar ready
│   ├── tiktok.mjs                # buscar tab tiktok, .play()/.pause() vía CDP
│   ├── state.mjs                 # leer/escribir state.json atómicamente
│   └── log.mjs                   # logger condicional (errores siempre, verbose con DEBUG)
└── hooks/
    ├── on-prompt.ps1             # → cli.mjs play (Play en submit)
    ├── on-pause.ps1              # → cli.mjs pause (Stop / Notification)
    └── on-end.ps1                # → cli.mjs cleanup (SessionEnd)
```

## 3. Estado persistido — `%TEMP%\claude-tiktok-state.json`

```json
{
  "sessionId": "a1b2c3d4",
  "chromePid": 12345,
  "userDataDir": "C:\\Users\\...\\AppData\\Local\\Temp\\claude-tiktok-profile",
  "cdpPort": 53921,
  "playState": "playing",
  "tabTargetId": "AB12CD34...",
  "createdAt": "2026-05-19T10:30:00Z",
  "lastEventAt": "2026-05-19T10:32:15Z"
}
```

- **sessionId:** UUID corto para diferenciar runs. Si llega un hook con `sessionId` mismatch (raro), se trata como nueva sesión.
- **chromePid:** PID del Chrome lanzado. En cada hook se verifica `Process.kill(pid, 0)` para detectar si Chrome murió; si murió, se relanza.
- **cdpPort:** puerto aleatorio elegido al lanzar Chrome (rango 50000–60000). Persistido para que hooks posteriores se conecten al mismo puerto.
- **playState:** `"playing" | "paused" | "unknown"`. Usado para idempotencia (AC-3.3).
- **tabTargetId:** CDP target ID de la pestaña de TikTok. Acelera los hot paths (skip `GET /json` filter).
- **lastEventAt:** para detectar staleness; si > 24h, se descarta state.

**Escritura atómica:** escribir a `state.json.tmp` y `fs.rename()` para evitar corrupción si dos hooks corren simultáneos.

## 4. Sesión: secuencia de eventos

### 4.1 Primer prompt de la sesión (cold path)

```
User envía prompt
└─► UserPromptSubmit hook dispara
    └─► on-prompt.ps1 spawnea node cli.mjs play (async)
        └─► cli.mjs:
            1. Lee state.json
            2. state.json no existe o sessionId distinto / Chrome PID muerto
            3. browser.detectChrome() → C:\Program Files\Google\Chrome\Application\chrome.exe
            4. browser.pickPort() → ej. 53921 (testea con net.createServer)
            5. browser.launch(chromePath, port, userDataDir):
               - spawn chrome.exe con flags
               - polling de http://localhost:53921/json/version hasta responder (timeout 5s)
               - retorna { pid }
            6. tiktok.openTab(port, "https://www.tiktok.com/foryou"):
               - playwright.chromium.connectOverCDP("http://localhost:53921")
               - context.newPage()
               - page.goto(url)
               - page.evaluate(() => document.querySelector('video')?.play())
               - retorna targetId
            7. state.write({ sessionId, chromePid, cdpPort, playState: "playing", tabTargetId, ... })
            8. exit
```

### 4.2 Stop / Notification (hot path — pausa)

```
Claude termina turno o pregunta
└─► Stop hook (o Notification) dispara
    └─► on-pause.ps1 spawnea node cli.mjs pause (async)
        └─► cli.mjs:
            1. Lee state.json. Si no existe → exit 0 (nada que pausar).
            2. Si playState === "paused" → exit 0 (idempotencia).
            3. tiktok.pause(cdpPort, tabTargetId):
               - playwright connectOverCDP(port)
               - page = pages.find(p => p._target._targetId === tabTargetId)
               - si no existe: usuario cerró la pestaña → state.markTabClosed(); exit 0
               - page.evaluate(() => document.querySelectorAll('video').forEach(v => v.pause()))
            4. state.update({ playState: "paused", lastEventAt: now })
            5. exit
```

### 4.3 UserPromptSubmit posterior (hot path — reanudar)

```
Mismo flujo que 4.2 pero con .play() y playState: "playing".
Si state.tabClosed === true (usuario cerró manualmente) → exit 0, no reabrir (AC-4.2).
```

### 4.4 SessionEnd (cleanup)

```
Claude Code termina sesión
└─► SessionEnd hook dispara
    └─► on-end.ps1 spawnea node cli.mjs cleanup (async)
        └─► cli.mjs:
            1. Lee state.json. Si no existe → exit 0.
            2. NO mata Chrome (FR-6: pestaña queda abierta).
            3. Borra state.json (próxima sesión arranca limpia → AC-1.3).
            4. exit
```

## 5. Detalles técnicos clave

### 5.1 Detección de Chrome (`browser.detectChrome`)

```js
const candidates = [
  process.env.PROGRAMFILES + "\\Google\\Chrome\\Application\\chrome.exe",
  process.env["PROGRAMFILES(X86)"] + "\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
];
return candidates.find(p => existsSync(p)) ?? null;
```

Si retorna null → log warning, state no se escribe, hook termina silencioso (AC-1.5).

### 5.2 Lanzamiento de Chrome (`browser.launch`)

```js
const args = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=ChromeWhatsNewUI",
  "https://www.tiktok.com/foryou",
];
const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
child.unref();  // permite que cli.mjs termine sin matar Chrome
```

Espera al puerto CDP con polling:

```js
async function waitForCdp(port, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://localhost:${port}/json/version`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("CDP timeout");
}
```

### 5.3 Conexión Playwright + control del video (`tiktok.play` / `tiktok.pause`)

```js
import { chromium } from "playwright-core";

async function getTikTokPage(port, tabTargetId) {
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      const url = page.url();
      if (url.includes("tiktok.com")) return { browser, page };
    }
  }
  return { browser, page: null };
}

export async function pause(port, tabTargetId) {
  const { browser, page } = await getTikTokPage(port, tabTargetId);
  if (!page) { await browser.close(); return { closed: true }; }
  await page.evaluate(() => {
    document.querySelectorAll("video").forEach(v => v.pause());
  });
  await browser.close();
  return { ok: true };
}

export async function play(port, tabTargetId) {
  const { browser, page } = await getTikTokPage(port, tabTargetId);
  if (!page) { await browser.close(); return { closed: true }; }
  await page.evaluate(() => {
    const videos = document.querySelectorAll("video");
    if (videos.length === 0) return;
    // TikTok solo reproduce uno a la vez; el que tiene tiempo > 0 o el primero
    const active = Array.from(videos).find(v => !v.paused) || videos[0];
    active.play().catch(() => {});
  });
  await browser.close();
  return { ok: true };
}
```

**Nota sobre `playwright-core` vs `playwright`:** usamos `playwright-core` (~5MB) porque NO necesitamos browsers bundleados — usamos el Chrome del sistema vía CDP. Esto cumple NFR-5 (<100MB total).

### 5.4 Logging condicional (`log.mjs`)

```js
const DEBUG = process.env.CLAUDE_TIKTOK_DEBUG === "1";
const LOG_PATH = path.join(os.tmpdir(), "claude-tiktok-hook.log");

export function error(msg, err) {
  const line = `[${new Date().toISOString()}] ERROR ${msg}${err ? ": " + err.stack : ""}\n`;
  appendFileSync(LOG_PATH, line);
}

export function debug(msg) {
  if (!DEBUG) return;
  const line = `[${new Date().toISOString()}] DEBUG ${msg}\n`;
  appendFileSync(LOG_PATH, line);
}
```

### 5.5 Race conditions

Posibles carreras:
1. **Dos hooks simultáneos** — ej: usuario manda prompt mientras `Stop` previo todavía corre. **Mitigación:** lock file con `fs.openSync(lockPath, "wx")`. Si lock existe, esperar 500ms con retry × 3, luego abortar.
2. **Chrome muerto entre lectura de state y conexión CDP** — **Mitigación:** wrap connect en try/catch; si falla, log y exit. El próximo prompt detectará Chrome muerto y relanzará.
3. **Múltiples sesiones de Claude Code corriendo** — out of scope v1. La primera gana; las siguientes leerán el mismo state y compartirán Chrome. Aceptable.

### 5.6 Performance estimada

| Path | Operaciones | Estimado |
|------|-------------|----------|
| Cold (primer prompt) | node start + detect + spawn Chrome + CDP wait + connect + goto + play | 2.0–2.8s |
| Hot pause/play | node start + read state + CDP connect + evaluate | 200–400ms |
| Cleanup | node start + delete file | 80–120ms |

Cumple AC-1.1 (<3s) y AC-3.1 (<500ms). Si en testing AC-3.1 falla, optimización: reemplazar `playwright-core` en hot path con WebSocket CDP raw (`ws` package, ~30KB).

## 6. Hooks en `~/.claude/settings.json`

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{
        "type": "command",
        "command": "powershell",
        "args": ["-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File","C:\\Users\\Jbalerioecheverria\\claude-tiktok-hook\\hooks\\on-prompt.ps1"],
        "async": true
      }]}
    ],
    "Stop": [
      { "hooks": [{
        "type": "command",
        "command": "powershell",
        "args": ["-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File","C:\\Users\\Jbalerioecheverria\\claude-tiktok-hook\\hooks\\on-pause.ps1"],
        "async": true
      }]}
    ],
    "Notification": [
      { "hooks": [{
        "type": "command",
        "command": "powershell",
        "args": ["-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File","C:\\Users\\Jbalerioecheverria\\claude-tiktok-hook\\hooks\\on-pause.ps1"],
        "async": true
      }]}
    ],
    "SessionEnd": [
      { "hooks": [{
        "type": "command",
        "command": "powershell",
        "args": ["-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File","C:\\Users\\Jbalerioecheverria\\claude-tiktok-hook\\hooks\\on-end.ps1"],
        "async": true
      }]}
    ]
  }
}
```

PowerShell wrapper script (idéntico patrón para los tres):

```powershell
# on-prompt.ps1
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path $PSScriptRoot -Parent
Start-Process -FilePath "node" -ArgumentList "$root\src\cli.mjs", "play" -WindowStyle Hidden -NoNewWindow
```

`Start-Process` con `-NoNewWindow` para no flashear consola. Sin `-Wait` para async real (FR-5).

## 7. Manejo de errores — política

| Tipo de error | Acción |
|---------------|--------|
| Chrome no instalado | Log warning, exit 0, hook termina sin afectar Claude |
| Puerto CDP no responde | Log error, exit 0, próximo hook relanzará |
| Pestaña TikTok cerrada por usuario | Log debug, marcar en state, no reabrir (AC-4.2) |
| State.json corrupto | Borrar y tratar como primera sesión |
| Node no instalado | El hook PowerShell falla; Claude Code muestra mensaje en /hooks pero sigue funcionando |
| Playwright no instalado | cli.mjs `import` falla; log error en stderr (capturado por hook si verbose) |

**Principio:** ningún error de este hook debe romper la experiencia de Claude Code (NFR-2 + AC-5.1).

## 8. Testing

### 8.1 Tests unitarios (Node `--test`)
- `state.mjs`: read/write/atomic-rename con FS mock
- `browser.detectChrome()`: con paths mockeados
- `tiktok.getTikTokPage()`: con CDP server mock (responde JSON estático)

### 8.2 Tests de integración manual
- **T-1 (cold start):** borrar `state.json`, mandar prompt; verificar que Chrome lanza, TikTok abre, video reproduce. Cronometrar < 3s.
- **T-2 (pause hot path):** después de T-1, esperar que Claude responda; verificar que video pausa. Cronometrar < 500ms.
- **T-3 (resume):** mandar otro prompt; verificar que video reanuda desde donde pausó.
- **T-4 (idempotencia):** ejecutar `node cli.mjs pause` dos veces; segunda debe ser no-op.
- **T-5 (tab cerrado):** cerrar pestaña TikTok a mano, mandar prompt; verificar que NO reabre.
- **T-6 (Chrome ausente):** renombrar `chrome.exe`, mandar prompt; verificar que log warning y Claude funciona normal.
- **T-7 (cleanup):** terminar Claude Code; verificar que pestaña queda abierta y `state.json` borrado.

## 9. Open items para validación

| # | Item | Pregunta |
|---|------|----------|
| OI-1 | Autoplay policy de Chrome | Chrome bloquea autoplay con sonido sin interacción del usuario. ¿Aceptamos que el primer video arranca con audio bloqueado hasta que el user haga click? Alternativa: `--autoplay-policy=no-user-gesture-required` flag al lanzar Chrome. |
| OI-2 | TikTok rate-limiting / login wall | Si la cookie no existe en el perfil dedicado, TikTok puede mostrar wall de login. ¿Aceptamos que usuario hace login una vez en el perfil dedicado, y queda persistido? El user-data-dir persiste entre sesiones. |
| OI-3 | Hook event `SessionEnd` | Confirmar que Claude Code dispara `SessionEnd` (existe en el schema pero no listé entre los principales). Si no, usar `Stop` final con detección de "shutting down" — más frágil. |

---

**Próximo paso si se aprueba:** instalar Node + Playwright e implementar `src/` y `hooks/`.
