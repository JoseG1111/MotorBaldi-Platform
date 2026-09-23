(() => {
  "use strict";

  document.documentElement.classList.add("js");
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [
    ...root.querySelectorAll(selector),
  ];
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const clamp = (value, min = 0, max = 1) =>
    Math.min(max, Math.max(min, value));

  const state = {
    vehicle: "car",
    service: "maintenance",
    reduced: motion.matches,
    menuOpener: null,
  };

  const year = $("#year");
  if (year) year.textContent = String(new Date().getFullYear());

  const announce = (message = "") => {
    const live = $("#form-announcement");
    if (!live) return;
    live.textContent = "";
    requestAnimationFrame(() => {
      live.textContent = message;
    });
  };

  // ------------------------------------------------------------
  // Hero title rotation (6.8s). Pauses in background and respects
  // reduced-motion dynamically without a page reload.
  // ------------------------------------------------------------
  const heroLines = $$("[data-hero-line]");
  const heroDots = $$("[data-hero-dot]");
  const heroPause = $("#hero-rotator-pause");
  const heroCount = $("#hero-rotator-count");
  let heroIndex = 0;
  let heroTimer = 0;
  let heroPaused = false;

  const stopHeroRotation = () => {
    if (heroTimer) clearTimeout(heroTimer);
    heroTimer = 0;
  };
  const renderHeroLine = (index) => {
    heroIndex = index;
    heroLines.forEach((line, i) =>
      line.classList.toggle("is-active", i === index),
    );
    heroDots.forEach((dot, i) => {
      const active = i === index;
      dot.classList.toggle("is-active", active);
      dot.setAttribute("aria-pressed", String(active));
    });
    if (heroCount)
      heroCount.textContent = `${String(index + 1).padStart(2, "0")} / ${String(heroLines.length).padStart(2, "0")}`;
  };
  const scheduleHeroRotation = () => {
    stopHeroRotation();
    if (state.reduced || heroPaused || document.hidden || heroLines.length < 2)
      return;
    heroTimer = setTimeout(() => {
      renderHeroLine((heroIndex + 1) % heroLines.length);
      scheduleHeroRotation();
    }, 6800);
  };
  heroDots.forEach((dot) =>
    dot.addEventListener("click", () => {
      renderHeroLine(Number(dot.dataset.heroDot));
      scheduleHeroRotation();
    }),
  );
  heroPause?.addEventListener("click", () => {
    heroPaused = !heroPaused;
    heroPause.setAttribute("aria-pressed", String(heroPaused));
    heroPause.textContent = heroPaused ? "Reanudar" : "Pausar";
    heroPause.setAttribute(
      "aria-label",
      heroPaused ? "Reanudar titulares" : "Pausar titulares",
    );
    scheduleHeroRotation();
  });
  document.addEventListener("visibilitychange", scheduleHeroRotation);
  if (heroLines.length) renderHeroLine(0);
  scheduleHeroRotation();

  // ------------------------------------------------------------
  // Header, section indicator and lightweight cinematic scroll.
  // No WebGL, no canvas, no persistent GPU scene.
  // ------------------------------------------------------------
  const header = $("#site-header");
  const progressBar = $(".reading-track span");
  const navLinks = $$('.desktop-nav a[href^="#"]');
  const mobileBar = $(".mobile-contact-bar");
  const mobileBarSuppress = [
    "#servicios",
    "#nosotros",
    "#plataforma",
    "#pioneros",
    "#preguntas",
    "#contacto",
  ]
    .map((selector) => $(selector))
    .filter(Boolean);
  let scrollFrame = 0;

  const updateScroll = () => {
    scrollFrame = 0;
    const y = scrollY;
    const max = Math.max(
      1,
      document.documentElement.scrollHeight - innerHeight,
    );
    header?.classList.toggle("is-scrolled", y > 24);
    if (progressBar) progressBar.style.transform = `scaleX(${clamp(y / max)})`;

    navLinks.forEach((link) => {
      const section = document.querySelector(link.getAttribute("href"));
      if (!section) return;
      const rect = section.getBoundingClientRect();
      const active =
        rect.top <= innerHeight * 0.35 && rect.bottom > innerHeight * 0.35;
      link.classList.toggle("is-active", active);
      active
        ? link.setAttribute("aria-current", "location")
        : link.removeAttribute("aria-current");
    });

    if (mobileBar) {
      const suppress = mobileBarSuppress.some((section) => {
        const rect = section.getBoundingClientRect();
        return (
          rect.bottom > innerHeight * 0.15 && rect.top < innerHeight * 0.82
        );
      });
      mobileBar.classList.toggle(
        "is-hidden",
        y < innerHeight * 0.48 ||
          suppress ||
          document.body.classList.contains("menu-open"),
      );
    }
  };
  const requestScrollUpdate = () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(updateScroll);
  };
  addEventListener("scroll", requestScrollUpdate, { passive: true });
  addEventListener("resize", requestScrollUpdate, { passive: true });
  requestScrollUpdate();

  // ------------------------------------------------------------
  // Pointer lighting and restrained card tilt, desktop only.
  // ------------------------------------------------------------
  // ------------------------------------------------------------
  // Mobile menu with focus restoration and focus movement to the
  // selected section after navigation.
  // ------------------------------------------------------------
  const menu = $("#mobile-menu");
  const menuToggle = $(".menu-toggle");
  const menuClose = $(".menu-close");

  const closeMenu = ({ restore = true } = {}) => {
    if (!menu) return;
    if (menu.open && typeof menu.close === "function") menu.close();
    else menu.removeAttribute("open");
    menuToggle?.setAttribute("aria-expanded", "false");
    document.body.classList.remove("menu-open");
    requestScrollUpdate();
    if (restore)
      setTimeout(() => state.menuOpener?.focus?.({ preventScroll: true }), 0);
  };
  const openMenu = () => {
    if (!menu) return;
    state.menuOpener = document.activeElement;
    if (typeof menu.showModal === "function") menu.showModal();
    else menu.setAttribute("open", "");
    document.body.classList.remove("header-hidden");
    document.body.classList.add("menu-open");
    requestScrollUpdate();
    menuToggle?.setAttribute("aria-expanded", "true");
    menuClose?.focus({ preventScroll: true });
  };
  menuToggle?.addEventListener("click", openMenu);
  menuClose?.addEventListener("click", () => closeMenu());
  menu?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeMenu();
  });
  menu?.addEventListener("click", (event) => {
    if (event.target === menu) closeMenu();
  });
  menu?.addEventListener("close", () => {
    document.body.classList.remove("menu-open");
    requestScrollUpdate();
    menuToggle?.setAttribute("aria-expanded", "false");
  });

  const focusSection = (target) => {
    const heading = target?.querySelector("h1,h2") || target;
    if (!heading) return;
    if (!heading.hasAttribute("tabindex"))
      heading.setAttribute("tabindex", "-1");
    setTimeout(
      () => heading.focus({ preventScroll: true }),
      state.reduced ? 0 : 520,
    );
  };
  $$('a[href^="#"]', menu || document).forEach((link) => {
    if (!link.closest("#mobile-menu")) return;
    link.addEventListener("click", (event) => {
      const target = document.querySelector(link.getAttribute("href"));
      if (!target) return;
      event.preventDefault();
      closeMenu({ restore: false });
      target.scrollIntoView({
        behavior: state.reduced ? "auto" : "smooth",
        block: "start",
      });
      focusSection(target);
    });
  });

  // ------------------------------------------------------------
  // Services interaction.
  // ------------------------------------------------------------
  const serviceData = {
    maintenance: {
      count: "01",
      kicker: "MANTENIMIENTO",
      title: "Protege lo que te mueve.",
      text: "Productos y orientación para cuidar el motor y mantener el rendimiento de tu carro o moto.",
      image: "assets/images/optimized/lubricantes.webp",
      alt: "Aceites, lubricantes y filtros para vehículos",
      link: "https://wa.me/573104602615?text=Hola%20MotorBaldi%2C%20quiero%20consultar%20sobre%20mantenimiento%2C%20aceites%20y%20lubricantes.",
    },
    parts: {
      count: "02",
      kicker: "REPUESTOS",
      title: "La pieza correcta, con contexto.",
      text: "Comparte marca, modelo, año o referencia. Te ayudamos a orientar la búsqueda de lo que tu vehículo necesita.",
      image: "assets/images/optimized/repuestos.webp",
      alt: "Repuestos y componentes para vehículos",
      link: "https://wa.me/573104602615?text=Hola%20MotorBaldi%2C%20estoy%20buscando%20un%20repuesto%20para%20mi%20veh%C3%ADculo.",
    },
    market: {
      count: "03",
      kicker: "COMPRA + VENTA",
      title: "Tu siguiente movimiento.",
      text: "Acompañamiento para explorar alternativas cuando llega el momento de comprar, vender o cambiar de vehículo.",
      image: "assets/images/optimized/compra-venta.webp",
      alt: "Vehículos para compra y venta",
      link: "https://wa.me/573104602615?text=Hola%20MotorBaldi%2C%20quiero%20informaci%C3%B3n%20sobre%20compra%20o%20venta%20de%20un%20veh%C3%ADculo.",
    },
    assist: {
      count: "04",
      kicker: "ASISTENCIA",
      title: "Cuando el camino cambia.",
      text: "Cuéntanos qué pasó y dónde estás de forma general. Te orientamos sobre disponibilidad y el siguiente paso.",
      image: "assets/images/optimized/asistencia.webp",
      alt: "Asistencia para vehículo en carretera",
      link: "https://wa.me/573104602615?text=Hola%20MotorBaldi%2C%20necesito%20consultar%20sobre%20asistencia%20vehicular.",
    },
    history: {
      count: "05",
      kicker: "HISTORIA DIGITAL",
      title: "Tu vehículo también puede tener memoria.",
      text: "Nuestra visión: una historia digital que conecte mantenimientos, documentos, alertas y decisiones importantes del vehículo.",
      image: "assets/images/optimized/vehiculo-480.webp",
      alt: "Automóvil presentado como perfil digital de vehículo",
      link: "#plataforma",
    },
  };
  const serviceTabs = $$(".service-tab");
  const serviceCard = $(".scene-card-main");
  const serviceImage = $("#service-image");

  const chooseService = (key, { focusTab = false } = {}) => {
    const data = serviceData[key];
    if (!data) return;
    if (key === state.service) return;
    state.service = key;
    serviceTabs.forEach((tab) => {
      const active = tab.dataset.service === key;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focusTab) {
        tab.focus({ preventScroll: true });
        const list = tab.parentElement;
        list.scrollTo({
          left:
            list.scrollLeft +
            tab.getBoundingClientRect().left -
            list.getBoundingClientRect().left -
            14,
          behavior: state.reduced ? "instant" : "smooth",
        });
      }
    });
    const activeTab = serviceTabs.find((tab) => tab.dataset.service === key);
    $("#service-panel")?.setAttribute("aria-labelledby", activeTab?.id || "");
    $("#service-count").textContent = data.count;
    $("#service-kicker").textContent = data.kicker;
    $("#service-title").textContent = data.title;
    $("#service-text").textContent = data.text;
    const link = $("#service-link");
    link.href = data.link;
    if (data.link.startsWith("#")) {
      link.removeAttribute("target");
      link.removeAttribute("rel");
    } else {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    if (serviceImage) {
      serviceCard?.classList.add("is-switching");
      const preload = new Image();
      preload.onload = () => {
        if (state.service !== key) return;
        serviceImage.src = data.image;
        serviceImage.alt = data.alt;
        serviceCard?.classList.remove("is-switching");
        if (!state.reduced)
          serviceImage.animate([{ opacity: 0.3 }, { opacity: 1 }], {
            duration: 360,
            easing: "ease-out",
          });
      };
      preload.onerror = () => {
        if (state.service === key)
          serviceCard?.classList.remove("is-switching");
      };
      preload.src = data.image;
    }
  };
  serviceTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => chooseService(tab.dataset.service));
    tab.addEventListener("keydown", (event) => {
      if (
        ![
          "ArrowDown",
          "ArrowUp",
          "ArrowRight",
          "ArrowLeft",
          "Home",
          "End",
        ].includes(event.key)
      )
        return;
      event.preventDefault();
      let next = index;
      if (event.key === "ArrowDown" || event.key === "ArrowRight")
        next = (index + 1) % serviceTabs.length;
      if (event.key === "ArrowUp" || event.key === "ArrowLeft")
        next = (index - 1 + serviceTabs.length) % serviceTabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = serviceTabs.length - 1;
      chooseService(serviceTabs[next].dataset.service, { focusTab: true });
    });
  });

  // ------------------------------------------------------------
  // Car / Moto synchronizes in both directions with the form.
  // Section remains photographic and lightweight.
  // ------------------------------------------------------------
  const vehicleData = {
    car: {
      src: "assets/images/optimized/motorbaldi-carros-v6-960.webp",
      srcset:
        "assets/images/optimized/motorbaldi-carros-v6-480.webp 480w, assets/images/optimized/motorbaldi-carros-v6-960.webp 960w, assets/images/optimized/motorbaldi-carros-v6-1642.webp 1642w",
      alt: "Carros alineados en un taller con identidad de MotorBaldi",
      label: "CARRO",
      caption: "Acompañamiento para tu camino.",
      title: "Tu carro, con más contexto.",
      text: "Mantenimiento, productos, repuestos y asistencia alrededor de las necesidades de tu carro.",
      formValue: "Automóvil",
    },
    moto: {
      src: "assets/images/optimized/motorbaldi-motos-v6-960.webp",
      srcset:
        "assets/images/optimized/motorbaldi-motos-v6-480.webp 480w, assets/images/optimized/motorbaldi-motos-v6-960.webp 960w, assets/images/optimized/motorbaldi-motos-v6-1642.webp 1642w",
      alt: "Motocicletas alineadas en un taller con identidad de MotorBaldi",
      label: "MOTO",
      caption: "El mismo acompañamiento, sobre dos ruedas.",
      title: "Tu moto, en el mismo universo.",
      text: "El mismo acompañamiento, adaptado a quienes viven la movilidad sobre dos ruedas.",
      formValue: "Motocicleta",
    },
    other: {
      label: "OTRO",
      caption: "Cuéntanos qué vehículo tienes.",
      title: "Tu caso también tiene una ruta.",
      text: "Cuéntanos qué vehículo tienes y qué necesitas. Te orientamos sobre el siguiente paso.",
      formValue: "Otro",
    },
  };
  const vehicleButtons = $$(".vehicle-switch [data-vehicle]");
  const vehicleRadios = $$('input[name="vehicle"]');
  const vehicleImage = $("#vehicle-image");
  const vehiclePhoto = $(".vehicle-photo-real");

  const chooseVehicle = (key, { fromForm = false } = {}) => {
    const data = vehicleData[key] || vehicleData.car;
    state.vehicle = key;
    vehicleButtons.forEach((button) => {
      const active = button.dataset.vehicle === key;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (!fromForm)
      vehicleRadios.forEach((radio) => {
        radio.checked = radio.value === data.formValue;
      });
    $("#vehicle-type-label").textContent = data.label;
    $("#vehicle-caption").textContent = data.caption;
    $("#vehicle-panel-title").textContent = data.title;
    $("#vehicle-panel-text").textContent = data.text;
    vehiclePhoto?.classList.remove("is-switching");
    if (key !== "other" && vehicleImage) {
      vehiclePhoto?.classList.add("is-switching");
      const preload = new Image();
      preload.onload = () => {
        if (state.vehicle !== key) return;
        vehicleImage.src = data.src;
        vehicleImage.srcset = data.srcset;
        vehicleImage.alt = data.alt;
        vehiclePhoto?.classList.remove("is-switching");
        if (!state.reduced)
          vehicleImage.animate([{ opacity: 0.3 }, { opacity: 1 }], {
            duration: 360,
            easing: "ease-out",
          });
      };
      preload.onerror = () => {
        if (state.vehicle === key)
          vehiclePhoto?.classList.remove("is-switching");
      };
      preload.src = data.src;
    }
  };
  vehicleButtons.forEach((button) =>
    button.addEventListener("click", () =>
      chooseVehicle(button.dataset.vehicle),
    ),
  );
  vehicleRadios.forEach((radio) =>
    radio.addEventListener("change", () => {
      const key =
        radio.value === "Motocicleta"
          ? "moto"
          : radio.value === "Otro"
            ? "other"
            : "car";
      chooseVehicle(key, { fromForm: true });
    }),
  );
  chooseVehicle("car");

  // ------------------------------------------------------------
  // CTA preselection: platform and MB-100 prepare the form.
  // ------------------------------------------------------------
  const form = $("#quote-form");
  const serviceSelect = $("#service");
  const details = $("#details");
  const nameInput = $("#name");
  const emailInput = $("#email");
  const phoneInput = $("#phone");
  const consentInput = $("#consent");
  const submitButton = $(".submit-button", form);
  const submitLabel = $("[data-submit-label]", form);
  const formResult = $("#form-result");
  const formError = $("#form-error");

  const clearFieldError = (name) => {
    const error = $(`#${name}-error`);
    if (error) error.hidden = true;
    if (name === "vehicle") {
      vehicleRadios.forEach((radio) =>
        radio.setAttribute("aria-invalid", "false"),
      );
      $("#vehicle-fieldset")?.removeAttribute("aria-invalid");
      return;
    }
    $(`#${name}`)?.setAttribute("aria-invalid", "false");
  };

  $$("[data-form-service]").forEach((link) =>
    link.addEventListener("click", (event) => {
      const target = $("#contacto");
      if (!target || !serviceSelect) return;
      event.preventDefault();
      serviceSelect.value = link.dataset.formService;
      clearFieldError("service");
      announce(
        `Consulta seleccionada: ${link.dataset.formService}. Completa tus datos para registrar la solicitud.`,
      );
      target.scrollIntoView({
        behavior: state.reduced ? "auto" : "smooth",
        block: "start",
      });
      setTimeout(
        () => serviceSelect.focus({ preventScroll: true }),
        state.reduced ? 0 : 520,
      );
    }),
  );

  // ------------------------------------------------------------
  // Accessible form validation and WhatsApp hand-off.
  // ------------------------------------------------------------
  const setFieldError = (name, invalid) => {
    const error = $(`#${name}-error`);
    if (error) error.hidden = !invalid;
    if (name === "vehicle") {
      vehicleRadios.forEach((radio) =>
        radio.setAttribute("aria-invalid", String(invalid)),
      );
      $("#vehicle-fieldset")?.setAttribute("aria-invalid", String(invalid));
      return;
    }
    $(`#${name}`)?.setAttribute("aria-invalid", String(invalid));
  };

  const setSubmitting = (submitting) => {
    if (submitButton) submitButton.disabled = submitting;
    if (submitLabel) {
      submitLabel.textContent = submitting
        ? "Registrando solicitud…"
        : "Registrar y continuar por WhatsApp";
    }
    form?.setAttribute("aria-busy", String(submitting));
  };

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const vehicle = $('input[name="vehicle"]:checked', form);
    const flags = {
      name: !nameInput?.value.trim() || nameInput.value.trim().length < 2,
      email: !emailInput?.validity.valid,
      phone:
        !phoneInput?.value.trim() ||
        !/^\+?[0-9 ()-]{7,24}$/.test(phoneInput.value.trim()),
      vehicle: !vehicle,
      service: !serviceSelect?.value,
      details: !details?.value.trim() || details.value.trim().length < 10,
      consent: !consentInput?.checked,
    };
    Object.entries(flags).forEach(([name, invalid]) =>
      setFieldError(name, invalid),
    );
    const invalidNames = Object.keys(flags).filter((name) => flags[name]);
    if (invalidNames.length) {
      const first =
        invalidNames[0] === "vehicle"
          ? vehicleRadios[0]
          : $(`#${invalidNames[0]}`);
      first?.focus();
      announce(
        `Revisa ${invalidNames.length === 1 ? "el campo indicado" : `los ${invalidNames.length} campos indicados`} antes de continuar.`,
      );
      return;
    }

    const message = [
      "Hola MotorBaldi, quiero información para mi vehículo.",
      "",
      `Nombre: ${nameInput.value.trim()}`,
      `Correo: ${emailInput.value.trim()}`,
      `Teléfono: ${phoneInput.value.trim()}`,
      `Vehículo: ${vehicle.value}`,
      `Necesidad: ${serviceSelect.value}`,
      `Detalle: ${details.value.trim()}`,
    ].join("\n");
    const url = `https://wa.me/573104602615?text=${encodeURIComponent(message)}`;
    const fallback = $("#whatsapp-fallback");
    if (fallback) fallback.href = url;
    if (formResult) formResult.hidden = true;
    if (formError) formError.hidden = true;

    // Opening the tab during the click keeps it available after the API request.
    const whatsappWindow = window.open("about:blank", "_blank");
    if (whatsappWindow) whatsappWindow.opener = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    setSubmitting(true);

    try {
      const response = await fetch("api/hubspot.php", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: nameInput.value.trim(),
          email: emailInput.value.trim(),
          phone: phoneInput.value.trim(),
          vehicle: vehicle.value,
          service: serviceSelect.value,
          details: details.value.trim(),
          consent: consentInput.checked,
          company_website: form.elements.company_website?.value || "",
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) {
        if (payload.errors && typeof payload.errors === "object") {
          Object.keys(payload.errors).forEach((name) =>
            setFieldError(name, true),
          );
          const firstName = Object.keys(payload.errors)[0];
          const first =
            firstName === "vehicle" ? vehicleRadios[0] : $(`#${firstName}`);
          first?.focus();
        }
        throw new Error(payload.message || "HubSpot request failed");
      }

      if (formResult) formResult.hidden = false;
      announce(
        "Solicitud registrada. WhatsApp se abrirá con tu mensaje preparado.",
      );
      if (whatsappWindow && !whatsappWindow.closed) {
        whatsappWindow.location.replace(url);
      } else {
        window.location.assign(url);
      }
    } catch (error) {
      whatsappWindow?.close();
      if (formError) formError.hidden = false;
      announce(
        error?.name === "AbortError"
          ? "La conexión tardó demasiado. Inténtalo de nuevo."
          : "No pudimos registrar tu solicitud. Inténtalo de nuevo o usa el enlace directo a WhatsApp.",
      );
    } finally {
      clearTimeout(timeout);
      setSubmitting(false);
    }
  });

  form?.addEventListener("input", (event) => {
    if (event.target.name === "vehicle") clearFieldError("vehicle");
    if (event.target.id === "service") clearFieldError("service");
    if (event.target.id === "details") clearFieldError("details");
    if (["name", "email", "phone", "consent"].includes(event.target.id)) {
      clearFieldError(event.target.id);
    }
    if (formResult) formResult.hidden = true;
    if (formError) formError.hidden = true;
  });

  // ------------------------------------------------------------
  // FAQ: one open item at a time.
  // ------------------------------------------------------------
  const faqs = $$(".faq-list details");
  faqs.forEach((detail) =>
    detail.addEventListener("toggle", () => {
      if (!detail.open) return;
      faqs.forEach((other) => {
        if (other !== detail) other.open = false;
      });
    }),
  );

  // ------------------------------------------------------------
  // Reduced motion adapts live, never reloads the site.
  // ------------------------------------------------------------
  motion.addEventListener?.("change", (event) => {
    state.reduced = event.matches;
    document.documentElement.classList.toggle("reduce-motion", state.reduced);
    if (state.reduced) {
      renderHeroLine(0);
      $$("[data-tilt]").forEach((element) => {
        element.style.setProperty("--tilt-rx", "0deg");
        element.style.setProperty("--tilt-ry", "0deg");
      });
    }
    scheduleHeroRotation();
    requestScrollUpdate();
  });
  document.documentElement.classList.toggle("reduce-motion", state.reduced);
})();
