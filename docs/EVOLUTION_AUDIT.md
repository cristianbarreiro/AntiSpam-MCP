# Auditoría diferencial de evolución

## Alcance y baseline

La auditoría se realizó sobre la rama de trabajo local, no sobre una suposición de
`main`. Antes de P0 había ocho herramientas MCP, proveedor mock y Gmail, caché de
cinco minutos, escaneo de 1 a 10.000 mensajes, preview por remitente de hasta 1.000,
SQLite v1, aprobación local de un solo uso y movimiento individual a Papelera.

El árbol ya contenía tres cambios locales que se conservaron: corrección de la ruta
JSON usada por el pruning de SQLite, su prueba de regresión y diagnóstico por etapa
durante el arranque. El baseline fue: 19 pruebas, typecheck, lint y build correctos.
No se usó ni validó una cuenta Gmail real.

## Hallazgos iniciales

- La clasificación protegía el grupo completo al encontrar un solo `IMPORTANT`; no
  mostraba el resto de categorías del mismo remitente.
- El dashboard solicitaba 1.000 mensajes y sí indicaba cobertura parcial, pero no
  ofrecía métricas 7/30/90 ni frecuencia observable.
- El preview existente incluía todo un remitente. No había selección por IDs,
  fecha, lectura o categoría, ni un plan único para varios remitentes.
- La seguridad de aprobación, cuenta, caducidad, replay, IDs congelados, auditoría y
  resultados inciertos ya estaba implementada y debía conservarse.
- Gmail leía metadatos secuencialmente y no reintentaba mutaciones. Faltaba backoff
  acotado para lecturas idempotentes y no se exponía su estimación como aproximada.
- La UI estaba en inglés y enfocada en el remitente completo.

## P0 implementado

1. `classifyMessage` explica categorías y protecciones por mensaje. Los grupos
   conservan el resultado compatible y añaden `presentationClassification` y un
   desglose; un grupo con factura, mensaje importante y promociones aparece `MIXED`.
2. `mailbox_noise_report` calcula métricas observadas de 7/30/90 días con reloj
   inyectado, frecuencia normalizada, muestreo y texto explícito de cobertura.
3. `cleanup_plan_preview` acepta hasta 20 remitentes y 1.000 IDs con selección
   explícita o criterios de fecha, lectura y categoría. Congela IDs, remitente,
   categoría y protecciones en un único preview durable.
4. Los planes nuevos excluyen por defecto mensajes importantes, transaccionales,
   destacados y remitentes en `IGNORE`. Incluir una protección exige una segunda
   confirmación local antes de que pueda emitirse el token normal.
5. `cleanup_plan_execute` reutiliza el claim atómico y reporta resultados globales y
   por remitente. Un mensaje ya en Papelera se distingue como `ALREADY_TRASHED`; una
   nueva protección después del preview falla sin ampliar el alcance.
6. Gmail conserva mutaciones individuales. Añade backoff exponencial acotado solo a
   lecturas idempotentes. No usa `batchModify`, cuya respuesta exitosa es vacía y no
   permite atribuir resultados por mensaje con las garantías actuales.
7. El dashboard está en español, mantiene una tabla accesible y añade cobertura,
   ventana temporal, desglose mixto, casillas de remitente/mensaje, contador agregado,
   preview multirremitente, advertencias y confirmación protegida.

## Decisiones y compatibilidad

- Se preservan los ocho nombres originales. Los nuevos contratos son aditivos.
- `sender_cleanup_preview` mantiene su alcance histórico por remitente; si incluye
  mensajes protegidos, ahora requiere la confirmación humana adicional.
- No fue necesaria una migración SQLite: el esquema v1 ya guarda el preview como JSON
  y los campos nuevos son compatibles con registros previos. No se alteraron políticas
  ni auditorías existentes.
- La selección granular nunca acepta una consulta Gmail libre. Los criterios se
  validan con Zod y el servicio vuelve a validar cuenta, remitente y protecciones.
- No se incorporó un LLM, almacenamiento de cuerpos, borrado permanente, reglas
  futuras ni un permiso OAuth adicional.

## Evidencia

- Suite automatizada: 26 pruebas de dominio, integración, seguridad, HTTP, proveedor
  y contrato MCP.
- Verificación visual sintética: escaneo de 90 mensajes, grupo mixto, selección de dos
  remitentes, preview único de 42 IDs y cancelación; consola sin errores ni avisos.
- Validaciones requeridas: typecheck, lint y build de producción correctos.
- Fuentes verificadas: Gmail `messages.list` devuelve IDs y una estimación, con páginas
  de hasta 500; `batchModify` acepta hasta 1.000 IDs y responde sin detalle individual;
  las cuotas se calculan por método, usuario y proyecto.

## Riesgos y trabajo pendiente

- La integración Gmail, refresh de token, revocación, cuotas y resultados inciertos
  requieren el smoke test manual con una cuenta de prueba autorizada.
- El escaneo sigue siendo una ventana en memoria, no una réplica ni una sincronización
  incremental con `history.list`.
- Los asuntos continúan visibles en el dashboard bajo demanda y se tratan como datos
  no confiables; no se persisten ni se registran.
- P1 queda pendiente: política `ALLOW/REVIEW/DETECT/IGNORE`, exportación/borrado local,
  reglas futuras con consentimiento incremental y tendencias agregadas mínimas.
- P2 queda fuera: Outlook, múltiples cuentas, push e IA opcional.

Referencias oficiales: [messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list),
[messages.batchModify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/batchModify)
y [cuotas](https://developers.google.com/workspace/gmail/api/reference/quota).
