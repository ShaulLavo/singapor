export function keyboardFallbackText(event: KeyboardEvent): string | null {
  if (event.defaultPrevented) return null;
  if (event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "Enter") return "\n";
  if (event.key.length !== 1) return null;

  return event.key;
}
