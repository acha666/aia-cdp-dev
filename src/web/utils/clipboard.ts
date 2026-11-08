/** @throws Error if the browser refuses both clipboard methods. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // The Clipboard API needs a secure context; fall back to execCommand.
  }
  if (!legacyCopy(text)) {
    throw new Error("The browser refused to copy to the clipboard.");
  }
}

function legacyCopy(text: string): boolean {
  const active = document.activeElement;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.append(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (active instanceof HTMLElement) {
      active.focus({ preventScroll: true });
    }
  }
}
