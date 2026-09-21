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

## 2. Export ACS → import ACS a mano por consola — **crítico, día 1**

- [ ] Con el contrato del paso 1 activo, exportar el ACS de un participante
      por consola (ver ejemplo oficial `07-repair` en el repo de Canton)
- [ ] Importarlo en un participante vacío por consola, a mano
- [ ] Confirmar que el estado restaurado permite operar con normalidad
- [ ] Si esto no funciona: replantear el approach antes de seguir con nada más

## 3. Automatizar backup/restore end-to-end desde el agente

- [ ] Esqueleto del servicio en `/agent` (sin cifrado, sin shards)
- [ ] Backup: exportar ACS de un participante y guardarlo
- [ ] Restore: reimportar ese ACS en un participante vacío
- [ ] Correrlo end-to-end sin intervención manual

## 4. Cifrado + Shamir k-de-n + distribución entre custodios

- [ ] Cifrar el blob de estado antes de guardarlo/enviarlo
- [ ] Partir la clave de cifrado en fragmentos k-de-n (Shamir)
- [ ] Distribuir blob cifrado + fragmentos entre los custodios (HTTP directo,
      fuera de Canton)
- [ ] Reconstruir la clave con k de n fragmentos y descifrar en recovery

## 5. Modelo Daml de registro y desafíos periódicos

- [ ] `BackupPolicy`: dueño, custodios, k, n, frecuencia
- [ ] `CustodianAgreement`: cada custodio acepta y deja constancia de qué
      recibió
- [ ] `Challenge` / `ChallengeResponse`: desafío periódico y su prueba
- [ ] Job/trigger que dispare desafíos según la frecuencia de la política

## 6. Verificación contra los commitments de las contrapartes

- [ ] Confirmar los nombres de comando de commitments para la versión de
      Canton del hackathon (3.5.x — ya confirmado acá, revalidar si cambia)
- [ ] `RecoveryRequest`: el dueño pide devolución, los custodios responden
- [ ] Validar el ACS reconstruido contra los commitments que la contraparte
      ya tiene guardados (no es una operación local — hay que pedírselo)

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
