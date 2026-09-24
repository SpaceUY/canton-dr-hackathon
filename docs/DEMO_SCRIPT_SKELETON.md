# Demo script — skeleton / respaldo

Sin pulir, sin cronometrar de verdad. Bloques y tiempos aproximados nomás. Este es el
guion que usamos SI el trabajo de identidad (timebox: una semana desde 2026-09-23) no
cierra a tiempo. El guion final, con el cierre de "la party recuperada transa con una
contraparte", se escribe después de integrar identidad — no antes.

Basado en lo que YA está probado hoy: recuperación de datos + Shamir + prueba
criptográfica de commitments. Nada de esto depende del spike de identidad.

## 0:00–0:30 — Encuadre

- Una frase: "la red no guarda tus datos, guarda la prueba de que son recuperables y
  correctos."
- Mostrar el dashboard ya levantado: policy `demo`, k=2 n=3, ambos custodios con
  custodia aceptada.

## 0:30–1:00 — Por qué importa (gancho real, no hipotético)

- Citar el caso real del foro de Canton (dr.rabi, `aurpay-validator-1`, MainNet): un
  validator real que volvió con identidad nueva tras 7 semanas offline. No es un
  problema inventado.

## 1:00–1:30 — El desastre, en vivo

- Terminal, no botón: `docker stop infra-participant1-1 && docker rm infra-participant1-1 && docker volume rm infra_participant1_data`.
  No es solo matar el proceso — borra el disco, que es lo que un desastre real hace.
- Decir en voz alta qué se acaba de perder (el nodo dueño de los datos).

## 1:30–2:00 — La privacidad se mantiene

- `docker run --rm -v infra_agent2_custody:/data alpine sh -c "xxd /data/demo/blob.enc | head -5"`
- Punto: el custodio tiene esto guardado hace rato y nunca vio otra cosa que bytes sin
  estructura.

## 2:00–2:45 — Recuperación, en la UI

- Click en "Recover" en el dashboard (o el comando CLI equivalente si el navegador
  falla — tener el comando a mano como fallback).
- Mostrar el banner verde: reconstruyó la clave con 2 de 3 fragmentos, restauró el
  estado en `participant4`.

## 2:45–3:15 — Verificar que el dato volvió de verdad

- Dashboard o curl contra `participant4` mostrando el contrato recuperado, legible.

## 3:15–4:00 — La prueba criptográfica (el momento fuerte de HOY)

- `docker compose run --rm agent check-commitment --counterparty-participant participant2 --about-participant participant1`
- Señalar: dos nodos que nunca se coordinaron llegan al mismo hash SHA-256. Esa es la
  prueba, no confiar en el custodio ni en el backup.

## 4:00–4:45 — Cierre honesto

- Decir la limitación en voz alta, no esconderla: "esto recupera los datos; el nodo
  vuelve con una identidad nueva, no la misma — eso ya lo tenemos resuelto como
  mecanismo (spike probado matando un nodo de verdad), en integración." Roadmap, no
  bug.
- Una frase de cierre con el pitch original.

## 4:45–5:00 — Buffer / preguntas

- Nada planeado, colchón para que algo se trabe y no se coma el tiempo.

## Fallbacks a tener listos

- Si el navegador falla: comando CLI de `recover` a mano (ver `docs/README.md`).
- Si `participant1` no vuelve a levantar limpio: reset completo documentado en
  `docs/README.md` § "Resetting between runs" — practicarlo una vez antes, no
  descubrirlo en vivo.
- Si el jurado pregunta por la identidad: la respuesta corta es "mecanismo confirmado
  contra el binario real, en integración" — no "ya funciona".
