/** Small DOM helpers that never parse HTML. Markup comes from createElement; data only ever enters as text. */
export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag)
  if (options.className) node.className = options.className
  if (options.text !== undefined) node.textContent = String(options.text)
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value !== undefined && value !== null) node.setAttribute(name, String(value))
    }
  }
  if (options.dataset) Object.assign(node.dataset, options.dataset)
  for (const child of children.flat()) {
    if (child === undefined || child === null) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

export function replace(node, ...children) {
  node.replaceChildren(...children.flat().filter((child) => child !== undefined && child !== null))
}

export function emptyState(text) {
  return el('div', { className: 'empty-state', text })
}
