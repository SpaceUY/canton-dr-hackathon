# canton-dr

Verifiable decentralized disaster recovery for Canton nodes.
Proyecto para el hackathon de Canton Network (AppsFactory).

## El problema

Canton prioriza la privacidad estricta: cada participante mantiene el estado de sus datos
en su propio nodo local, y la red pública no guarda esos datos en forma legible.

Si una base local se corrompe y los backups se pierden, los datos no se recuperan.
Y aun teniendo backup, el operador no tiene forma de saber si ese backup sigue siendo
recuperable, ni de verificar que el estado restaurado es el correcto: se entera cuando
la red le empieza a rechazar transacciones.

## La solución

El nodo cifra su estado, replica el blob cifrado entre varios custodios (otros
participantes) y reparte la clave de cifrado en fragmentos k-de-n (Shamir Secret
Sharing). Ningún custodio ve plaintext, y hacen falta k fragmentos para reconstruir
la clave.

Canton NO se usa como storage, sino como capa de coordinación y auditoría: un contrato
Daml registra los custodios y la política, y los desafía periódicamente a probar que
siguen teniendo su fragmento, de modo que un backup degradado se detecta y se re-replica
antes del desastre.

Al recuperar, el ACS reconstruido se valida contra los ACS commitments que la red ya
intercambia entre contrapartes: prueba criptográfica de que el estado es correcto, sin
confiar en quien guardó el backup.

**Idea en una línea:** la red no guarda tus datos, guarda la prueba de que tus datos son
recuperables y correctos.

## Decisiones de diseño (ya tomadas, no re-litigar)

- **La red Canton no es storage.** El sequencer tiene fees de tráfico, pruning y límites
  de tamaño de mensaje. Los blobs cifrados viajan por fuera (HTTP directo entre agentes).
  El ledger lleva solo el registro, la política y las pruebas.
- **Lo que se fragmenta con Shamir es la clave de cifrado, no la base.** El blob cifrado
  se replica entero entre custodios. Mismo efecto de seguridad, mucho más eficiente.
- **Los ACS commitments verifican, no restauran.** Son hashes. Lo que devuelve los datos
  son los blobs de los custodios. Esto hay que decirlo explícitamente en el pitch.
- **Recuperación de identidad y recuperación de estado son dos capas separadas.** Este
  proyecto cubre estado (ACS). Las claves de identidad del nodo son otro problema y se
  declara como fuera de alcance.

## Limitaciones conocidas (declararlas, no esconderlas)

- Si quedan menos de k custodios disponibles, no hay recuperación. Sigue siendo un backup.
- Sin backup previo no se reconstruye nada desde cero.
- Tras el desastre se pierde el historial propio de commitments: la verificación requiere
  pedirle a la contraparte el commitment que ella guardó. No es una operación local.
- Los nombres exactos de los comandos de commitments cambian entre Canton 2.x y 3.x.
  Confirmar la versión del hackathon antes de comprometerse a esa parte del demo.

## Arquitectura

Tres piezas:

1. **Modelo Daml (on-ledger)** — `/daml`
   - `BackupPolicy`: dueño, custodios, k, n, frecuencia
   - `CustodianAgreement`: cada custodio acepta y deja constancia de qué recibió
   - `Challenge` / `ChallengeResponse`: desafío periódico y su prueba
   - `RecoveryRequest`: el dueño pide devolución, los custodios responden

2. **Agente por nodo (off-ledger)** — `/agent`
   Exporta el ACS, cifra, parte la clave en k-de-n, distribuye blob y fragmentos,
   responde desafíos, y en recovery junta todo y reimporta. El 80% del código.

3. **Transporte** — HTTP directo entre agentes para los blobs. Fuera de Canton.

```
/daml        modelo de contratos
/agent       el servicio por nodo
/infra       docker-compose, configs de los nodos
/docs        README, diagrama, pitch
```

## Plan de trabajo

Buscar una rebanada vertical funcionando antes de profundizar.

0. Repo, template de Daml/Canton, docker-compose con 3 participantes + sincronizador.
1. Crear algún contrato Daml trivial entre los 3 nodos, para tener estado real que perder.
2. **Export ACS → import ACS en un nodo vacío, a mano por consola.** Si esto no funciona,
   nada más importa. Primer día, sí o sí.
3. Automatizarlo desde el agente, sin cifrado ni shards: backup y restore end-to-end.
4. Cifrado + Shamir k-de-n + distribución entre custodios.
5. Modelo Daml de registro y desafíos periódicos.
6. Verificación contra los commitments de las contrapartes.
7. UI mínima: estado de los custodios, últimos desafíos, botón de recovery.

Plan B si el tiempo no alcanza: quedarse en el núcleo de monitoreo y *backup assurance*
(contrato de desafíos + chequeo de commitments), sin fragmentación. Mismo insight, una
fracción del trabajo, terminable.

## Demo (5 minutos)

3 nodos. Uno pierde la base. Recupera con 2 de 3 fragmentos. Valida contra el commitment.
Se muestra que el custodio solo vio ciphertext en todo momento.

## Referencias

- Repairing Participant Nodes: https://docs.digitalasset.com/operate/3.4/explanations/repairing.html
- Repair Nodes (Daml SDK 2.x): https://docs.daml.com/canton/usermanual/repairing.html
- Disaster Recovery (Splice): https://docs.sync.global/validator_operator/validator_disaster_recovery.html
- Console Commands: https://docs.daml.com/canton/reference/console.html
- Canton Network docs: https://docs.canton.network/
