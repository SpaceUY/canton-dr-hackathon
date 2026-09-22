# Roadmap — canton-dr

Checklist de la rebanada vertical hasta el demo, basado en "Plan de trabajo"
de `../CLAUDE.md`. Tildar a medida que se completa cada ítem. Si algo cambia
de alcance, ajustar acá y dejar la razón como comentario en el commit.

## 0. Repo + template Daml/Canton + docker-compose

- [x] Estructura de carpetas (`daml/`, `agent/`, `infra/`, `docs/`)
- [x] `infra/Dockerfile` + `infra/docker-compose.yml`: synchronizer + 3
      participantes, cada uno en su propio contenedor, verificado
      end-to-end (bootstrap conecta los 3 y hace ping)
- [x] `daml/daml.yaml` (template trivial, para probar el pipeline de
      build/upload — el contrato de negocio real vino en el paso 1)
- [x] Instalar `dpm` y confirmar que `dpm build` compila `daml/` — confirmado
      (`DAML_VERSION=3.5.2 dpm build` produce el DAR); falta dejar `dpm` en
      el `PATH` de la máquina de forma permanente (ver `../infra/README.md`)

## 1. Contrato Daml trivial entre los 3 nodos

- [x] Reemplazar `Ping.daml` por `Record.daml` (owner + custodians), visible
      a la vez en el ACS de `participant1`/`participant2`/`participant3`
- [x] Subir el DAR a los 3 participantes vía `bootstrap.canton`
- [x] Crear un contrato activo entre nodos (servicio `seed`, ver
      `../infra/canton/seed.sh`) — el propio script verifica el ACS de los
      3 participantes por HTTP JSON API antes de reportar éxito; probado
      end-to-end desde cero y corrido 2 veces más para confirmar que
      reutiliza parties y contrato existentes en vez de duplicar

## 2. Export ACS → import ACS a mano por consola — **crítico, día 1** ✅ funciona

- [x] Con el contrato del paso 1 activo, exportar el ACS de un participante
      por consola — `participant.repair.export_acs(...)`, probado contra el
      binario real (no es el mismo mecanismo que el ejemplo `07-repair`, que
      es sobre migración de synchronizer, pero misma familia de comandos)
- [x] Importarlo en un participante vacío por consola, a mano —
      `participant.repair.import_acs(...)`, ver `infra/canton/recover-test.canton`
      y "Step 2 findings" en `infra/README.md` para los dos requisitos no
      obvios que encontré (storage persistente, no memoria; desconectar del
      synchronizer antes de importar)
- [x] Confirmar que el estado restaurado permite operar con normalidad —
      el contrato importado es legible y correcto vía la Ledger API del
      participante que lo recibió (verificado por HTTP). Someter una
      transacción *como* la party recuperada no funcionó de entrada porque
      probé contra una identidad de participante distinta a propósito — eso
      es exactamente la recuperación de identidad/hosting que el CLAUDE.md ya
      declaraba fuera de alcance, no una falla del mecanismo de estado
- [x] Si esto no funciona: replantear — no hizo falta, funcionó

**Hallazgo que cambia el paso 3:** el nodo que recupera necesita storage en
base de datos (H2 o Postgres), no memoria — `import_acs` lo rechaza
explícitamente. El docker-compose actual (paso 0) usa memoria en los 3
participantes; hay que revisar esto al automatizar backup/restore desde el
agente.

## 3. Automatizar backup/restore end-to-end desde el agente ✅ funciona

- [x] Esqueleto del servicio en `/agent` (sin cifrado, sin shards) — CLI en
      TypeScript/Node (`agent/src/cli.ts`), invoca `bin/canton run` con un
      script `.canton` generado en el momento (los comandos `repair.*` no
      existen en la Ledger JSON API, solo en la consola Scala)
- [x] Backup: `agent backup --source participant1 --party owner --out <path>`
      — exporta el ACS de esa party
- [x] Restore: `agent restore --target participant4 --in <path>` — la
      encapsula el disconnect/import_acs/reconnect que el paso 2 encontró
      necesario, el que llama al comando no tiene que acordarse
- [x] Corrido end-to-end sin intervención manual vía docker-compose (nuevos
      servicios `participant4` con storage H2 y `agent`, sin volumen
      compartido con ningún participante — confirma que el archivo exportado
      viaja por la admin API, no por disco compartido) y verificado que el
      contrato recuperado es legible en `participant4`

**Agregado al docker-compose del paso 0 (no lo tenía):** `participant4.conf`
(storage H2, el único participante con volumen persistente propio),
`features.conf` (los flags `enable-repair-commands`/`enable-testing-commands`
que hacen falta para los comandos de repair) y el servicio `agent` en
`infra/docker-compose.yml`.

**Bugs propios que aparecieron al armar el CLI** (corregidos, ver commit):
el entrypoint pasaba un `--` literal al parser de argumentos en vez de
actuar como separador, y las funciones `backup`/`restore` no devolvían nada
imprimible — el `println` del script de Canton quedaba atrapado adentro y
la corrida "exitosa" no mostraba ninguna confirmación.

## 4. Cifrado + Shamir k-de-n + distribución entre custodios ✅ funciona

Esquema: **k=2, n=3 incluyendo al owner** como uno de los 3 shareholders
(no hacía falta un 4to nodo custodio) — así, cuando el owner es el que
pierde la base, se recupera igual con los 2 fragments que quedaron en los
custodios externos.

- [x] Cifrar el blob de estado antes de guardarlo/enviarlo — AES-256-GCM
      (`agent/src/crypto.ts`, `node:crypto`)
- [x] Partir la clave de cifrado en fragmentos k-de-n (Shamir) —
      `shamir-secret-sharing` (librería TS auditada de Privy, cero deps)
- [x] Distribuir blob cifrado + fragmentos entre los custodios (HTTP directo,
      fuera de Canton) — `agent distribute`, empuja a los 3 endpoints
      (incluyendo el propio owner) vía PUT
- [x] Reconstruir la clave con k de n fragmentos y descifrar en recovery —
      `agent recover`, probado explícitamente con solo 2 de los 3 endpoints
      (salteando el del owner) para no validar solo el happy path

Cada nodo ahora tiene un agente propio (`agent1`/`agent2`/`agent3` en
`docker-compose.yml`) corriendo `agent serve` — un servidor HTTP que
recibe y guarda blob+fragment, y los devuelve para la recuperación. El CLI
para disparar comandos (`backup`/`restore`/`distribute`/`recover`) sigue
siendo el servicio `agent` separado — ver el bug de DNS más abajo.

**Verificado que el custodio nunca ve el plaintext:** inspeccioné el
archivo guardado en el volumen de `agent2` directamente — son bytes de alta
entropía, sin estructura reconocible.

**Bugs encontrados armando esto** (todos corregidos, ver commit):
- `shamir-secret-sharing` valida `secret.constructor !== Uint8Array` a
  rajatabla — un `Buffer` de Node (lo que devuelven `crypto.randomBytes` y
  `fs.readFile`) es subclase de `Uint8Array` pero falla ese chequeo. Hubo
  que convertir explícitamente con `new Uint8Array(...)`.
- El `fetch()` global de Node tampoco acepta un `Buffer` como `body` (error
  de tipos en compilación) — mismo fix.
- **El bug más caro:** al principio hice que `agent1`/`agent2`/`agent3`
  también corrieran los comandos CLI (`docker compose run agent1
  distribute ...`), pero eso crea un *segundo* contenedor que comparte el
  alias de red "agent1" con el servidor `serve` ya corriendo — el DNS
  embebido de Docker resolvió el auto-push del owner hacia el contenedor
  sin servidor, dando `ECONNREFUSED`. Separé el rol: `agent1/2/3` solo
  sirven HTTP, el servicio `agent` (sin hostname) corre los comandos.
- La máquina de desarrollo está al límite de memoria con las 5 JVMs de
  Canton + los 3 agentes arriba a la vez (~6GB contra un límite de 7.65GB
  en Docker Desktop) — se mataron `participant3` y `participant4` por OOM
  durante las pruebas. No es un bug de código, pero hay que subir el límite
  de memoria de Docker Desktop antes del día de la demo.

## 5. Modelo Daml de registro y desafíos periódicos ✅ funciona

- [x] `BackupPolicy`: dueño, custodios, k, n, frecuencia — `daml/BackupPolicy.daml`.
      `custodians` lista solo a los 2 externos (n=3 incluye al owner por la
      decisión del paso 4, pero nadie se desafía a sí mismo)
- [x] `CustodianAgreement`: cada custodio acepta y deja constancia de qué
      recibió — un hash SHA-256 del blob cifrado, nunca el blob ni el share
- [x] `Challenge` / `ChallengeResponse`: desafío periódico y su prueba —
      la prueba es `HMAC-SHA256(share, challengeId)`, calculada por
      `agent respond` con el share local, que nunca sale del custodio
- [x] Job/trigger que dispare desafíos según la frecuencia de la política —
      `agent challenge-loop` (loop simple en el agente, no un Daml Trigger
      completo — de más para lo que un demo necesita)

Comandos nuevos: `agent create-policy`, `agent accept-custody`,
`agent challenge`, `agent respond`, `agent challenge-loop` — ver
"Run it" y "Step 5 findings" en `infra/README.md`.

Probado end-to-end contra Docker real: `create-policy` → `distribute` →
`accept-custody` (los 2 custodios, mismo blobHash porque reciben el mismo
ciphertext) → `challenge` → `respond`, y confirmado por API que el
`Challenge` quedó archivado (no huérfano) y solo sobrevive el
`ChallengeResponse`. `challenge-loop` corrido aparte y confirmado que
dispara rondas repetidas a ambos custodios sin caerse.

## 6. Verificación contra los commitments de las contrapartes ✅ (alcance ajustado, ver abajo)

- [x] Confirmar los nombres de comando de commitments para la versión de
      Canton del hackathon — confirmado por bytecode y probado contra el
      binario real: `commitments.lookup_sent_acs_commitments`,
      `lookup_received_acs_commitments`, `open_commitment`,
      `get_intervals_behind_for_counter_participants`
- [x] `RecoveryRequest`: el dueño pide devolución, los custodios responden —
      mismo patrón que `Challenge`/`ChallengeResponse` en
      `daml/BackupPolicy.daml`, comandos `agent request-recovery` /
      `agent respond-recovery`
- [x] Validar el ACS reconstruido contra los commitments — **alcance
      ajustado a propósito**: la comparación "de verdad" (recalcular un
      hash y compararlo contra el que la contraparte ya tenía) solo
      significa algo cuando es la MISMA identidad de participante la que se
      recupera — y `participant4` es un doble con identidad nueva a
      propósito (ver hallazgos del paso 2). Lo que sí se prueba: el comando
      real (`agent check-commitment`) conecta y trae datos reales y
      estructurados de una contraparte activa — no es una operación local,
      tal como ya declaraba el CLAUDE.md original

**Hallazgo, no bug:** `lookup_sent_acs_commitments` devolvió `Map()` vacío
en todas las corridas de prueba, incluso sin filtros y bastante después del
intervalo de reconciliación por defecto (1 minuto). `get_intervals_behind_for_counter_participants`
sí trae datos reales para el mismo par de nodos (confirma que Canton sigue
la relación, 0 intervalos de atraso). Lectura: un período de commitment
cerrado y consultable necesita más tiempo real transcurrido que una ventana
de prueba corta — no es que el comando esté roto. Ver "Step 6 findings" en
`infra/README.md` para el detalle completo (incluye dos bugs propios: los
nombres de parámetros que saqué del bytecode eran incorrectos —
`javap` no preserva nombres de parámetros con nombre de Scala, hubo que
llamar posicionalmente — y `SynchronizerTimeRange` necesitaba un import
explícito).

**Hallazgo de la prueba de regresión completa, no de este paso puntual:**
`create-policy`, `accept-custody`, `challenge` y `request-recovery` no eran
idempotentes — un timeout del lado del cliente (un 503 real bajo presión
de memoria, no hipotético) no significa que el servidor no haya procesado
igual el comando. Reintentar `accept-custody` después de uno dejó un
`CustodianAgreement` duplicado. Los cuatro comandos ahora chequean si ya
existe el contrato antes de crear.

## 7. UI mínima

- [ ] Estado de los custodios (activo / degradado)
- [ ] Últimos desafíos y sus resultados
- [ ] Botón de recovery

## Demo (5 minutos)

- [ ] Guion: 3 nodos, uno pierde la base, recupera con 2 de 3 fragmentos,
      valida contra el commitment, se muestra que el custodio solo vio
      ciphertext en todo momento
- [ ] Ensayo cronometrado

## Plan B (si el tiempo no alcanza)

- [ ] Cortar en *backup assurance*: solo pasos 0–3 + 5–6 (desafíos +
      verificación contra commitments), sin fragmentación Shamir (sin paso 4)
