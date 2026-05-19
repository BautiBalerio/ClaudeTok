# CLAUDE.md — guía rápida para Claude Code en este repo

Hook de Claude Code que reproduce/pausa TikTok automáticamente según el lifecycle del turno. Windows-only.

## Stack y restricciones

- **Node 24.15.0** (LTS via winget). El binario **NO está en `$PATH` por defecto** en sesiones nuevas hasta que Windows propague User PATH. Usa siempre el path absoluto en hooks: `$env:LOCALAPPDATA\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.15.0-win-x64\node.exe`.
- **playwright-core** (sin browsers bundleados, ~5MB). El Chrome es del sistema, NO el de Playwright.
- **ESM puro** (`"type": "module"`), `.mjs` everywhere, `import` syntax.
- **Sin TypeScript, sin bundler, sin tests automatizados** — over-engineering para v1.

## Comandos

```powershell
# Status del hook (lectura del state.json en %TEMP%)
node src\cli.mjs status

# Forzar transiciones
node src\cli.mjs play       # arranca sesión si no hay, o reanuda
node src\cli.mjs pause      # pausa idempotente
node src\cli.mjs cleanup    # borra state.json (Chrome queda abierto)

# Verbose para debug
$env:CLAUDE_TIKTOK_DEBUG = "1"; node src\cli.mjs <cmd>
# Log: %TEMP%\claude-tiktok-hook.log
```

## Estructura

```
src/
  cli.mjs       dispatcher (play|pause|cleanup|status), siempre exit 0 en error
  browser.mjs   detectChrome(), launch() con --remote-debugging-port + DevToolsActivePort reuse
  tiktok.mjs    chromium.connectOverCDP() + page.evaluate(.play()/.pause()) sobre <video>
  state.mjs     read/write/update/clear con escritura atómica (writeFileSync .tmp + rename)
  log.mjs       errors siempre; debug solo si CLAUDE_TIKTOK_DEBUG=1
hooks/
  on-prompt.ps1  UserPromptSubmit → cli.mjs play
  on-pause.ps1   Stop / Notification → cli.mjs pause
  on-end.ps1     SessionEnd → cli.mjs cleanup
```

## Convenciones

- **Errores nunca rompen Claude Code**: `cli.mjs` siempre termina con `exit 0`. Errores van a `log.error()`, no a stderr.
- **State file en `%TEMP%`**: `claude-tiktok-state.json` (estado) y `claude-tiktok-profile/` (perfil Chrome dedicado).
- **Sin daemon**: cada hook arranca un Node fresco, conecta a CDP, hace su cosa, sale. Trade-off: hot path tarda ~1.2s (no los <500ms del SPEC). Aceptado para v1.
- **Async total**: hooks usan `Start-Process` sin `-Wait` para no bloquear el turno.

## Gotchas

- **Edit a `~/.claude/settings.json` bloqueado por classifier** (self-modification). El usuario debe pegar el bloque `hooks` a mano y correr `/hooks` o reiniciar. Snippet en [README.md §Instalación](./README.md).
- **Si el perfil dedicado tiene Chrome corriendo**, un segundo `--remote-debugging-port=N` no toma efecto. `browser.reuseIfActive()` lee `DevToolsActivePort` del profile para reutilizar la instancia viva.
- **TikTok wall de login**: el perfil dedicado persiste en `%TEMP%\claude-tiktok-profile` entre sesiones (sólo se borra si el usuario lo limpia). Loguearse una vez basta.
- **`--autoplay-policy=no-user-gesture-required`**: confía en que Chrome respeta ese flag. Si en algún momento Google lo deprecia, el primer video pedirá click.
- **Multi-sesión Claude Code**: out of scope. La segunda sesión lee mismo `state.json` y comparte Chrome. Aceptable.

## Antes de tocar el código

1. **Leé `SPEC.md` y `DESIGN.md`** — están en este directorio. SPEC define los FRs/NFRs aprobados; DESIGN explica el cómo. No cambies comportamiento sin actualizar SPEC primero.
2. **Test manual mínimo después de cambios**:
   - `node src\cli.mjs cleanup` (limpia state)
   - Cerrar la ventana de Chrome dedicada si hay
   - `node src\cli.mjs play` → debe abrir Chrome+TikTok en <3s, state queda `playing`
   - `node src\cli.mjs pause` → state queda `paused`
   - `node src\cli.mjs play` (hot) → state queda `playing`, video reanuda desde donde quedó
3. **No agregues TypeScript ni tests automatizados** sin pedir al usuario. v1 es deliberadamente mínimo.
