// Minimal DOM helpers for the screen-flow overlays.

// Create an element with class names, props, and children in one call.
export function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  if (opts.on) for (const [evt, fn] of Object.entries(opts.on)) node.addEventListener(evt, fn);
  if (opts.style) Object.assign(node.style, opts.style);
  for (const c of children) node.appendChild(c);
  return node;
}

// 0xRRGGBB integer -> "#rrggbb" CSS color.
export function hexToCss(int) {
  return "#" + int.toString(16).padStart(6, "0");
}
