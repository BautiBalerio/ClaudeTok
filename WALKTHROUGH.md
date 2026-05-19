# WALKTHROUGH — Qué se hizo, cómo se hizo, cómo funciona

Documento narrativo del proyecto. Pensado para que alguien que cae fresco entienda el contexto, el camino y la pieza final, sin tener que leer SPEC + DESIGN en orden.

---

## 1. El pedido original

> "me gustaría crear un agente que se active mientras claude code piensa y abra una pestaña de google con tiktok, una vez claude termine de pensar o haga una pregunta, el tiktok se pone pausa y te da la opción para responderle a claude, cuando vuelve a pensar vuelve a activar el tiktok"

Resumen: matar tiempo viendo TikTok mientras Claude procesa, sin perderte la respuesta cuando termina.

## 2. El camino que tomamos (SDD)

Trabajamos en formato **Spec-Driven Development**: documento primero, código después.

### 2.1 Fase de requirements

Cuatro preguntas clave decidieron la arquitectura:

| Pregunta | Decisión |
|----------|----------|
| ¿Qué cuenta como "pensando"? | Continuo — reproducir desde primer prompt hasta fin de turno |
| ¿Qué navegador? | Default del sistema (terminó siendo **Chrome forzado** por requisito CDP) |
| ¿Cómo controlar TikTok sin afectar otros media? | **Chrome DevTools Protocol** (no tecla media global) |
| ¿Qué hacer al cerrar Claude Code? | Dejar la pestaña abierta |

Una quinta pregunta resolvió el stack al descubrir que Node.js no estaba instalado: **Node + Playwright (playwright-core)**.

Estas decisiones se cristalizaron en [SPEC.md](./SPEC.md): 6 functional requirements (FR-1…FR-6), 6 non-functional, acceptance criteria explícitos, out-of-scope claro.

### 2.2 Fase de diseño

Con el SPEC aprobado, [DESIGN.md](./DESIGN.md) detalló:

- **Arquitectura de 3 procesos** disjuntos coordinados vía archivo de estado
- **Sin daemon** (cada hook es un Node corto que conecta a CDP y sale)
- **Estructura de archivos** del repo (src/cli.mjs, src/browser.mjs, etc.)
- **Secuencias de eventos** paso a paso para cold start, hot path, cleanup
- **Manejo de errores** explícito en tabla
- **Plan de testing** T-1 a T-7

Tres Open Items (autoplay policy, login wall, evento SessionEnd) quedaron asumidos con defaults.

### 2.3 Fase de implementación

1. Instalar Node.js LTS via `winget install OpenJS.NodeJS.LTS`
2. `npm install playwright-core`
3. Escribir 5 módulos en `src/` (~250 líneas total)
4. Escribir 3 wrappers PowerShell en `hooks/`
5. Smoke test manual del CLI (no hooks aún) — cold start 1.5s, hot path 1.2s, transiciones OK
6. Cableado de hooks en `~/.claude/settings.json` — **bloqueado por el classifier** (self-modification), queda para el usuario hacer manual

---

## 3. Arquitectura — narrativa

Imaginá tres actores que NO se conocen entre sí:

```
   ┌─────────────────┐
   │  Claude Code    │  ← dispara eventos (hooks) en su lifecycle
   │  (PowerShell)   │
   └────────┬────────┘
            │ spawn async
            ▼
   ┌─────────────────┐
   │  Node CLI       │  ← script corto: lee estado, conecta a CDP, hace su acción, sale
   │  (~50ms a 1.5s) │
   └────────┬────────┘
            │ HTTP /json + WebSocket
            ▼
   ┌─────────────────┐
   │  Chrome dedicado│  ← lanzado con perfil aislado en %TEMP%, expone CDP en puerto aleatorio
   │  TikTok abierto │
   └─────────────────┘

   ╔═════════════════════════╗
   ║ %TEMP%\..state.json     ║  ← memoria compartida entre invocaciones del CLI
   ║ (PID Chrome, port CDP,  ║
   ║  playState, ...)        ║
   ╚═════════════════════════╝
```

**Decisión clave: sin daemon.** Un daemon Node de larga vida tendría hot path < 50ms (mantiene la conexión CDP abierta), pero suma complejidad (socket IPC, lifecycle, cleanup, race conditions con múltiples Claudes). Aceptamos ~1.2s en hot path a cambio de simplicidad. Para el usuario es imperceptible — la pausa pasa antes de que termine de leer la respuesta.

**Por qué CDP y no tecla media global:** la tecla `0xB3` (play/pause global de Windows) es un *toggle* y se enruta al "último media player activo" del SO. Si tenés Spotify, YouTube en otra pestaña, o cualquier otro reproductor, el toggle puede irse al equivocado. CDP nos da acceso quirúrgico al elemento `<video>` específico de la pestaña TikTok.

**Por qué perfil de Chrome dedicado:** lanzar Chrome con `--remote-debugging-port` en el perfil principal del usuario abre puertas de seguridad (cualquier proceso local con CDP puede ver TUS tabs, cookies, etc). Un perfil dedicado en `%TEMP%\claude-tiktok-profile` aísla: solo está TikTok, no hay credenciales de otros sitios, no se mezcla con tu Chrome normal.

---

## 4. Qué pasa en cada momento

### 4.1 Primer prompt de la sesión

```
TÚ                  Claude Code           on-prompt.ps1       node cli.mjs play
─────────────────────────────────────────────────────────────────────────────────
"hola, hacé X" ───► UserPromptSubmit ───► spawn async ──────► leer state.json
                                                              (no existe → cold)
                                                              ↓
                                                              detectChrome()
                                                              ↓
                                                              pickPort() → 64203
                                                              ↓
                                                              spawn chrome.exe \
                                                                --remote-debugging-port=64203 \
                                                                --user-data-dir=%TEMP%\...profile \
                                                                --autoplay-policy=no-user-gesture-required \
                                                                https://www.tiktok.com/foryou
                                                              ↓
                                                              waitForCdp(64203)
                                                              (polling 100ms hasta /json/version OK)
                                                              ↓
                                                              escribir state.json:
                                                              {
                                                                chromePid: 20608,
                                                                cdpPort: 64203,
                                                                playState: "playing",
                                                                ...
                                                              }
                                                              ↓
                                                              exit 0
```

Mientras tanto, **TikTok empieza a reproducirse solo** gracias al flag `--autoplay-policy=no-user-gesture-required`. Total: ~1.5s desde que apretaste Enter hasta el primer video corriendo.

### 4.2 Claude termina o pregunta

```
Claude termina ──► Stop event ──► on-pause.ps1 ──► node cli.mjs pause
                                                   ↓
                                                   leer state.json (existe, playing)
                                                   ↓
                                                   chromium.connectOverCDP("http://127.0.0.1:64203")
                                                   ↓
                                                   buscar page con URL conteniendo "tiktok.com"
                                                   ↓
                                                   page.evaluate(() =>
                                                     document.querySelectorAll("video")
                                                       .forEach(v => v.pause())
                                                   )
                                                   ↓
                                                   update state: { playState: "paused" }
                                                   ↓
                                                   exit 0
```

El JavaScript injectado corre dentro de la pestaña TikTok como si lo hubieras tipeado en la DevTools console. Toca solo los `<video>` de esa pestaña. **Tu Spotify, tu YouTube en otra ventana, todo lo demás queda intacto.**

Lo mismo pasa con `Notification` (Claude pide input/permiso) — mismo handler, misma pausa.

### 4.3 Próximo prompt

```
"otra cosa" ──► UserPromptSubmit ──► on-prompt.ps1 ──► node cli.mjs play
                                                       ↓
                                                       leer state.json (existe, paused)
                                                       ↓
                                                       chromePid sigue vivo? sí
                                                       ↓
                                                       NO es cold start → llamar tiktok.play()
                                                       ↓
                                                       conectar CDP, encontrar tab, ejecutar
                                                       document.querySelectorAll("video")[0].play()
                                                       ↓
                                                       update state: { playState: "playing" }
```

El video reanuda exactamente donde quedó (AC-4.1) porque solo llamamos `.play()`, no recargamos.

### 4.4 Cerraste Claude Code

`SessionEnd` dispara `on-end.ps1` → `cli.mjs cleanup` → borra `state.json`. **Chrome NO se mata** (FR-6). La pestaña queda abierta para que sigas mirando si querés.

Próxima sesión de Claude Code arranca limpia: no encuentra state, hace cold start (lanza una segunda ventana de Chrome con el mismo perfil dedicado).

---

## 5. Paseo por los archivos

### `src/cli.mjs` (dispatcher)

Lee `process.argv[2]`, ramifica a `cmdPlay()`, `cmdPause()`, `cmdCleanup()`, `cmdStatus()`. **Siempre termina con `exit 0`** aunque algo explote, para no romper Claude Code (NFR-2 + AC-5.1). Errores se loguean.

### `src/browser.mjs` (Chrome management)

- `detectChrome()`: prueba 3 paths estándar de Chrome en Windows
- `pickPort()`: `net.createServer().listen(0)` para conseguir un puerto libre del SO
- `waitForCdp()`: polling con `fetch /json/version` hasta que Chrome responda
- `launch()`: `spawn(chrome.exe, args, { detached: true })` + `child.unref()` para que el Node termine sin matar Chrome
- `readActivePort()` / `reuseIfActive()`: si Chrome ya está corriendo con nuestro perfil, lee `DevToolsActivePort` del profile (archivo que Chrome escribe automáticamente con su puerto CDP). Permite recuperación si el PID guardado murió pero Chrome sigue.

### `src/tiktok.mjs` (control del video)

Patrón `withBrowser`: connect → operation → close, con try/catch que captura todo y loguea. Operación principal es `page.evaluate(callback)` — el callback se serializa y corre dentro del contexto JS de la pestaña.

### `src/state.mjs` (memoria persistente)

`read`/`write`/`update`/`clear`. Escritura atómica con `writeFileSync(tmp)` + `renameSync(tmp, final)` — si dos hooks corren simultáneos (`UserPromptSubmit` y `Stop` previo todavía activo), evita corrupción.

### `src/log.mjs` (observabilidad)

Logger condicional. `error()` siempre escribe; `debug()` solo si `$env:CLAUDE_TIKTOK_DEBUG=1`. Una línea por entrada con timestamp ISO. Append-only en `%TEMP%\claude-tiktok-hook.log`.

### `hooks/*.ps1` (wrappers)

Patrón idéntico en los tres. Resuelven el path a `node.exe` con fallback (winget path absoluto → `Get-Command node` → exit 0), buscan `src/cli.mjs`, `Start-Process` sin `-Wait` para async real. Cada hook es 8 líneas.

---

## 6. Instalación y uso

Ver [README.md §Instalación de hooks](./README.md). Resumen:

1. **Pegar bloque `"hooks": {...}`** en `~/.claude/settings.json` (no lo hace Claude porque el classifier lo bloquea como self-modification)
2. Correr `/hooks` en Claude Code para que recargue, o reiniciar
3. Próximo prompt: se abre la ventana Chrome con TikTok
4. Loguearte una vez en TikTok (el perfil dedicado persiste cookies)

**Reset total** si algo se traba: borrar `%TEMP%\claude-tiktok-state.json` y `%TEMP%\claude-tiktok-profile\`, cerrar la ventana de Chrome dedicada.

---

## 7. Cuando algo falla

Mirá primero `%TEMP%\claude-tiktok-hook.log`. Después:

| Síntoma | Causa probable | Fix |
|---------|----------------|-----|
| No abre TikTok al primer prompt | Chrome no detectado / Node no encontrado por el wrapper PS | Verificar paths absolutos en `hooks/on-*.ps1` |
| Pestaña abre pero video no reproduce | Autoplay bloqueado | Click manual una vez; o re-verificar que el flag `--autoplay-policy=no-user-gesture-required` está pasando |
| Pausa el reproductor equivocado | NO debería pasar con CDP | Bug — abrir issue, log con `CLAUDE_TIKTOK_DEBUG=1` |
| `state.json` apunta a Chrome muerto | Cerraste Chrome a mano | `cleanup` y próximo prompt relanza |
| Hot path lento (>2s) | Antivirus escaneando node_modules | Excluir `claude-tiktok-hook\` del scan |

---

## 8. Limitaciones de v1 y caminos para v2

### Limitaciones conscientes

- **Hot path ~1.2s, no los <500ms del SPEC** — la mayor parte es carga de `playwright-core` por invocación (~500ms). Aceptado: imperceptible para humano.
- **Multi-sesión Claude Code no soportado oficialmente** — la segunda sesión lee mismo state y comparte Chrome. Funciona pero no es robusto.
- **Sin tests automatizados** — solo smoke test manual T-1…T-3. v1 minimalista.
- **Solo Windows** — los wrappers son `.ps1`, paths usan `\`, detección de Chrome usa env vars Windows. Linux/macOS requeriría reescritura de `hooks/` y ajustes en `browser.mjs`.

### v2 — si vale la pena

1. **WebSocket CDP directo en hot path** (reemplazar `playwright-core` por `ws`, ~30KB) → hot path bajaría a ~200ms y cumpliría AC-3.1.
2. **Daemon opcional** (Node service) que mantiene conexión CDP viva → hot path < 50ms. Más complejidad.
3. **Soporte Firefox** vía RDP (Firefox Remote Debugging Protocol) — protocolo distinto a CDP pero similar.
4. **Config runtime** (URL alternativa, perfil específico, enable/disable temporal) en `%TEMP%\claude-tiktok-config.json`.
5. **Plugin de Claude Code** (en lugar de hooks manuales) — empacar todo como `claude-plugin` instalable con un comando.

---

## 9. Por qué hicimos las cosas como las hicimos

Tres decisiones que parecen obvias en retrospectiva pero requirieron explicitarlas:

1. **CDP > tecla media** — al principio la tecla parece más simple (un script PowerShell de 10 líneas vs Node + Playwright). Pero la tecla rompe la promesa de "no afecta otros media" (NFR implícito que el usuario hubiera notado en producción). El extra de complejidad de CDP se paga solo.

2. **playwright-core > playwright completo** — `playwright` instala browsers Chromium/Firefox/Webkit (~250MB). `playwright-core` no instala browsers porque usamos el Chrome del sistema vía `connectOverCDP`. Cumple NFR-5 (<100MB total) con margen.

3. **Sin daemon** — la tentación de un servicio Node de larga vida es real. Pero un daemon necesita: socket IPC, manejo de signals, cleanup en crash, lifecycle coordinado con Claude Code (¿quién lo arranca? ¿quién lo mata?). El sobrecosto de 1s en hot path no justifica esa complejidad para v1.

---

**Referencias internas:** [SPEC.md](./SPEC.md), [DESIGN.md](./DESIGN.md), [README.md](./README.md), [CLAUDE.md](./CLAUDE.md).
