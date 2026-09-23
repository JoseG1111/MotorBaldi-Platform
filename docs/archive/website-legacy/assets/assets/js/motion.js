(() => {
  "use strict";

  const body = document.body;
  if (!body || !body.classList.contains("motorbaldi")) return;

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const clamp = (v, min = 0, max = 1) => Math.min(max, Math.max(min, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const root = document.documentElement;
  const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const desktopQuery = matchMedia(
    "(min-width: 1180px) and (min-height: 800px)",
  );
  const finePointer = matchMedia("(hover:hover) and (pointer:fine)");

  let reduced = motionQuery.matches;
  let raf = 0;
  let lastY = scrollY;
  let lastTime = performance.now();
  let velocity = 0;
  let serviceManualProgress = null;

  const sections = $$("main > section:not(.pioneer-transition)");
  const hero = $("#inicio");
  const universe = $("#universo");
  const services = $("#servicios");
  const mobility = $("#nosotros");
  const platform = $("#plataforma");
  const transition = $("#pioneer-transition");
  const pioneers = $("#pioneros");
  const process = $("#como-funciona");
  const contact = $("#contacto");
  const serviceTabs = $$(".service-tab");
  const processSteps = $$(".process-track li");
  const chapterDots = $$("[data-chapter-dot]");
  const chapterLine = $(".chapter-rail-line i");
  const transitionCounter = $(".transition-counter b");

  const localProgress = (el, start = 0.82, end = 0.18) => {
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const enterAt = innerHeight * start;
    const exitAt = -rect.height * end;
    return clamp((enterAt - rect.top) / Math.max(1, enterAt - exitAt));
  };

  const pinnedProgress = (el) => {
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const travel = Math.max(1, rect.height - innerHeight);
    return clamp(-rect.top / travel);
  };

  const setVar = (el, name, value) => el?.style.setProperty(name, value);

  // One reveal observer owns entrance motion; offscreen content waits for scroll.
  const revealGroups = [
    [".manifesto .section-meta,.manifesto-grid h2,.manifesto-copy", ""],
    [".universe-card", "v12-scale"],
    [
      ".services-space .section-meta,.services-heading h2,.services-heading>p",
      "",
    ],
    [".service-tab", "v12-from-left"],
    [".service-scene", "v12-from-right v12-scale"],
    [".mobility .section-meta,.mobility-intro h2,.vehicle-switch", ""],
    [".vehicle-photo-real", "v12-from-left v12-scale"],
    [".vehicle-panel", "v12-from-right"],
    [".platform-copy", "v12-from-left"],
    [".digital-twin", "v12-from-right v12-scale"],
    [".pioneers .section-meta,.pioneer-copy", "v12-from-left"],
    [".pass-scene", "v12-from-right v12-scale"],
    [".process .section-meta,.process-head", ""],
    [".process-track li", ""],
    [".faq-intro", "v12-from-left"],
    [".faq-list details", "v12-from-right"],
    [".contact-copy", "v12-from-left"],
    [".quote-form", "v12-from-right v12-scale"],
  ];
  const revealItems = [];
  revealGroups.forEach(([selector, extra]) => {
    $$(selector).forEach((el, i) => {
      el.classList.add("v12-reveal");
      extra
        .split(" ")
        .filter(Boolean)
        .forEach((c) => el.classList.add(c));
      el.style.setProperty("--v12-delay", `${Math.min(i % 5, 4) * 78}ms`);
      revealItems.push(el);
    });
  });

  let revealObserver = null;
  const setupReveals = () => {
    revealObserver?.disconnect();
    if (reduced || !("IntersectionObserver" in window)) {
      revealItems.forEach((el) => el.classList.add("is-v12-visible"));
      return;
    }
    revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-v12-visible");
          revealObserver.unobserve(entry.target);
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -7% 0px" },
    );
    revealItems.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < innerHeight * 0.96) el.classList.add("is-v12-visible");
      else revealObserver.observe(el);
    });
  };

  // Only enable the heavy choreography after every DOM query above is safe.
  root.classList.add("motion-v12-ready");
  root.classList.toggle("reduce-motion", reduced);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => body.classList.add("motion-v12-loaded")),
  );
  setupReveals();

  // Manual selection lasts until the visitor deliberately moves to another scroll step.
  serviceTabs.forEach((tab) => {
    const hold = () => {
      serviceManualProgress = pinnedProgress(services);
    };
    tab.addEventListener("pointerdown", hold);
    tab.addEventListener("keydown", hold);
  });

  const updateServiceSequence = (progress) => {
    if (!serviceTabs.length || !desktopQuery.matches || reduced) return;
    const rect = services.getBoundingClientRect();
    if (rect.top > 1 || rect.bottom < innerHeight - 1) return;
    if ($(".scene-card-main")?.contains(document.activeElement)) return;
    if (serviceManualProgress !== null) {
      if (Math.abs(progress - serviceManualProgress) < 0.08) return;
      serviceManualProgress = null;
    }
    const index = Math.min(
      serviceTabs.length - 1,
      Math.floor(progress * serviceTabs.length),
    );
    const target = serviceTabs[index];
    if (target && !target.classList.contains("is-active")) target.click();
  };

  // Keyboard navigation must reveal a control and its containing card immediately.
  document.addEventListener("focusin", (event) => {
    let element = event.target;
    while (element && element !== body) {
      if (element.classList.contains("v12-reveal"))
        element.classList.add("is-v12-visible");
      element = element.parentElement;
    }
    body.classList.remove("header-hidden");
  });

  const updateChapterRail = () => {
    const marker = innerHeight * 0.42;
    let active = null;
    chapterDots.forEach((dot) => {
      const id = dot.dataset.chapterDot;
      const section = document.getElementById(id);
      if (!section) return;
      const rect = section.getBoundingClientRect();
      if (rect.top <= marker && rect.bottom > marker) active = id;
    });
    chapterDots.forEach((dot) =>
      dot.classList.toggle("is-active", dot.dataset.chapterDot === active),
    );
    if (chapterLine) {
      const max = Math.max(
        1,
        document.documentElement.scrollHeight - innerHeight,
      );
      root.style.setProperty(
        "--chapter-progress",
        clamp(scrollY / max).toFixed(4),
      );
    }
  };

  const updateHeader = (y, now) => {
    const dy = y - lastY;
    const dt = Math.max(16, now - lastTime);
    velocity += ((dy / dt) * 16 - velocity) * 0.18;
    const abs = Math.abs(velocity);
    if (
      !reduced &&
      !body.classList.contains("menu-open") &&
      !$(".site-header")?.contains(document.activeElement)
    ) {
      if (dy > 3 && y > 190 && abs > 1.8) body.classList.add("header-hidden");
      if (dy < -2 || y < 100) body.classList.remove("header-hidden");
    }
    root.style.setProperty(
      "--v12-scroll-velocity",
      clamp(velocity / 36, -1, 1).toFixed(3),
    );
    lastY = y;
    lastTime = now;
  };

  const update = (now = performance.now()) => {
    raf = 0;
    const y = scrollY;
    updateHeader(y, now);
    updateChapterRail();

    // Common section variables: enter, local travel, exit.
    sections.forEach((section) => {
      const rect = section.getBoundingClientRect();
      const enter = clamp(
        (innerHeight - rect.top) / Math.max(1, innerHeight * 0.72),
      );
      const exit = clamp(-rect.top / Math.max(1, rect.height * 0.82));
      const local = localProgress(section);
      setVar(section, "--v12-enter", enter.toFixed(4));
      setVar(section, "--v12-exit", exit.toFixed(4));
      setVar(section, "--v12-local", local.toFixed(4));
    });

    // Hero exits like a full-screen campaign frame.
    if (hero && !reduced) {
      const rect = hero.getBoundingClientRect();
      const p = clamp(-rect.top / Math.max(1, rect.height * 0.82));
      setVar(hero, "--v12-hero", p.toFixed(4));
    }

    if (universe && !reduced) {
      const p = localProgress(universe, 0.88, 0.06);
      setVar(universe, "--v12-universe", p.toFixed(4));
    }

    if (services) {
      const p =
        desktopQuery.matches && !reduced
          ? pinnedProgress(services)
          : localProgress(services, 0.9, 0.08);
      const scaled = clamp(p * serviceTabs.length, 0, serviceTabs.length);
      const local = scaled - Math.floor(scaled);
      setVar(services, "--v12-services", p.toFixed(4));
      setVar(services, "--v12-service-local", local.toFixed(4));
      updateServiceSequence(p);
    }

    if (mobility && !reduced) {
      setVar(
        mobility,
        "--v12-mobility",
        localProgress(mobility, 0.9, 0.06).toFixed(4),
      );
    }

    if (platform) {
      const p =
        desktopQuery.matches && !reduced
          ? pinnedProgress(platform)
          : localProgress(platform, 0.92, 0.05);
      setVar(platform, "--v12-platform", p.toFixed(4));
    }

    if (transition) {
      const transitionRect = transition.getBoundingClientRect();
      // Start the wipe as this chapter enters, before it fills the viewport.
      const lead = innerHeight * 0.55;
      const p =
        reduced || !desktopQuery.matches
          ? 1
          : clamp(
              (lead - transitionRect.top) /
                Math.max(1, transitionRect.height - innerHeight + lead),
            );
      const reveal = smooth(clamp(p / 0.5));
      const copyIn = smooth(clamp((p - 0.23) / 0.33));
      const copyOut = smooth(clamp((p - 0.82) / 0.18));
      const copyOpacity = clamp(copyIn * (1 - copyOut * 0.35));
      const redY = mix(108, -3, reveal);
      const skew = mix(3.1, 0, reveal) + clamp(velocity / 80, -1, 1) * 0.45;
      const copyY = mix(62, -8, copyIn) - copyOut * 22;
      const marqueeX = mix(14, -24, p);
      setVar(transition, "--v12-red-y", `${redY.toFixed(2)}%`);
      setVar(transition, "--v12-red-skew", `${skew.toFixed(2)}deg`);
      setVar(transition, "--v12-red-copy-opacity", copyOpacity.toFixed(3));
      setVar(transition, "--v12-red-copy-y", `${copyY.toFixed(2)}px`);
      setVar(transition, "--v12-marquee-x", `${marqueeX.toFixed(2)}%`);
      setVar(transition, "--v12-red-grid", (0.07 + copyIn * 0.12).toFixed(3));
      if (transitionCounter)
        transitionCounter.textContent = String(Math.round(p * 100)).padStart(
          2,
          "0",
        );

      const tr = transition.getBoundingClientRect();
      const pr = pioneers?.getBoundingClientRect();
      const redActive =
        (tr.top < innerHeight * 0.55 && tr.bottom > 0) ||
        (pr && pr.top < innerHeight && pr.bottom > 0);
      body.classList.toggle("red-chapter", redActive);
    }

    if (pioneers && !reduced) {
      setVar(
        pioneers,
        "--v12-pioneers",
        localProgress(pioneers, 0.92, 0.04).toFixed(4),
      );
    }

    if (process) {
      const rect = $(".process-track")?.getBoundingClientRect();
      const p = rect
        ? clamp((innerHeight * 0.7 - rect.top) / Math.max(1, rect.height))
        : 0;
      setVar(process, "--v12-process", p.toFixed(4));
      processSteps.forEach((step) => {
        const r = step.getBoundingClientRect();
        step.classList.toggle(
          "step-active",
          r.top < innerHeight * 0.68 && r.bottom > innerHeight * 0.28,
        );
      });
    }

    if (contact && !reduced) {
      setVar(
        contact,
        "--v12-local",
        localProgress(contact, 0.92, 0.06).toFixed(4),
      );
    }
  };

  const requestUpdate = () => {
    if (raf) return;
    raf = requestAnimationFrame(update);
  };

  addEventListener("scroll", requestUpdate, { passive: true });
  addEventListener("resize", requestUpdate, { passive: true });
  document.fonts?.ready.then(requestUpdate);

  // Fine-pointer depth and magnetic buttons. The movement is intentionally bounded.
  if (finePointer.matches) {
    addEventListener(
      "pointermove",
      (event) => {
        if (reduced) return;
        const px = (event.clientX / innerWidth - 0.5) * 2;
        const py = (event.clientY / innerHeight - 0.5) * 2;
        root.style.setProperty("--v12-pointer-x", `${(px * 18).toFixed(2)}px`);
        root.style.setProperty("--v12-pointer-y", `${(py * 14).toFixed(2)}px`);
      },
      { passive: true },
    );

    $$(".button,.nav-cta").forEach((el) => {
      el.addEventListener("pointermove", (event) => {
        if (reduced) return;
        const r = el.getBoundingClientRect();
        const x = (event.clientX - r.left - r.width / 2) * 0.07;
        const y = (event.clientY - r.top - r.height / 2) * 0.09;
        el.style.setProperty("--v12-mag-x", `${x.toFixed(2)}px`);
        el.style.setProperty("--v12-mag-y", `${y.toFixed(2)}px`);
      });
      el.addEventListener("pointerleave", () => {
        el.style.removeProperty("--v12-mag-x");
        el.style.removeProperty("--v12-mag-y");
      });
    });
  }

  const handleMotionChange = (event) => {
    reduced = event.matches;
    root.classList.toggle("reduce-motion", reduced);
    body.classList.remove("header-hidden");
    setupReveals();
    requestUpdate();
  };
  motionQuery.addEventListener?.("change", handleMotionChange);
  desktopQuery.addEventListener?.("change", requestUpdate);

  requestUpdate();
})();
