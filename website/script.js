/* TDSF Terminal Agent — promo site behaviour
   ----------------------------------------------------------------------------
   1. Sticky nav: hairline appears after scrolling, active link follows section
   2. Mobile nav toggle
   3. Section reveal (IntersectionObserver, respects reduced motion)
   4. Demo video: poster-first, click to load (the file is large; never block LCP)
   No frameworks, no external requests.
   -------------------------------------------------------------------------- */

(function () {
  "use strict";

  var reduceMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------- nav --- */

  var nav = document.querySelector(".nav");
  var links = Array.prototype.slice.call(document.querySelectorAll(".nav-links a[href^='#']"));
  var sections = links
    .map(function (a) {
      var id = a.getAttribute("href").slice(1);
      return document.getElementById(id);
    })
    .filter(Boolean);

  function onScroll() {
    if (nav) nav.setAttribute("data-scrolled", String(window.scrollY > 8));

    var current = "";
    var mark = window.scrollY + 120;
    sections.forEach(function (section) {
      if (section.offsetTop <= mark) current = section.id;
    });
    links.forEach(function (a) {
      var active = a.getAttribute("href") === "#" + current;
      if (active) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    });
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ------------------------------------------------------ mobile nav --- */

  var toggle = document.querySelector(".nav-toggle");
  var menu = document.querySelector(".nav-links");
  if (toggle && menu) {
    toggle.addEventListener("click", function () {
      var open = menu.getAttribute("data-open") === "true";
      menu.setAttribute("data-open", String(!open));
      toggle.setAttribute("aria-expanded", String(!open));
    });
    menu.addEventListener("click", function (event) {
      if (event.target.closest("a")) {
        menu.setAttribute("data-open", "false");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------------------------------------------------------- reveal --- */

  var reveal = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
  if (!reduceMotion && "IntersectionObserver" in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    reveal.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    reveal.forEach(function (el) {
      el.classList.add("is-in");
    });
  }

  /* ------------------------------------------------------------ video --- */

  var video = document.getElementById("demo-video");
  var poster = document.getElementById("demo-poster");
  var note = document.getElementById("demo-note");

  if (video && poster) {
    poster.addEventListener("click", function () {
      poster.hidden = true;
      video.hidden = false;
      if (note) note.hidden = true;
      try {
        video.load();
      } catch (err) {
        /* the error event below restores the poster */
      }
      var played = video.play();
      if (played && typeof played.catch === "function") {
        played.catch(function () {
          /* autoplay blocked: native controls remain available */
        });
      }
    });

    video.addEventListener("error", function () {
      video.hidden = true;
      poster.hidden = false;
      if (note) note.hidden = false;
    });
  }

  /* -------------------------------------------------------------- year --- */

  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());
})();
