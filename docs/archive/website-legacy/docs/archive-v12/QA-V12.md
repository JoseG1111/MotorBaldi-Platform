# QA — MotorBaldi V12 Cinematic Production

Fecha de validación: 2026-09-08

## Resultado

- Build de producción: aprobado.
- Sintaxis JS: aprobada (`ui-v10.js` y `motion-v12.js`).
- Errores JS en harness Chromium: 0.
- Pruebas funcionales automatizadas: 19/19 aprobadas.
- Overflow horizontal: sin overflow en 320, 390, 768, 1440 y 1920 px.
- Reduced Motion: aprobado.
- Assets 3D/WebGL de producción: ninguno.
- `dist/`: aproximadamente 2 MiB sin comprimir.

## Interacciones verificadas

- Cambio manual de Servicios + estado ARIA.
- Secuencia de Servicios ligada al scroll en prueba visual.
- Carro/Moto → formulario.
- Formulario → Carro/Moto.
- CTA Plataforma → preselección del formulario.
- CTA MB-100 → preselección del formulario.
- Errores accesibles del formulario.
- Construcción de enlace oficial de WhatsApp sin envío automático durante QA.
- Menú móvil: apertura, foco al cierre, Escape y restauración del foco.
- Intro visual no bloquea interacción.
- `prefers-reduced-motion` activa versión reducida.

## Revisión visual

Capturas finales disponibles en `docs-v12/`:
- `desktop-hero-final.png`
- `desktop-services-final.png`
- `desktop-mobility-final.png`
- `desktop-platform-final.png`
- `desktop-red-final.png`
- `mobile-hero-final.png`
- `mobile-mobility-final.png`
- `mobile-red-final.png`

## Alcance de la prueba

El navegador automatizado usado fue Chromium en Linux. No se afirma certificación WCAG formal ni prueba física en Safari/iOS/Android. Antes del lanzamiento definitivo conviene una revisión final en los dispositivos reales más importantes para la audiencia.
