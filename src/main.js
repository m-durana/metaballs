import { mountField } from './metaballs.js';

const cards = [
  {
    el: document.querySelector('.item.passport'),
    palette: ['#b1322a', '#5a1320', '#d97757', '#7a1f3d', '#c54a35'],
  },
  {
    el: document.querySelector('.item.food'),
    // Cream / vanilla — warm off-whites and soft amber so the cloud
    // reads like fresh-churned vanilla against the dark field.
    palette: ['#e8d4a0', '#c4a86a', '#f0e2b8', '#a88846', '#dcc488'],
  },
  {
    el: document.querySelector('.item.tree'),
    // Forest — mossy greens with a touch of pine. Sits cleanly between
    // the oxblood passport and cream food without muddying overlaps.
    palette: ['#3e7a4a', '#1f3a25', '#6ba56b', '#284a32', '#9bc28d'],
  },
];

const fieldCanvas = document.getElementById('field');
fieldCanvas.addEventListener('field:ready', () => {
  // Small extra beat so a few frames of blob motion land before the
  // foreground fades in — the chips appearing onto already-living
  // color reads better than appearing onto a static first frame.
  setTimeout(() => document.body.classList.add('ready'), 250);
}, { once: true });
const field = mountField(fieldCanvas, cards);
const hoverQuery = window.matchMedia?.('(hover: hover) and (pointer: fine)');
const canUseCardHover = () => hoverQuery ? hoverQuery.matches : true;

hoverQuery?.addEventListener('change', (event) => {
  if (event.matches) return;
  cards.forEach((card, idx) => {
    card.el.removeAttribute('data-shimmer');
    field.setHover(idx, false);
  });
});

cards.forEach((card, idx) => {
  let unhoverTimer = null;
  let pendingShimmerStop = false;
  const h2 = card.el.querySelector('h2');
  if (h2) {
    h2.addEventListener('animationiteration', () => {
      if (pendingShimmerStop) {
        card.el.removeAttribute('data-shimmer');
        pendingShimmerStop = false;
      }
    });
  }

  card.el.addEventListener('mouseenter', () => {
    if (!canUseCardHover()) return;
    if (unhoverTimer) { clearTimeout(unhoverTimer); unhoverTimer = null; }
    pendingShimmerStop = false;
    card.el.setAttribute('data-shimmer', 'run');
    field.setHover(idx, true);
  });

  card.el.addEventListener('mouseleave', () => {
    if (!canUseCardHover()) return;
    pendingShimmerStop = true;
    unhoverTimer = setTimeout(() => {
      field.setHover(idx, false);
      unhoverTimer = null;
    }, 300);
  });
});
