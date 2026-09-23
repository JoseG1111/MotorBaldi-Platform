# Captura directa MotorBaldi

La interfaz de precios ya no carga el Widget. `assets/js/payment-capture.js`
captura tarjeta o Nequi dentro del modal MotorBaldi. No cambian Payment Sources,
primer cobro, webhooks, cancelaciones ni renovaciones.

- Tarjeta: llave pública de cifrado → JWE compacto RSA-OAEP-256/A256GCM con
  Web Crypto → POST directo a Wompi `/v1/tokens/cards` → token al backend.
- La respuesta real de `/v1/tokens/keys/tokenization` no incluye CORS tanto en
  `api.wompi.co` como en `production.wompi.co`. Se comprobó desde staging.
  `api/wompi-tokenization-key.php` obtiene y devuelve SOLO esa llave pública;
  no recibe datos de tarjeta, ni tokeniza, ni expone credenciales privadas.
- Nequi: POST directo `/v1/tokens/nequi`, consulta secuencial cada 2,5 segundos
  hasta APPROVED. PENDING no se envía al backend. A los tres minutos permite
  retomar la consulta del mismo token. Cerrar cancela la espera local.
- Los campos sensibles no tienen `name`; el envío al backend usa además una
  lista explícita de campos permitidos. No hay almacenamiento ni logs de PAN,
  CVC o payload. Los valores se limpian tras cifrar, cerrar o salir de la página.
- Moto mensual: 2990000 centavos; anual: 28800000. Carro mantiene sus precios.
  Las renovaciones conservan el importe contratado guardado en servidor.

Pruebas: `npm run build`, `npm run lint:php`, `npm run test:payments` y
`npx playwright test tests/wompi.spec.js`. El navegador cifra realmente y el
doble de Wompi descifra y verifica el JWE; las respuestas de tokenización son
simuladas. Se verifican aprobación/rechazo/espera Nequi, validación, responsive,
lista de campos enviada y los importes de primer cobro y renovación en PHP.

Pendiente: prueba integral con credenciales sandbox válidas del comercio.
La llave sandbox del ejemplo oficial devuelve comercio inexistente; no prueba
la cuenta MotorBaldi. No se realizaron tokenizaciones ni cobros en producción.
La captura propia requiere revisar con Wompi el alcance PCI DSS aplicable al
comercio; cifrar los datos no elimina por sí solo ese requisito.

Referencias oficiales:
- https://docs.wompi.co/docs/colombia/metodos-de-pago/
- https://docs.wompi.co/docs/colombia/fuentes-de-pago/

## Registro anterior del Widget — conservado como historial

Se preparó `dist/` y el archivo `motorbaldi-pagos-listo-para-subir.zip` para
un hosting PHP con cURL y PDO SQLite. La configuración privada, el webhook
y el cron conservan sus ubicaciones y URLs.

## Cambios comprobados

- El formulario sale de la capa modal antes de abrir la ventana oficial de Wompi.
- Los cuatro planes disponibles solicitan el vehículo y período correctos.
- Una autorización visible y explícita enlaza los contratos de MotorBaldi y
  Wompi, el tratamiento de datos y la renovación. Se conservan los tokens de los
  contratos presentados al cliente para crear su fuente y primer cobro.
- Una solicitud de pago solo puede procesarse una vez; reutilizar el mismo
  token en otra solicitud tampoco genera otro cobro.
- El precio lo fija el servidor. Se comprueban monto, moneda e identificador
  de transacción antes de modificar la suscripción.
- El webhook valida su firma y consulta la transacción a Wompi. Los eventos
  duplicados y las respuestas pendientes tardías no revierten la aprobación.
- Una renovación pendiente mantiene bloqueado un nuevo débito. El cron
  consulta transacciones pendientes con ID para recuperar webhooks perdidos.
- Si la conexión se pierde tras enviar el cobro, se conserva como pendiente
  y el webhook puede confirmarlo sin volver a cobrar.
- Las fechas de fin de mes y año bisiesto no saltan al mes siguiente.

## Pruebas realizadas

- Sintaxis de todos los endpoints con el analizador PHP y PHP CLI 8.5.
- `npm run test:payments`: pruebas PHP/SQLite y HTTP con proveedor simulado;
  aprobación, rechazo, firma inválida, reenvíos, renovación, reconciliación,
  monto alterado, eventos fuera de orden y conexión interrumpida aprobados.
- Navegador: script oficial `https://checkout.wompi.co/widget.js` descargado
  para QA; API e interior del iframe simulados, sin tarjetas ni cobros reales.
- Suite completa: los 21 casos de Chromium y 20 de 21 en Firefox pasaron en
  ejecución paralela. Un caso ajeno a pagos (teclado del menú/FAQ) agotó su
  espera bajo carga y pasó al repetirlo aisladamente con un trabajador.
- Los cinco casos específicos de suscripción pasaron usando una copia actual
  del widget oficial: validación, monto, CTA, tokenización, planes, responsive,
  rutas y manejo de indisponibilidad.
- Revisión de `dist/`: no incluye `.env`, configuraciones privadas, bases,
  pruebas ni secretos del entorno local.

Las pruebas no autentican el comercio real ni verifican el cron del hosting.
La URL pública de checkout devolvía 404 antes de subir esta entrega. No se
realizó un cobro real ni se publicó ningún archivo en el hosting.

Documentación oficial consultada:

- https://docs.wompi.co/docs/colombia/fuentes-de-pago/
- https://docs.wompi.co/docs/colombia/tokens-de-aceptacion/

## Repetir pruebas

Ejecutar `npm run test:payments` con PHP CLI, PDO y PDO SQLite disponibles.
Se puede indicar `PHP_BINARY` y `PHP_EXTENSION_DIR` si PHP está en otra ruta.
El proveedor simulado se carga únicamente en el servidor de pruebas.

Para navegador: `npm test`. Opcionalmente, `WOMPI_WIDGET_PATH` permite indicar
una copia local del widget oficial y `WOMPI_MOBILE=1` activa la vista móvil.
Los dobles de pruebas no forman parte de `dist/` ni del ZIP.
