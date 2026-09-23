# Smoke test manual de Gmail

Este checklist requiere una cuenta de prueba autorizada y consentimiento explícito
del propietario. No se ejecuta en CI y no constituye permiso para usar un buzón real.

## Preparación

- Crear un cliente OAuth de escritorio, habilitar Gmail API y mantener secretos fuera
  del repositorio.
- Ejecutar `pnpm auth:gmail`, guardar el refresh token en el archivo ignorado y definir
  `MAIL_PROVIDER=gmail` y `GOOGLE_TOKEN_FILE`.
- Usar una cuenta con mensajes de prueba recuperables y verificar que el scope mostrado
  sea únicamente `gmail.modify`.

## Lectura y cobertura

- Iniciar `pnpm dev`, autenticar el dashboard y escanear 100, 1.000 y, si corresponde,
  más mensajes sin superar 10.000.
- Confirmar que una ventana truncada se muestre como parcial y que
  `resultSizeEstimate` no aparezca como total exacto.
- Revisar ventanas 7/30/90, paginación, remitente mixto y ausencia de cuerpos/adjuntos.
- Provocar de forma controlada un rate limit de lectura o simularlo en transporte;
  verificar enfriamiento visible, checkpoint conservado y reanudación automática. Si
  se agotan los reintentos acotados, verificar el error terminal.
- Interrumpir el proceso después de una página, reiniciar y comprobar que continúa
  desde el checkpoint. Tras completar, confirmar que el siguiente refresh usa
  `history.list`; probar también la recuperación segura de un `historyId` vencido.

## Preview y autorización

- Crear selección por ID, fecha, leído/no leído y categoría; comprobar IDs congelados.
- Crear un plan con dos remitentes y verificar desglose, cuenta única y límite de 1.000.
- Hacer llegar un mensaje después del preview y confirmar que queda fuera.
- Cambiar una etiqueta a importante/destacada antes de ejecutar y confirmar que falla.
- Verificar que MCP no pueda emitir confirmación; rechazar token ausente, falso,
  expirado, reutilizado, de otro preview y de otra cuenta.
- Incluir deliberadamente una clase protegida y comprobar los dos pasos separados del
  dashboard. Cancelar antes de ejecutar y durante una operación larga.

## Papelera y recuperación

- Mover un conjunto mínimo aprobado a Papelera y comprobar resultados por mensaje y
  remitente. Restaurarlo manualmente después de la prueba.
- Incluir un mensaje ya movido y verificar `ALREADY_TRASHED`.
- Simular desconexión después de enviar una mutación; comprobar `UNCERTAIN`, ausencia
  de reintento y reconciliación de solo lectura.
- Revocar la cuenta, probar refresh y verificar errores de autenticación y permisos sin
  datos privados en logs.

## Cierre

- Cancelar operaciones pendientes, restaurar los mensajes de prueba y detener el
  servidor. Eliminar el token local si la cuenta no continuará conectada.
- Registrar fecha, versión, cuenta de prueba anonimizada, casos aprobados/fallidos y
  capturas sin asuntos, direcciones, tokens ni claves.
