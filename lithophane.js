/* =====================================================================
 * Lithophane Generator — modular add-on for the Signature Lightboxes tool
 * Three.js r128 compatible. Exposes a single global: window.Lithophane
 *
 * Pipeline:
 *   img/canvas/ImageData
 *      -> Lithophane.imageToHeightMap()   (grayscale -> per-pixel thickness)
 *      -> Lithophane.buildGeometry()      (manifold, watertight solid)
 *      -> Lithophane.validate()           (pre-print check)  -> StatusBox
 *      -> Lithophane.makeBacklightMaterial() (preview toggle)
 *      -> Lithophane.exportSTL()          (5-dp precision, single solid body)
 *
 * All physical units are millimetres. Nothing here mutates global state,
 * so it drops into an existing project as an isolated module.
 * ===================================================================== */
;(function (global) {
  "use strict";
  var THREE = global.THREE;

  var DEFAULTS = {
    minThickness: 0.5,   // brightest pixels -> thinnest wall (most light through)
    maxThickness: 3.5,   // darkest pixels  -> thickest wall (blocks light)
    widthMm: 100,        // physical width of the panel; height follows aspect ratio
    maxSamples: 300,     // cap the long edge of the sampling grid (keeps tri count sane)
    gamma: 1.0,          // >1 boosts contrast of the height map
    invert: false        // flip which tones are thick/thin
  };

  /* ------------------------------------------------------------------ *
   * 1a. Image  ->  grayscale height (thickness) map
   * ------------------------------------------------------------------ */
  function imageToHeightMap(source, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});

    var srcW, srcH, drawFn;
    if (global.ImageData && source instanceof global.ImageData) {
      srcW = source.width; srcH = source.height;
      var tmp = document.createElement("canvas");
      tmp.width = srcW; tmp.height = srcH;
      tmp.getContext("2d").putImageData(source, 0, 0);
      drawFn = function (ctx, w, h) { ctx.drawImage(tmp, 0, 0, w, h); };
    } else {
      srcW = source.naturalWidth || source.width;
      srcH = source.naturalHeight || source.height;
      drawFn = function (ctx, w, h) { ctx.drawImage(source, 0, 0, w, h); };
    }

    // Downsample so the long edge <= maxSamples (each sample becomes a vertex).
    var scale = Math.min(1, opts.maxSamples / Math.max(srcW, srcH));
    var cols = Math.max(2, Math.round(srcW * scale));
    var rows = Math.max(2, Math.round(srcH * scale));

    var canvas = document.createElement("canvas");
    canvas.width = cols; canvas.height = rows;
    var ctx = canvas.getContext("2d");
    drawFn(ctx, cols, rows);
    var px = ctx.getImageData(0, 0, cols, rows).data;

    var thickness = new Float32Array(cols * rows);
    var range = opts.maxThickness - opts.minThickness;
    for (var k = 0; k < cols * rows; k++) {
      var r = px[k * 4], g = px[k * 4 + 1], b = px[k * 4 + 2];
      var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255; // perceptual brightness 0..1
      if (opts.invert) lum = 1 - lum;
      if (opts.gamma !== 1) lum = Math.pow(lum, opts.gamma);
      // bright pixel -> thin wall (minThickness); dark pixel -> thick wall (maxThickness)
      thickness[k] = opts.maxThickness - lum * range;
    }

    return {
      cols: cols, rows: rows, thickness: thickness,
      minThickness: opts.minThickness, maxThickness: opts.maxThickness
    };
  }

  /* ------------------------------------------------------------------ *
   * 1b. Height map -> single manifold, watertight solid
   *
   * The solid fills the volume between a FLAT back (z = 0) and a RELIEF
   * front (z = thickness). Front grid + back grid + perimeter walls are
   * stitched with shared, consistently-wound vertices so every edge is
   * used by exactly two triangles (watertight) with one orientation.
   * ------------------------------------------------------------------ */
  function buildGeometry(hmap, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var cols = hmap.cols, rows = hmap.rows, T = hmap.thickness;
    var widthMm = opts.widthMm;
    var heightMm = widthMm * (rows / cols);
    var N = cols * rows;

    var pos = new Float32Array(N * 2 * 3); // [ front verts (N) | back verts (N) ]
    var th  = new Float32Array(N * 2);     // per-vertex thickness (for the preview shader)

    var X = function (i) { return (i / (cols - 1) - 0.5) * widthMm; };
    var Y = function (j) { return (0.5 - j / (rows - 1)) * heightMm; };

    for (var j = 0; j < rows; j++) {
      for (var i = 0; i < cols; i++) {
        var idx = j * cols + i, t = T[idx], x = X(i), y = Y(j);
        pos[idx * 3] = x; pos[idx * 3 + 1] = y; pos[idx * 3 + 2] = t; // front (relief)
        th[idx] = t;
        var bidx = N + idx;
        pos[bidx * 3] = x; pos[bidx * 3 + 1] = y; pos[bidx * 3 + 2] = 0; // back (flat)
        th[bidx] = t;
      }
    }

    var indices = [];
    var f  = function (i, j) { return j * cols + i; };
    var bk = function (i, j) { return N + j * cols + i; };

    // Front surface — outward normal +z
    for (var j2 = 0; j2 < rows - 1; j2++) {
      for (var i2 = 0; i2 < cols - 1; i2++) {
        var a = f(i2, j2), b = f(i2 + 1, j2), c = f(i2 + 1, j2 + 1), d = f(i2, j2 + 1);
        indices.push(a, c, b,  a, d, c);
      }
    }
    // Back surface — outward normal -z
    for (var j3 = 0; j3 < rows - 1; j3++) {
      for (var i3 = 0; i3 < cols - 1; i3++) {
        var A = bk(i3, j3), B = bk(i3 + 1, j3), C = bk(i3 + 1, j3 + 1), D = bk(i3, j3 + 1);
        indices.push(A, B, C,  A, C, D);
      }
    }
    // Perimeter walls — traverse the boundary counter-clockwise (seen from +z)
    // so wall(p,q) always produces an outward-facing quad.
    var wall = function (p, q) {
      var pp = p + N, qq = q + N;
      indices.push(p, q, qq,  p, qq, pp);
    };
    for (var i4 = 0; i4 < cols - 1; i4++) wall(f(i4, 0), f(i4 + 1, 0));            // top  (left->right)
    for (var j4 = 0; j4 < rows - 1; j4++) wall(f(cols - 1, j4), f(cols - 1, j4 + 1)); // right (top->bottom)
    for (var i5 = 0; i5 < cols - 1; i5++) wall(f(i5 + 1, rows - 1), f(i5, rows - 1)); // bottom(right->left)
    for (var j5 = 0; j5 < rows - 1; j5++) wall(f(0, j5 + 1), f(0, j5));            // left  (bottom->top)

    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aThickness", new THREE.BufferAttribute(th, 1));
    geo.setIndex(indices);

    if (signedVolume(geo) < 0) flipWinding(geo); // guarantee outward normals
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    geo.userData.isSolid = true; // Slicer-optimisation flag (see enforceSolid / exportSTL)
    geo.userData.lithophane = {
      minThickness: opts.minThickness, maxThickness: opts.maxThickness,
      widthMm: widthMm, heightMm: heightMm, cols: cols, rows: rows
    };
    return geo;
  }

  /* ------------------------------------------------------------------ *
   * 2. Pre-print validator
   * ------------------------------------------------------------------ */
  function validate(input, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    // Accept either a height map ({thickness}) or a built geometry (aThickness attr).
    var arr = input && input.thickness ? input.thickness
            : (input && input.attributes && input.attributes.aThickness ? input.attributes.aThickness.array : null);
    if (!arr || !arr.length) {
      return { ok: false, level: "error", message: "No design to check.", min: 0, max: 0, contrast: 0 };
    }

    var min = Infinity, max = -Infinity;
    for (var k = 0; k < arr.length; k++) { var v = arr[k]; if (v < min) min = v; if (v > max) max = v; }
    var span = max - min;
    var full = opts.maxThickness - opts.minThickness;
    var eps = 1e-3;

    // Primary check: every wall thickness must sit inside the printable band.
    if (min < opts.minThickness - eps || max > opts.maxThickness + eps) {
      return {
        ok: false, level: "error",
        message: "Image contrast is outside printable range. Please adjust.",
        min: min, max: max, contrast: span
      };
    }

    // Secondary check (watertight solid) when a geometry was supplied.
    if (input.attributes) {
      var m = checkManifold(input);
      if (!m.watertight || m.orientationErrors > 0 || m.signedVolume <= 0) {
        return {
          ok: false, level: "error",
          message: "Mesh is not a solid, watertight body. Cannot export.",
          min: min, max: max, contrast: span, manifold: m
        };
      }
    }

    // Helpful (non-blocking) low-contrast nudge.
    if (span < 0.35 * full) {
      return {
        ok: true, level: "warn",
        message: "Low contrast — lithophane may look faint. Try a bolder image.",
        min: min, max: max, contrast: span
      };
    }

    return { ok: true, level: "verified", message: "Design Verified", min: min, max: max, contrast: span };
  }

  /* ------------------------------------------------------------------ *
   * 2b. Status box UI ('Design Verified' / 'Design Error')
   * ------------------------------------------------------------------ */
  var _styleInjected = false;
  function injectStatusStyle() {
    if (_styleInjected) return; _styleInjected = true;
    var css =
      ".litho-status{display:inline-flex;align-items:center;gap:9px;padding:9px 14px;border-radius:11px;" +
      "font:600 12.5px/1.2 system-ui,-apple-system,'Segoe UI',sans-serif;border:1px solid rgba(0,0,0,.12);" +
      "background:rgba(0,0,0,.03);color:#333;transition:background .15s,border-color .15s,color .15s}" +
      ".litho-status .litho-dot{width:9px;height:9px;border-radius:50%;background:#9aa0aa;flex:none;box-shadow:0 0 0 0 rgba(0,0,0,0)}" +
      ".litho-status[data-state=verified]{background:rgba(46,168,79,.12);border-color:rgba(46,168,79,.4);color:#1e7d38}" +
      ".litho-status[data-state=verified] .litho-dot{background:#2fa84f;box-shadow:0 0 8px rgba(46,168,79,.7)}" +
      ".litho-status[data-state=warn]{background:rgba(224,168,0,.12);border-color:rgba(224,168,0,.4);color:#8a6a00}" +
      ".litho-status[data-state=warn] .litho-dot{background:#e0a800}" +
      ".litho-status[data-state=error]{background:rgba(224,74,74,.12);border-color:rgba(224,74,74,.45);color:#b23838}" +
      ".litho-status[data-state=error] .litho-dot{background:#e04a4a;box-shadow:0 0 8px rgba(224,74,74,.7)}";
    var s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
  }

  function createStatusBox(parent) {
    injectStatusStyle();
    var el = document.createElement("div");
    el.className = "litho-status";
    el.innerHTML = '<span class="litho-dot"></span><span class="litho-msg"></span>';
    (parent || document.body).appendChild(el);
    var msg = el.querySelector(".litho-msg");
    function set(state, text) { el.setAttribute("data-state", state); msg.textContent = text; }
    set("idle", "Not checked");
    return {
      el: el,
      set: set,
      // Feed a validate() result straight in.
      fromResult: function (r) {
        set(r.level === "verified" ? "verified" : (r.level === "warn" ? "warn" : "error"),
            r.message || (r.ok ? "Design Verified" : "Design Error"));
        return r;
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * 3. Backlight preview material
   *    Renders the mesh as transmitted light: thin walls glow, thick
   *    walls go dark — the lithophane effect, before you print.
   *    Swap the mesh's material to this when the toggle is ON.
   * ------------------------------------------------------------------ */
  function makeBacklightMaterial(opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    return new THREE.ShaderMaterial({
      uniforms: {
        uMin: { value: opts.minThickness },
        uMax: { value: opts.maxThickness },
        uColor: { value: new THREE.Color(opts.color != null ? opts.color : 0xfff2df) },
        uGamma: { value: opts.previewGamma != null ? opts.previewGamma : 1.35 }
      },
      vertexShader: [
        "attribute float aThickness;",
        "varying float vT;",
        "void main(){ vT = aThickness; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }"
      ].join("\n"),
      fragmentShader: [
        "uniform float uMin; uniform float uMax; uniform vec3 uColor; uniform float uGamma;",
        "varying float vT;",
        "void main(){",
        "  float n = clamp((vT - uMin) / max(0.0001, (uMax - uMin)), 0.0, 1.0);", // 0=thin .. 1=thick
        "  float b = pow(1.0 - n, uGamma);",                                       // thin -> bright, thick -> dark
        "  gl_FragColor = vec4(uColor * b, 1.0);",
        "}"
      ].join("\n"),
      side: THREE.DoubleSide
    });
  }

  /* ------------------------------------------------------------------ *
   * 4. Slicer optimisation — solid-body enforcement + precise STL
   * ------------------------------------------------------------------ */
  function enforceSolid(geometry) {
    // A single closed manifold with outward normals and no internal faces is
    // what makes a slicer treat the file as one solid block (no stray internal
    // shells that would otherwise be honeycombed as separate cavities).
    if (geometry.index && signedVolume(geometry) < 0) flipWinding(geometry);
    geometry.computeVertexNormals();
    geometry.userData.isSolid = true;
    return geometry;
  }

  function exportSTL(geometry, opts) {
    opts = Object.assign({ precision: 5, solid: true, name: "lithophane" }, opts || {});
    if (opts.solid) enforceSolid(geometry);

    var p = geometry.attributes.position.array;
    var idx = geometry.index ? geometry.index.array : null;
    var P = opts.precision;
    var n = function (v) { return (+v).toFixed(P); };

    var triCount = idx ? idx.length / 3 : p.length / 9;
    var out = ["solid " + opts.name];
    for (var t = 0; t < triCount; t++) {
      var i0, i1, i2;
      if (idx) { i0 = idx[t * 3] * 3; i1 = idx[t * 3 + 1] * 3; i2 = idx[t * 3 + 2] * 3; }
      else { i0 = t * 9; i1 = t * 9 + 3; i2 = t * 9 + 6; }
      var ax = p[i0], ay = p[i0 + 1], az = p[i0 + 2];
      var bx = p[i1], by = p[i1 + 1], bz = p[i1 + 2];
      var cx = p[i2], cy = p[i2 + 1], cz = p[i2 + 2];
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
      out.push(" facet normal " + n(nx) + " " + n(ny) + " " + n(nz));
      out.push("  outer loop");
      out.push("   vertex " + n(ax) + " " + n(ay) + " " + n(az));
      out.push("   vertex " + n(bx) + " " + n(by) + " " + n(bz));
      out.push("   vertex " + n(cx) + " " + n(cy) + " " + n(cz));
      out.push("  endloop");
      out.push(" endfacet");
    }
    out.push("endsolid " + opts.name);
    return new Blob([out.join("\n")], { type: "model/stl" });
  }

  /* ------------------------------------------------------------------ *
   * Geometry helpers
   * ------------------------------------------------------------------ */
  function signedVolume(geo) {
    var p = geo.attributes.position.array, idx = geo.index.array, vol = 0;
    for (var t = 0; t < idx.length; t += 3) {
      var a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      var ax = p[a], ay = p[a + 1], az = p[a + 2];
      var bx = p[b], by = p[b + 1], bz = p[b + 2];
      var cx = p[c], cy = p[c + 1], cz = p[c + 2];
      vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    return vol;
  }

  function flipWinding(geo) {
    var idx = geo.index.array;
    for (var t = 0; t < idx.length; t += 3) { var tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
    geo.index.needsUpdate = true;
  }

  // Watertight (every undirected edge shared by exactly 2 triangles) AND
  // consistently oriented (every directed edge used exactly once).
  function checkManifold(geo) {
    var idx = geo.index.array, dir = {}, und = {};
    for (var t = 0; t < idx.length; t += 3) {
      var tri = [idx[t], idx[t + 1], idx[t + 2]];
      for (var e = 0; e < 3; e++) {
        var a = tri[e], b = tri[(e + 1) % 3];
        var dk = a + "_" + b; dir[dk] = (dir[dk] || 0) + 1;
        var uk = a < b ? a + "_" + b : b + "_" + a; und[uk] = (und[uk] || 0) + 1;
      }
    }
    var open = 0, nonManifold = 0, badDir = 0, u, d;
    for (u in und) { if (und[u] < 2) open++; else if (und[u] > 2) nonManifold++; }
    for (d in dir) { if (dir[d] !== 1) badDir++; }
    return {
      watertight: open === 0 && nonManifold === 0,
      openEdges: open, nonManifoldEdges: nonManifold,
      orientationErrors: badDir, signedVolume: signedVolume(geo)
    };
  }

  global.Lithophane = {
    DEFAULTS: DEFAULTS,
    imageToHeightMap: imageToHeightMap,
    buildGeometry: buildGeometry,
    validate: validate,
    createStatusBox: createStatusBox,
    makeBacklightMaterial: makeBacklightMaterial,
    enforceSolid: enforceSolid,
    exportSTL: exportSTL,
    checkManifold: checkManifold
  };
})(typeof window !== "undefined" ? window : this);
