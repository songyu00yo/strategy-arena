/** Per-tab navigation target, with a legacy shared fallback and matching-ID cleanup. */
export function tabOwnedPointer(sharedKey: string, tabKey: string) {
  const read = (): string | null => {
    try {
      const tab = sessionStorage.getItem(tabKey);
      if (tab !== null) return tab || null;
    } catch {}
    try {
      return localStorage.getItem(sharedKey);
    } catch {
      return null;
    }
  };
  const save = (id: string, created = false) => {
    try {
      sessionStorage.setItem(tabKey, id);
    } catch {}
    try {
      const shared = localStorage.getItem(sharedKey);
      if (created || shared === null || shared === id) localStorage.setItem(sharedKey, id);
    } catch {}
  };
  const clear = (expectedId: string | null) => {
    try {
      const tab = sessionStorage.getItem(tabKey);
      if (expectedId === null || tab === expectedId || (tab === null && read() === expectedId))
        // An empty target means this tab intentionally started over; do not fall back to another tab.
        sessionStorage.setItem(tabKey, "");
    } catch {}
    try {
      if (expectedId !== null && localStorage.getItem(sharedKey) === expectedId)
        localStorage.removeItem(sharedKey);
    } catch {}
  };
  return { read, save, clear };
}
