# ClaudeTok

> Reproduce TikTok mientras Claude Code piensa. Pausa solo cuando termina o te pregunta. Sin tocar tu Spotify ni tu YouTube.

Hook nativo para [Claude Code](https://docs.anthropic.com/en/docs/claude-code) que abre una ventana dedicada de Chrome con TikTok y la sincroniza con el lifecycle del turno: **play en cada prompt enviado**, **pausa en cada `Stop` / `Notification`**. Control quirúrgico vía Chrome DevTools Protocol — no usa la tecla media global del SO, así que tu Spotify o YouTube en otra pestaña no se ven afectados.

**Estado:** v0.1 funcional · Windows 10/11 · Smoke tests pasados (cold start 1.5s, hot path 1.2s)

---

## ¿Por qué existe esto

Claude Code a veces se toma 30 segundos pensando un turno largo. En lugar de mirar el spinner, viendo TikTok. Cuando Claude termina, no querés perderte la respuesta — el video pausa solo y tenés foco para leer.

Es un experimento de cómo lejos se puede llevar el sistema de hooks de Claude Code para tareas no-relacionadas-con-código. Salió un proyecto chico (~250 líneas Node + 24 líneas PowerShell) pero con todo el ciclo SDD: spec primero, diseño después, código al final.

## Cómo funciona en una mirada

```
       Vos                Claude Code            Hook (PS)              Node CLI                Chrome (perfil aislado)
        │                     │                     │                      │                         │
        │── "hacé X" ────────►│                     │                      │                         │
        │                     │── UserPromptSubmit ►│── spawn async ──────►│                         │
        │                     │                     │                      │── lanzar (cold) ───────►│ TikTok carga
        │                     │                     │                      │── play() (hot) ────────►│ <video>.play()
        │                     │                     │                      │                         │
        │◄ "listo, hice X" ───│                     │                      │                         │
        │                     │── Stop ────────────►│── spawn async ──────►│── pause() ─────────────►│ <video>.pause()
        │                     │                     │                      │                         │
```

Tres procesos disjuntos coordinados por un archivo de estado en `%TEMP%`. **Cero daemon.** Cada hook arranca un Node corto, conecta a CDP, hace su acción, sale.

## Requisitos

- Windows 10/11
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) instalado
- Google Chrome instalado (path estándar)
- Node.js LTS — el setup lo instala via winget si no está

Out of scope (v1): macOS, Linux, Firefox.

## Instalación

```powershell
# 1. Clonar el repo donde quieras
git clone https://github.com/BautiBalerio/ClaudeTok.git
cd ClaudeTok

# 2. Instalar dependencias (~5MB, sin browsers — usa tu Chrome del sistema)
npm install

# 3. Pegar los hooks en tu ~/.claude/settings.json (al mismo nivel que "permissions")
#    Ver bloque más abajo. El edit automático lo bloquea el classifier de Claude Code.

# 4. Recargar hooks: en Claude Code, ejecutar /hooks   (o reiniciar)
```

### Bloque para `~/.claude/settings.json`

Ajustá las rutas absolutas al lugar donde clonaste el repo:

```json
"hooks": {
  "UserPromptSubmit": [
    { "hooks": [{
      "type": "command",
      "command": "powershell",
      "args": ["-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File","C:\\ruta\\a\\ClaudeTok\\hooks\\on-prompt.ps1"],
      "async": true
    }]}
  ],
  "Stop": [
    { "hooks": [{
      "type": "command",
      "command": "powershell",
      "args": ["-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File","C:\\ruta\\a\\ClaudeTok\\hooks\\on-pause.ps1"],
      "async": true
    }]}
  ],
  "Notification": [
    { "hooks": [{
      "type": "command",
      "command": "powershell",
      "args": ["-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File","C:\\ruta\\a\\ClaudeTok\\hooks\\on-pause.ps1"],
      "async": true
    }]}
  ],
  "SessionEnd": [
    { "hooks": [{
      "type": "command",
      "command": "powershell",
      "args": ["-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File","C:\\ruta\\a\\ClaudeTok\\hooks\\on-end.ps1"],
      "async": true
    }]}
  ]
}
```

La primera vez que mandes un prompt vas a tener que loguearte en TikTok en la ventana dedicada (el perfil aislado vive en `%TEMP%\claude-tiktok-profile` y persiste cookies entre sesiones).

## Operación

```powershell
# Estado interno (qué cree el hook)
node src\cli.mjs status

# Forzar transiciones manuales
node src\cli.mjs play       # arranca sesión si no hay, o reanuda
node src\cli.mjs pause      # pausa idempotente
node src\cli.mjs cleanup    # borra state.json (Chrome queda abierto)

# Logging verbose
$env:CLAUDE_TIKTOK_DEBUG = "1"; node src\cli.mjs play
# Log: %TEMP%\claude-tiktok-hook.log
```

**Reset total** si algo se traba: cerrá la ventana de Chrome dedicada y borrá `%TEMP%\claude-tiktok-state.json` + `%TEMP%\claude-tiktok-profile\`. Próximo prompt arranca limpio.

## Estructura

```
ClaudeTok/
├── SPEC.md         # Requirements: 6 FRs + 6 NFRs con acceptance criteria
├── DESIGN.md       # Arquitectura, secuencias paso a paso, código clave
├── WALKTHROUGH.md  # Narrativa del proyecto (qué se hizo, cómo, por qué)
├── CLAUDE.md       # Guía para asistentes IA que abran el repo
├── README.md       # Este archivo
├── package.json
├── src/
│   ├── cli.mjs         # Dispatcher: play | pause | cleanup | status
│   ├── browser.mjs     # detectChrome, launch con --remote-debugging-port, DevToolsActivePort reuse
│   ├── tiktok.mjs      # chromium.connectOverCDP + page.evaluate(.play()/.pause())
│   ├── state.mjs       # Read/write/clear atómico de %TEMP%\claude-tiktok-state.json
│   └── log.mjs         # Logger condicional (errores siempre + DEBUG opcional)
└── hooks/
    ├── on-prompt.ps1   # UserPromptSubmit → cli.mjs play
    ├── on-pause.ps1    # Stop / Notification → cli.mjs pause
    └── on-end.ps1      # SessionEnd → cli.mjs cleanup
```

## Decisiones de diseño

Tres elecciones que pesan más que el resto. Detalle completo en [WALKTHROUGH.md §9](./WALKTHROUGH.md):

1. **CDP, no tecla media global.** La tecla `0xB3` de Windows es un toggle que se enruta al "último media player activo" — pausaría tu Spotify o YouTube si tienen foco de media. CDP nos da acceso quirúrgico al `<video>` específico de la pestaña TikTok.
2. **playwright-core, no playwright.** El paquete completo de Playwright trae browsers Chromium/Firefox/Webkit (~250MB). `playwright-core` solo trae el cliente CDP (~5MB) y usa el Chrome que ya tenés en el sistema.
3. **Sin daemon.** Un servicio Node de larga vida tendría hot path < 50ms pero suma complejidad (socket IPC, lifecycle, cleanup en crash). Aceptamos ~1.2s en hot path a cambio de simplicidad. Para el usuario es imperceptible.

## Performance

| Path | Target (SPEC) | Medido | Status |
|------|---------------|--------|--------|
| Cold start (primer prompt → TikTok reproduciendo) | < 3000ms | ~1500ms | ✓ |
| Hot pause/play (transición entre prompts) | < 500ms | ~1200ms | ✗ |
| Idempotencia (pause sobre paused, play sobre playing) | siempre | siempre | ✓ |

La regresión sobre AC-3.1 está documentada y aceptada para v1. La mayor parte del 1.2s es carga del paquete `playwright-core`. Optimización para v2: WebSocket CDP raw con `ws` package (~30KB) → hot path ~200ms.

## Troubleshooting

Mirá primero `%TEMP%\claude-tiktok-hook.log`.

| Síntoma | Causa probable | Fix |
|---------|----------------|-----|
| No abre TikTok al primer prompt | Chrome no detectado o Node no encontrado por el wrapper | Verificar paths absolutos en `hooks\on-*.ps1`; correr `node src\cli.mjs status` manual |
| Pestaña abre pero video no reproduce | Autoplay bloqueado | Click manual una vez; el flag `--autoplay-policy=no-user-gesture-required` debería evitarlo |
| Pausa el reproductor equivocado | NO debería pasar — bug | Reportar issue con log en modo DEBUG |
| Hot path lento (>2s) | Antivirus escaneando `node_modules` | Excluir el directorio del scan |
| `state.json` apunta a Chrome muerto | Cerraste Chrome a mano | `node src\cli.mjs cleanup`; próximo prompt relanza |

## Roadmap

- [ ] WebSocket CDP raw en hot path → cumplir AC-3.1 (<500ms)
- [ ] Daemon opcional para hot path <50ms
- [ ] Soporte Firefox vía RDP (Firefox Remote Debugging Protocol)
- [ ] Config runtime: URL alternativa, enable/disable temporal
- [ ] Empaquetar como `claude-plugin` instalable
- [ ] Soporte macOS / Linux

Ver [SPEC.md §6](./SPEC.md) para out-of-scope explícito de v1.

## Contribuir

Cualquier PR que arregle un troubleshoot real, mejore el hot path o sume soporte multi-plataforma es bienvenido. Antes de empezar:

1. Leé [SPEC.md](./SPEC.md) y [DESIGN.md](./DESIGN.md) — define el contrato actual
2. No cambies comportamiento sin actualizar el SPEC primero
3. Si agregás un FR nuevo, agregalo con su acceptance criteria
4. Smoke test manual mínimo después de cambios (ver [CLAUDE.md §Antes de tocar el código](./CLAUDE.md))

## Licencia

TBD.

## Reconocimientos

- Pensado y construido en par con [Claude Code](https://docs.anthropic.com/en/docs/claude-code) en formato SDD (Spec-Driven Development).
- Usa [Playwright](https://playwright.dev) (`playwright-core`) sobre [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).
