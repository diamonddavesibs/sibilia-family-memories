// Full-size photo viewer: tap a photo, then swipe, use the arrow keys, or tap the arrows.
(function () {
  var tiles = Array.prototype.slice.call(document.querySelectorAll(".tile"));
  var viewer = document.querySelector(".viewer");
  if (!tiles.length || !viewer) return;

  var img = viewer.querySelector("img");
  var caption = viewer.querySelector(".viewer-caption");
  var count = viewer.querySelector(".viewer-count");
  var current = 0;

  function preload(i) {
    var t = tiles[(i + tiles.length) % tiles.length];
    new Image().src = t.getAttribute("href");
  }

  function show(i) {
    current = (i + tiles.length) % tiles.length;
    var t = tiles[current];
    img.src = t.getAttribute("href");
    img.alt = t.querySelector("img").alt;
    caption.textContent = t.dataset.caption || "";
    count.textContent = (current + 1) + " of " + tiles.length;
    preload(current + 1);
    preload(current - 1);
  }

  function open(i) {
    show(i);
    viewer.hidden = false;
    document.body.classList.add("viewing");
    viewer.querySelector(".viewer-close").focus();
  }

  function close() {
    viewer.hidden = true;
    document.body.classList.remove("viewing");
    tiles[current].focus();
  }

  tiles.forEach(function (t, i) {
    t.addEventListener("click", function (e) {
      e.preventDefault();
      open(i);
    });
  });

  viewer.querySelector(".viewer-close").addEventListener("click", close);
  viewer.querySelector(".viewer-prev").addEventListener("click", function () { show(current - 1); });
  viewer.querySelector(".viewer-next").addEventListener("click", function () { show(current + 1); });
  viewer.addEventListener("click", function (e) {
    if (e.target === viewer) close();
  });

  document.addEventListener("keydown", function (e) {
    if (viewer.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") show(current - 1);
    else if (e.key === "ArrowRight") show(current + 1);
  });

  var startX = null;
  viewer.addEventListener("touchstart", function (e) {
    startX = e.touches[0].clientX;
  }, { passive: true });
  viewer.addEventListener("touchend", function (e) {
    if (startX === null) return;
    var dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 40) show(current + (dx < 0 ? 1 : -1));
    startX = null;
  });
})();
