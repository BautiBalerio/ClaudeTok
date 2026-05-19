# SPEC — TikTok-while-thinking hook para Claude Code

**Estado:** v0.2 — Open Questions resueltas, listo para DESIGN
**Autor:** bbalerioecheverria@itpatagonia.com
**Fecha:** 2026-05-19

---

## 1. Overview

Hook para Claude Code que reproduce un feed de TikTok en una ventana del navegador mientras Claude está procesando un turno, y lo pausa automáticamente cuando Claude termina o necesita input del usuario. El objetivo es que el tiempo de espera de Claude sea entretenido sin requerir intervención manual del usuario.

## 2. Stakeholders

- **Usuario principal:** dev usando Claude Code en Windows que quiere "matar tiempo" mientras Claude piensa.
- **Sistema:** Claude Code CLI (Windows), navegador default del sistema, eventos del lifecycle de Claude Code (hooks).

## 3. User Stories

- **US-1:** Como usuario, cuando mando mi primer prompt en una sesión de Claude Code, quiero que se abra automáticamente una pestaña con TikTok en mi navegador default y empiece a reproducirse.
- **US-2:** Como usuario, mientras Claude está procesando (pensando o usando herramientas), quiero que TikTok siga reproduciéndose de fondo sin interrupciones.
- **US-3:** Como usuario, cuando Claude termine su turno (me responda) o me haga una pregunta, quiero que TikTok se pause automáticamente para poder leer la respuesta y responder sin distracciones.
- **US-4:** Como usuario, cuando vuelvo a mandar un prompt, quiero que TikTok reanude la reproducción.
- **US-5:** Como usuario, cuando termine mi sesión de Claude Code, quiero que la ventana de TikTok quede abierta (para seguir mirando si quiero).

## 4. Functional Requirements

### FR-1 — Apertura automática en la primer interacción
**Trigger:** primer `UserPromptSubmit` de la sesión.
**Comportamiento:** abre `https://www.tiktok.com/foryou` en Google Chrome (forzado, independiente del navegador default del SO porque CDP requiere Chromium), lanzado con `--remote-debugging-port=<dinámico>` y `--user-data-dir=<perfil dedicado>` para no interferir con la sesión normal de Chrome del usuario. Una sola ventana por sesión de Claude Code.
**Acceptance criteria:**
- AC-1.1: La pestaña se abre en menos de 3 segundos desde el `UserPromptSubmit`.
- AC-1.2: Si Chrome no estaba corriendo, se lanza automáticamente.
- AC-1.3: En sesiones siguientes (Claude Code re-abierto), se vuelve a abrir nueva ventana (no persistir entre sesiones).
- AC-1.4: La instancia lanzada usa un `--user-data-dir` dedicado (ej: `%TEMP%\claude-tiktok-profile`) para no tocar el perfil principal del usuario.
- AC-1.5: Si el sistema no tiene Chrome instalado, el hook loguea warning y aborta silenciosamente sin afectar Claude Code.

### FR-2 — Reproducción continua durante "thinking"
**Trigger:** después de FR-1, durante todo el turno de Claude (incluyendo uso de herramientas como Read, Edit, Bash).
**Comportamiento:** el video de TikTok reproduce sin pausarse cuando Claude llama a herramientas internas. Solo se pausa en eventos terminales del turno (FR-3).
**Acceptance criteria:**
- AC-2.1: Si Claude ejecuta 10 herramientas en un turno, el video no se pausa entre llamadas.
- AC-2.2: El video continúa reproduciéndose en background aunque la ventana del navegador no tenga el foco.

### FR-3 — Pausa automática en fin de turno o pregunta
**Trigger:** eventos `Stop` (Claude terminó el turno) o `Notification` (Claude pide input/permiso).
**Comportamiento:** se pausa el `<video>` de la pestaña de TikTok mediante Chrome DevTools Protocol (CDP), inyectando JavaScript en el contexto de la página.
**Acceptance criteria:**
- AC-3.1: La pausa ocurre en menos de 500ms desde el evento `Stop` o `Notification`.
- AC-3.2: La pausa NO afecta otros media players activos (Spotify, YouTube en otra pestaña, etc.).
- AC-3.3: Si TikTok ya estaba pausado (raro), la operación es idempotente — no genera error ni efectos colaterales.

### FR-4 — Reanudación en próximo prompt
**Trigger:** `UserPromptSubmit` posterior al primero.
**Comportamiento:** reanuda la reproducción del `<video>` de TikTok.
**Acceptance criteria:**
- AC-4.1: El video continúa desde donde fue pausado (no reinicia).
- AC-4.2: Si el usuario cerró la pestaña de TikTok manualmente, el hook no intenta reabrirla (acepta que el usuario decidió cerrarla).

### FR-5 — No bloqueo de Claude Code
**Trigger:** todos los hooks.
**Comportamiento:** ningún hook debe bloquear el flujo de Claude Code esperando a que termine la operación de browser. Ejecución async.
**Acceptance criteria:**
- AC-5.1: Si la operación de CDP falla o se cuelga, Claude Code continúa funcionando normalmente.
- AC-5.2: Errores en los hooks se loguean pero no se muestran al usuario en el transcript.

### FR-6 — Limpieza al cerrar sesión
**Trigger:** `SessionEnd` (fin de sesión de Claude Code).
**Comportamiento:** la pestaña de TikTok queda abierta (no se cierra). Se limpia cualquier proceso auxiliar (ej: Chrome con `--remote-debugging-port`) si fue lanzado exclusivamente para este hook.
**Acceptance criteria:**
- AC-6.1: La pestaña de TikTok sigue visible y funcional tras cerrar Claude Code.
- AC-6.2: No quedan procesos zombie de Chrome ni archivos de estado huérfanos.

## 5. Non-Functional Requirements

- **NFR-1 (Performance):** Overhead total por hook < 1s en cold path, < 200ms en hot path.
- **NFR-2 (Robustez):** Si el navegador no está disponible, los hooks fallan silenciosamente sin afectar Claude Code.
- **NFR-3 (Privacidad):** El hook no debe acceder a ninguna otra pestaña, cookie, ni dato fuera del scope `tiktok.com`.
- **NFR-4 (Portabilidad):** Funciona en Windows 10/11. Otros SO out of scope.
- **NFR-5 (Dependencias):** Node.js LTS + Playwright. Total instalado < 100MB (Playwright sin browsers bundleados — usa el Chrome del sistema vía CDP).
- **NFR-6 (Observabilidad):** Log de eventos en `%TEMP%\claude-tiktok-hook.log` para debugging.

## 6. Out of Scope (v1)

- Soporte multi-plataforma (macOS, Linux).
- Selección de feed específico (categorías, hashtags, perfiles).
- Control de volumen automático.
- Cierre automático de la pestaña al fin de sesión.
- Reanudar TikTok desde donde se quedó en sesiones previas.
- Configurabilidad runtime (todo es hardcoded en v1).
- UI/CLI para enable/disable temporal.

## 7. Open Questions

| # | Pregunta | Default propuesto |
|---|----------|-------------------|
| OQ-1 | ¿Volumen inicial al abrir TikTok? | Sin tocar el volumen (queda con el último del usuario) |
| OQ-2 | ¿Mutear audio al pausar para evitar pop al reanudar? | No, solo `.pause()` |
| OQ-3 | ¿Qué URL exacta usar? `/foryou` (feed FYP) vs `/` (landing) | `/foryou` — más directo al contenido |
| OQ-4 | ¿Logs verbosos siempre o solo si DEBUG=1? | Solo si `$env:CLAUDE_TIKTOK_DEBUG=1` |
| OQ-5 | ¿Qué pasa si el navegador default no es Chromium-based (Firefox)? | Fallback a tecla media global; log warning |

## 8. Glossary

- **CDP:** Chrome DevTools Protocol — permite control programático de Chromium via WebSocket.
- **Hot path:** hook que se dispara con TikTok ya inicializado (ej: pause/play de un video ya cargado).
- **Cold path:** primer hook de la sesión, incluye lanzamiento de navegador + apertura de pestaña.
- **Turno:** unidad de conversación entre `UserPromptSubmit` y el siguiente `Stop` o `Notification`.

---

**Próximo paso si se aprueba:** `DESIGN.md` con arquitectura, secuencia de eventos, código clave.
