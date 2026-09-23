# Revisión de MotorBaldi 12.2

Fecha: 8 de septiembre de 2026. Revisión del staging público y del build local servido por HTTP con fotografías reales.

## Cambios comprobados

- Imagen original del hero conservada en escritorio y móvil. Tres titulares cada 6,8 s; pausa, reanudación y selección manual operativas. Altura estable entre frases.
- Eliminado el temporizador que revelaba toda la página a los 2,6 s y el segundo sistema de entradas que sobrescribía las animaciones. Un observador controla las entradas y el foco de teclado muestra el contenido.
- Encabezado centrado también durante su salida. Logo con espacio dentro del encabezado. Eliminada la franja superior provocada por el enlace de salto en el flujo normal.
- Tarjetas Universo con texto claro y altura suficiente. Indicador lateral compacto, fuera de las columnas de contenido.
- Servicios con panel completo dentro del viewport cuando se fija, menor recorrido de scroll, selección manual estable y navegación horizontal con teclado. La quinta opción navega a Plataforma en la misma pestaña.
- Cambios de servicio y de vehículo protegidos contra respuestas tardías de carga de imágenes. La imagen corresponde a la selección más reciente.
- Plataforma con tarjeta completa y sin las tarjetas flotantes duplicadas que tapaban información.
- Transición roja que empieza al entrar en pantalla; versión móvil breve y texto diferenciado de Pioneros.
- Pase MB-100 con logo, código y pie separados en el flujo normal, sin superposición.
- Acceso móvil a WhatsApp más compacto. Formulario validado, preselección desde los CTA y sincronización Carro/Moto en ambos sentidos.
- Formulario conectado a HubSpot mediante un endpoint PHP sin exponer el token. Crea o actualiza el contacto por correo y crea un negocio asociado en el pipeline `default`, etapa `1433840728`.
- Campos de nombre, correo, teléfono y consentimiento; validación duplicada en cliente y servidor, honeypot, límite por IP, comprobación de origen y mensajes de recuperación ante errores.
- Movimiento reducido y alternativa sin JavaScript. Sin JavaScript el formulario se reemplaza por un enlace directo, para evitar enviar los campos por una navegación HTML accidental.
- Archivos de estilos y scripts con nombres funcionales, formato legible, dependencias de desarrollo fijadas en package-lock.json y evidencias antiguas archivadas.

## Pruebas

La suite completa obtuvo **32/32 pruebas aprobadas** en Chromium y Firefox. Resultado: `results.json`.

Después del ajuste final del pase y del botón móvil se repitió el recorrido visual en ambos navegadores, agregando la comprobación de separación entre logo, código y pie del pase. Resultado: **14/14 recorridos aprobados**, sin fallos ni pruebas omitidas (`layout-results.json`).

Tamaños revisados: 320×740, 390×844, 768×1024, 1024×768, 1280×800, 1440×900 y 1920×1080. Los recorridos verifican imágenes cargadas, ausencia de errores JavaScript y respuestas HTTP fallidas, ausencia de desbordamiento horizontal y encaje de la tarjeta de Plataforma en escritorio. La prueba de Servicios comprueba las cinco posiciones de scroll y el encaje del panel.

Las pruebas funcionales cubren rotación, pausa, entradas tardías al viewport, selección manual, cargas de imágenes fuera de orden, Carro/Moto, menú y foco, teclado, FAQ, validación, CTA, payload de HubSpot, éxito y error de la API, URL de WhatsApp, anclas, canonical, archivos auxiliares y página 404. HubSpot y WhatsApp se interceptan en estas pruebas; no se crearon registros ni se enviaron mensajes.

El endpoint PHP también se ejecutó contra un servidor HubSpot simulado. Se verificaron los flujos de contacto nuevo y existente, creación del negocio, asociación tipo `3`, pipeline, etapa, validación previa y rechazo de otro origen. La etapa real fue consultada de forma no destructiva con la app privada: HubSpot confirmó el ID `1433840728`, etiqueta `new`, y la asociación negocio→contacto tipo `3`.

La galería `galeria.html` contiene **32 capturas** completas a 390 y 1440 px: capítulos, tarjetas, tres estados del hero y páginas auxiliares. Además están las capturas por viewport del recorrido automatizado. Se inspeccionaron las capturas para localizar y corregir problemas que las pruebas funcionales no detectaban, como la superposición del pase.

## Entrega y alcance

`dist/` contiene exclusivamente los archivos públicos. El ZIP de `releases/` incluye ese mismo contenido, con `.htaccess` en la raíz. El token se mantiene fuera de ambos y debe instalarse en `~/motorbaldi-hubspot.php`.

La revisión se realizó en navegadores de escritorio con tamaños de pantalla simulados; no equivale a una prueba en dispositivos físicos ni en Safari. No se modificó el staging ni se desplegó a producción. Las cabeceras de Apache/LiteSpeed y HTTPS deben comprobarse tras subir al hosting, siguiendo `PUBLICAR.txt`; el servidor local no interpreta `.htaccess`.
