// TDSF Terminal Agent — Promotional Page Interactions

(function () {
  'use strict';

  // Typing effect for hero terminal commands
  const typeElements = document.querySelectorAll('.typed');
  const TYPING_SPEED = 70;
  const DELAY_BETWEEN = 900;

  async function typeText(el) {
    const text = el.dataset.text;
    if (!text) return;
    el.textContent = '';
    const cursor = el.nextElementSibling;
    if (cursor) cursor.style.display = 'inline-block';

    for (let i = 0; i < text.length; i++) {
      el.textContent += text[i];
      await wait(TYPING_SPEED + Math.random() * 40);
    }

    if (cursor) cursor.style.display = 'none';
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function runTypingSequence() {
    for (const el of typeElements) {
      await typeText(el);
      await wait(DELAY_BETWEEN);
    }
  }

  // Scroll reveal
  function initReveal() {
    const reveals = document.querySelectorAll('.reveal');
    if (!reveals.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );

    reveals.forEach((el) => observer.observe(el));
  }

  // Stagger reveals inside grids for a more polished entrance
  function initStagger() {
    const lists = document.querySelectorAll('.feature-list, .arch-grid, .gallery-grid, .stack-grid');
    lists.forEach((list) => {
      const items = list.querySelectorAll('.reveal');
      items.forEach((item, index) => {
        item.style.transitionDelay = `${index * 80}ms`;
      });
    });
  }

  // Initialize
  document.addEventListener('DOMContentLoaded', () => {
    runTypingSequence();
    initReveal();
    initStagger();
  });
})();
