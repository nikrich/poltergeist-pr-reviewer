export function mount(el) {
  el.textContent = 'pr-reviewer placeholder';
  return () => {
    el.textContent = '';
  };
}
