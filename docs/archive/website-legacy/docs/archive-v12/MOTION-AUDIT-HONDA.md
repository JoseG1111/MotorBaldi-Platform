# Auditoría de motion — Honda Powersports → MotorBaldi V12

## Qué se tomó como referencia

La referencia no se trató como una paleta visual sino como un sistema de experiencia. Honda Powersports combina grandes módulos de campaña, producto en acción, navegación clara, contenido de alto impacto y una narrativa que cambia de ritmo al avanzar por la página. El caso de estudio del rediseño de Honda describe explícitamente full-screen video, visuales dinámicos, navegación intuitiva y experiencias inmersivas.

## Traducción a MotorBaldi

### 1. Capítulos en vez de bloques
Cada sección de MotorBaldi se comporta como un capítulo con entrada, momento principal y salida. El rail lateral ayuda a percibir el recorrido como una experiencia continua.

### 2. Secciones sticky
Servicios permanece anclado en desktop mientras el scroll recorre las cinco rutas. La interfaz cambia dentro del mismo escenario, en lugar de obligar al usuario a leer cinco tarjetas estáticas.

Plataforma también permanece anclada mientras cambian la profundidad y las capas del Digital Twin conceptual.

### 3. Transición fuerte de marca
Antes de MB-100 se añadió una transición de 205vh con un frame sticky a pantalla completa. El rojo cubre la vista progresivamente, aparece tipografía cinética de gran escala, un contador avanza de 00 a 100 y la transición desemboca directamente en Pioneros.

### 4. Fotografía como protagonista
No se reincorporó el robot 3D. Hero, servicios y Carro/Moto usan fotografía/arte de marca real. Los efectos actúan sobre la fotografía mediante escala, máscara, parallax y profundidad.

### 5. Motion con jerarquía
- Hero: entrada, titulares rotativos, salida por scroll.
- Universo: fotografías con reveal y zoom editorial.
- Servicios: sticky + secuencia automática/manual.
- Carro/Moto: reveal de imagen + parallax + tipografía de fondo.
- Plataforma: sticky + perspectiva y capas.
- MB-100: wipe rojo + marquee + contador.
- Proceso: progreso activo.
- UI: header dinámico y botones magnéticos.

### 6. Producción y accesibilidad
El sistema usa `requestAnimationFrame`, `IntersectionObserver` y CSS transforms. No hay WebGL, Three.js ni modelos GLB. `prefers-reduced-motion` desactiva las coreografías que podrían causar molestias. Los reveals tienen un fail-safe para que el contenido nunca dependa de que una animación se ejecute correctamente.
