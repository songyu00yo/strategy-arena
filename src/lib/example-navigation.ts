/** Opening the free example picker must not restore a previously running paid task. */
export function examplePickerRequested() {
  return (
    typeof window !== "undefined" &&
    new URL(window.location.href).searchParams.get("examples") === "open"
  );
}

export function clearExamplePickerRequest() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("examples")) return;
  url.searchParams.delete("examples");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function clearExplicitArenaRequest() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("arena")) return;
  url.searchParams.delete("arena");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
