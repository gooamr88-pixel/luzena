// Builds DOM nodes without innerHTML, so text from the API can never become markup.

// Appends children to a parent, flattening arrays and dropping null, undefined and false.
// Use this instead of Element.append() whenever a child is conditional (`flag && node`):
// the native method would print "false" or "null" as text.
export function append(parent, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (typeof value === "boolean") element.toggleAttribute(key, value);
    else element.setAttribute(key, String(value));
  }
  return append(element, ...children);
}

export const clear = (element) => element.replaceChildren();
