/** Keep focus and click targets stable when only unrelated sections change. */
export function swap(container: HTMLElement, nodes: HTMLElement[]) {
  const html = nodes.map((n) => n.outerHTML).join("");
  if (container.innerHTML !== html) container.replaceChildren(...nodes);
}
